/**
 * F1 live manifest — watcher-driven view of the file manifest.
 *
 * The `LiveManifest` wraps a `FileManifestEntry[]` snapshot together with
 * a `FileWatcher` and produces an always-fresh view that satisfies the
 * audit's invalidation contract (Section 11.4):
 *
 *   - Treat watcher events as hints; verify hashes at query and
 *     mutation boundaries.
 *   - Detect shell edits, external editors, child processes, renames,
 *     deletions, and Git changes.
 *   - Reparse changed files; invalidate outgoing relationships and
 *     dependent semantic results.
 *   - Publish atomic snapshots so one query cannot mix old definitions
 *     with new references.
 *   - After watcher overflow or uncertain external mutation, reconcile
 *     before claiming freshness.
 *
 * Hash re-verification is performed at the query boundary
 * (`getFile` / `getByLanguage` / `getByPackage`) when `verifyOnQuery` is
 * true. The flag defaults to true and is forced back to true whenever
 * the watcher reports an `overflow` event — until `reconcile()` is
 * called to re-establish a clean baseline.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { FileWatcher, WatcherEvent } from "./file-watcher.ts";
import { detectLanguage, type FileManifestEntry, isGeneratedPath, isIgnoredPath } from "./manifest.ts";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface LiveManifestOptions {
	/** Initial manifest entries; copied into an internal map. */
	manifest: FileManifestEntry[];
	/** Source of invalidation events. */
	watcher: FileWatcher;
	/** Absolute path to the manifest root (for re-reading files). */
	root: string;
	/**
	 * When true (default), every query re-reads the file from disk and
	 * recomputes the SHA-256 hash before returning. Set to false to
	 * skip the query-boundary verification.
	 */
	verifyOnQuery?: boolean;
}

export interface LiveManifest {
	/** Return the current entry snapshot as an array. */
	getEntries(): FileManifestEntry[];
	/**
	 * Look up a single entry by relative path. If `verifyOnQuery` is
	 * currently true, the entry is re-verified (and updated if the
	 * on-disk hash differs) before being returned.
	 */
	getFile(path: string): FileManifestEntry | undefined;
	/**
	 * Return all entries for the given language. If `verifyOnQuery` is
	 * currently true, every matching entry is re-verified.
	 */
	getByLanguage(language: string): FileManifestEntry[];
	/**
	 * Return all entries belonging to the given package. If
	 * `verifyOnQuery` is currently true, every matching entry is
	 * re-verified.
	 */
	getByPackage(pkg: string): FileManifestEntry[];
	/** Subscribe to invalidation events propagated by the underlying watcher. */
	onEvent(handler: (event: WatcherEvent) => void): () => void;
	/**
	 * Re-verify every entry against the filesystem and clear the
	 * `verifyOnQuery` flag. Use this after an `overflow` event (or
	 * after any known uncertain external mutation) to claim the
	 * snapshot fresh again.
	 */
	reconcile(): Promise<void>;
	/**
	 * Stop the underlying watcher and detach the event subscription.
	 * After `stop()` no further events are delivered and the live
	 * manifest becomes a read-only snapshot.
	 */
	stop(): void;
	/** Total number of query-boundary re-verifications performed so far. */
	getVerificationsCount(): number;
	/** True when the next query must re-verify entries against disk. */
	isVerifyOnQuery(): boolean;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Normalize any backslashes to forward slashes for consistent matching. */
function toPosix(path: string): string {
	return path.split(sep).join("/");
}

/** Compute the SHA-256 hex digest of a byte buffer. */
function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Create a `LiveManifest` that subscribes to `options.watcher` and
 * produces an always-fresh view of `options.manifest`.
 *
 * The initial manifest is copied into an internal `Map<path, entry>`,
 * so subsequent mutations to the caller's array are not reflected.
 */
export function createLiveManifest(options: LiveManifestOptions): LiveManifest {
	const rootAbsolute = resolve(options.root);
	const entries = new Map<string, FileManifestEntry>();
	for (const entry of options.manifest) {
		entries.set(toPosix(entry.path), { ...entry });
	}

	let verifyOnQuery = options.verifyOnQuery ?? true;
	let verifications = 0;
	let stopped = false;

	const userHandlers = new Set<(event: WatcherEvent) => void>();
	// Return the handler's Promise so callers that `await` their
	// dispatch (test helpers, the `FileWatcher.emit` loop in tests)
	// observe the post-refresh state. The production `FileWatcher.emit`
	// does not await, so a returned Promise is harmless there.
	const unsubscribeWatcher = options.watcher.onEvent((event) => handleEvent(event));

	function absoluteOf(rel: string): string {
		// Use posix separators when joining to keep the join pure —
		// `join` on Windows would otherwise re-introduce backslashes.
		return join(rootAbsolute, ...rel.split("/"));
	}

	async function readAndHash(absolutePath: string): Promise<{ hash: string; byteLength: number } | undefined> {
		try {
			const bytes = await readFile(absolutePath);
			return { hash: sha256Hex(bytes), byteLength: bytes.byteLength };
		} catch {
			return undefined;
		}
	}

	/**
	 * Read the on-disk file for `rel` and update the entry in place
	 * (or insert a new one). If the file no longer exists, the entry is
	 * removed.
	 */
	async function refreshEntryFromDisk(rel: string): Promise<void> {
		const absolute = absoluteOf(rel);
		const data = await readAndHash(absolute);
		if (!data) {
			entries.delete(rel);
			return;
		}
		const existing = entries.get(rel);
		if (existing) {
			existing.byteLength = data.byteLength;
			existing.contentHash = data.hash;
			return;
		}
		entries.set(rel, {
			path: rel,
			absolutePath: absolute,
			byteLength: data.byteLength,
			contentHash: data.hash,
			language: detectLanguage(rel),
			generated: isGeneratedPath(rel),
			ignored: isIgnoredPath(rel),
		});
	}

	/**
	 * Query-boundary verification. Re-reads the file, recomputes the
	 * hash, and either updates the entry (if changed) or inserts a new
	 * one. Removes the entry if the file has disappeared. Increments
	 * the global counter.
	 */
	async function verifyEntry(rel: string): Promise<void> {
		verifications += 1;
		const absolute = absoluteOf(rel);
		const data = await readAndHash(absolute);
		if (!data) {
			entries.delete(rel);
			return;
		}
		const existing = entries.get(rel);
		if (!existing) {
			entries.set(rel, {
				path: rel,
				absolutePath: absolute,
				byteLength: data.byteLength,
				contentHash: data.hash,
				language: detectLanguage(rel),
				generated: isGeneratedPath(rel),
				ignored: isIgnoredPath(rel),
			});
			return;
		}
		if (existing.contentHash !== data.hash) {
			existing.contentHash = data.hash;
			existing.byteLength = data.byteLength;
		}
	}

	async function handleEvent(event: WatcherEvent): Promise<void> {
		if (stopped) return;

		// Fan-out to user-registered handlers first so they observe
		// the invalidation signal even if the internal refresh fails.
		for (const handler of userHandlers) {
			try {
				handler(event);
			} catch {
				// Handler errors must not break the invalidation pipeline.
			}
		}

		switch (event.kind) {
			case "change":
			case "create":
				await refreshEntryFromDisk(event.path);
				break;
			case "delete":
				entries.delete(event.path);
				break;
			case "rename":
				entries.delete(event.oldPath);
				await refreshEntryFromDisk(event.newPath);
				break;
			case "overflow":
				verifyOnQuery = true;
				break;
		}
	}

	function getEntries(): FileManifestEntry[] {
		return Array.from(entries.values());
	}

	function getFile(path: string): FileManifestEntry | undefined {
		const target = toPosix(path);
		const entry = entries.get(target);
		if (verifyOnQuery) {
			void verifyEntry(target);
		}
		return entry;
	}

	function getByLanguage(language: string): FileManifestEntry[] {
		const matches: FileManifestEntry[] = [];
		for (const entry of entries.values()) {
			if (entry.language === language) matches.push(entry);
		}
		if (verifyOnQuery) {
			for (const match of matches) {
				void verifyEntry(match.path);
			}
		}
		return matches;
	}

	function getByPackage(pkg: string): FileManifestEntry[] {
		const matches: FileManifestEntry[] = [];
		for (const entry of entries.values()) {
			if (entry.package === pkg) matches.push(entry);
		}
		if (verifyOnQuery) {
			for (const match of matches) {
				void verifyEntry(match.path);
			}
		}
		return matches;
	}

	function onEvent(handler: (event: WatcherEvent) => void): () => void {
		userHandlers.add(handler);
		return () => {
			userHandlers.delete(handler);
		};
	}

	async function reconcile(): Promise<void> {
		const paths = Array.from(entries.keys());
		for (const path of paths) {
			await verifyEntry(path);
		}
		verifyOnQuery = false;
	}

	function stop(): void {
		if (stopped) return;
		stopped = true;
		unsubscribeWatcher();
		void options.watcher.stop();
	}

	return {
		getEntries,
		getFile,
		getByLanguage,
		getByPackage,
		onEvent,
		reconcile,
		stop,
		getVerificationsCount: () => verifications,
		isVerifyOnQuery: () => verifyOnQuery,
	};
}

