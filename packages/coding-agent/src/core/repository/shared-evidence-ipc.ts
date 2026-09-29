/**
 * F10 shared evidence — IPC-backed file implementation.
 *
 * `InMemorySharedEvidenceStore` only lives inside one process. When a
 * parent agent spawns a child subagent, the two processes are
 * isolated and a child re-walks the worktree, re-parses source, and
 * re-hashes files that the parent already paid to compute. This
 * module gives them a place to share that work across the process
 * boundary.
 *
 * The transport is deliberately the simplest thing that survives a
 * process crash: a single JSON file under a known path plus a sidecar
 * lock file. We are not trying to be a database:
 *
 *   - The whole store is rewritten on every mutation. A typical
 *     session's evidence is well under a megabyte, so the cost is
 *     negligible next to the work the store is meant to avoid.
 *   - Cross-process safety is best-effort. The lock is a sidecar
 *     file acquired with `fs.open(..., "wx")` (exclusive create); if
 *     contention exceeds `lockTimeoutMs` the operation throws so the
 *     caller can decide whether to retry or fall back to in-memory.
 *   - We never silently drop writes. If we cannot persist, we throw.
 *
 * The cache is a `Map<string, Evidence>` keyed by evidence id. Reads
 * always go through the cache, so they are O(1) / O(n) without
 * touching disk. Writes update the cache and then flush the whole
 * map to disk under the lock. A second process that opens the same
 * file rebuilds the cache from disk on construction, so the round
 * trip is "put in parent, open store in child, get in child".
 *
 * The sync `put` / `delete` / `clear` methods schedule an async
 * write; the async `putAsync` / `deleteAsync` / `clearAsync` /
 * `flush` methods let the caller wait for the write to land. This
 * matches the existing `SharedEvidenceStore` interface (sync) while
 * giving callers that care about persistence an explicit hook.
 */

import { readFileSync } from "node:fs";
import { mkdir, open, rm, unlink, writeFile } from "node:fs/promises";

import { type Evidence, type EvidenceKind, isValid, type SharedEvidenceStore } from "./shared-evidence.ts";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface FileSharedEvidenceStoreOptions {
	/**
	 * Absolute path to the JSON file backing the store. The file does
	 * not need to exist yet; the store creates its parent directory on
	 * first write.
	 */
	path: string;
	/**
	 * Maximum time, in milliseconds, to wait when acquiring the
	 * cross-process file lock. Defaults to 5000. After this time the
	 * operation throws a `SharedEvidenceLockError`.
	 */
	lockTimeoutMs?: number;
}

/**
 * Thrown when a write cannot acquire the cross-process lock within
 * `lockTimeoutMs`. Distinct type so callers can recognize the
 * recoverable-from-contention case.
 */
export class SharedEvidenceLockError extends Error {
	constructor(path: string, lockPath: string, timeoutMs: number) {
		super(`SharedEvidenceStore lock contention: could not acquire ${lockPath} for ${path} within ${timeoutMs}ms`);
		this.name = "SharedEvidenceLockError";
	}
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const DEFAULT_LOCK_TIMEOUT_MS = 5000;

/** Poll interval between lock attempts. Small enough to feel snappy, large enough to avoid pegging the CPU. */
const LOCK_RETRY_INTERVAL_MS = 5;

/** On-disk serialization version. Bump if the file format changes in an incompatible way. */
const FILE_FORMAT_VERSION = 1 as const;

interface PersistedFile {
	version: typeof FILE_FORMAT_VERSION;
	entries: Evidence[];
}

/* -------------------------------------------------------------------------- */
/* FileSharedEvidenceStore                                                    */
/* -------------------------------------------------------------------------- */

/**
 * File-backed `SharedEvidenceStore` shared across processes.
 *
 * Construction reads the file (if present) and populates an in-memory
 * `Map`. All read methods are served from the cache, so they are
 * O(1) / O(n) without touching disk. Write methods update the cache
 * and then flush the whole map to disk under a cross-process file
 * lock.
 */
export class FileSharedEvidenceStore implements SharedEvidenceStore {
	private readonly path: string;
	private readonly lockPath: string;
	private readonly lockTimeoutMs: number;
	private readonly entries: Map<string, Evidence> = new Map();
	/**
	 * Tail of the in-flight write chain. The sync `put` / `delete` /
	 * `clear` methods chain onto it; the async variants and `flush`
	 * await it. Null when no write is pending.
	 */
	private pendingWrite: Promise<void> = Promise.resolve();
	/**
	 * Once `destroy()` is called the store refuses to write further
	 * and pending writes resolve to no-ops. This prevents a queued
	 * write from racing with test teardown and emitting an unhandled
	 * `ENOENT` after the temp dir has been removed.
	 */
	private destroyed = false;

	constructor(options: FileSharedEvidenceStoreOptions) {
		this.path = options.path;
		this.lockPath = `${options.path}.lock`;
		this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
		// Load eagerly so the first read is served from the in-memory
		// cache without an async barrier. Sync I/O is acceptable
		// here: the file is a single JSON blob bounded by design.
		this.loadFromDisk();
	}

	/* ---------------------------------------------------------------------- */
	/* SharedEvidenceStore                                                    */
	/* ---------------------------------------------------------------------- */

	put(evidence: Evidence): void {
		if (this.destroyed) return;
		this.entries.set(evidence.id, evidence);
		this.scheduleWrite();
	}

	get(id: string): Evidence | undefined {
		return this.entries.get(id);
	}

	getByKind(kind: EvidenceKind): Evidence[] {
		const out: Evidence[] = [];
		for (const entry of this.entries.values()) {
			if (entry.kind === kind) out.push(entry);
		}
		return out;
	}

	getValidByKind(kind: EvidenceKind, now?: number): Evidence[] {
		const stamp = now ?? Date.now();
		const out: Evidence[] = [];
		for (const entry of this.entries.values()) {
			if (entry.kind !== kind) continue;
			if (!isValid(entry, stamp)) continue;
			out.push(entry);
		}
		return out;
	}

	delete(id: string): void {
		if (this.destroyed) return;
		this.entries.delete(id);
		this.scheduleWrite();
	}

	size(): number {
		return this.entries.size;
	}

	clear(): void {
		if (this.destroyed) return;
		this.entries.clear();
		this.scheduleWrite();
	}

	/* ---------------------------------------------------------------------- */
	/* Async write API                                                        */
	/* ---------------------------------------------------------------------- */

	/**
	 * Insert or replace an evidence record, returning a promise that
	 * resolves once the write has been flushed to disk. Prefer this
	 * over `put` when the caller needs persistence guarantees (for
	 * example, immediately before a child process is spawned).
	 */
	async putAsync(evidence: Evidence): Promise<void> {
		if (this.destroyed) return;
		this.entries.set(evidence.id, evidence);
		await this.persist();
	}

	/**
	 * Remove a record by id, returning a promise that resolves once
	 * the deletion has been flushed to disk.
	 */
	async deleteAsync(id: string): Promise<void> {
		if (this.destroyed) return;
		this.entries.delete(id);
		await this.persist();
	}

	/**
	 * Drop every record, returning a promise that resolves once the
	 * truncation has been flushed to disk (or the file has been
	 * removed entirely when the cache was already empty).
	 */
	async clearAsync(): Promise<void> {
		if (this.destroyed) return;
		this.entries.clear();
		await this.persist();
	}

	/**
	 * Wait for any pending write to complete. Useful in test
	 * teardown so a `destroy()` call does not race with a still-
	 * queued `put` from earlier in the test.
	 */
	async flush(): Promise<void> {
		await this.pendingWrite;
	}

	/* ---------------------------------------------------------------------- */
	/* Loading                                                                */
	/* ---------------------------------------------------------------------- */

	/**
	 * Hydrate the in-memory cache from the on-disk file. Missing file
	 * is a normal startup state and yields an empty cache; a
	 * corrupted file is a real problem and surfaces so callers don't
	 * silently lose evidence.
	 */
	private loadFromDisk(): void {
		let raw: string;
		try {
			raw = readFileSync(this.path, "utf-8");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return;
			throw err;
		}
		// An empty file is treated the same as a missing one — the
		// store starts empty. Upstream tooling may `touch` the file
		// before the first put, and we should not turn that into a
		// JSON parse error.
		if (raw.length === 0) return;
		const parsed = JSON.parse(raw) as PersistedFile;
		if (parsed && Array.isArray(parsed.entries)) {
			for (const entry of parsed.entries) {
				if (entry && typeof entry.id === "string") {
					this.entries.set(entry.id, entry);
				}
			}
		}
	}

	/* ---------------------------------------------------------------------- */
	/* Persistence                                                            */
	/* ---------------------------------------------------------------------- */

	/**
	 * Chain a write onto the pending-write tail. Used by the sync
	 * `put` / `delete` / `clear` API; the write runs asynchronously
	 * and any error is swallowed (the next explicit call will surface
	 * it via `flush` / `putAsync`).
	 */
	private scheduleWrite(): void {
		this.pendingWrite = this.pendingWrite.then(() => this.persist());
	}

	private async persist(): Promise<void> {
		if (this.destroyed) return;
		// Capture the size and entries now so a concurrent mutation
		// between `persist` scheduling and the lock acquisition does
		// not interleave with our write.
		const entriesSnapshot = Array.from(this.entries.values());
		try {
			await mkdir(dirnameOf(this.path), { recursive: true });
		} catch (err) {
			// A concurrent `destroy` may have removed the temp dir
			// before we got here. That is a benign race: the caller
			// has signalled it is done with the store, and the write
			// is no longer meaningful.
			if (this.destroyed) return;
			throw err;
		}
		await this.withLock(async () => {
			if (this.destroyed) return;
			if (entriesSnapshot.length === 0) {
				// Empty store: remove the file entirely so a fresh
				// process sees the absence rather than an empty
				// array. Tolerate ENOENT — the file may have never
				// been created.
				try {
					await unlink(this.path);
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
				}
			} else {
				const serialized = JSON.stringify({
					version: FILE_FORMAT_VERSION,
					entries: entriesSnapshot,
				} satisfies PersistedFile);
				await writeFile(this.path, serialized, "utf-8");
			}
		});
	}

	/* ---------------------------------------------------------------------- */
	/* Locking                                                                */
	/* ---------------------------------------------------------------------- */

	/**
	 * Run `fn` while holding the cross-process file lock. The lock is
	 * a sidecar file at `${path}.lock` opened with the `wx` flag
	 * (exclusive create). If another process already holds the lock
	 * we poll every `LOCK_RETRY_INTERVAL_MS` until we get it or
	 * until `lockTimeoutMs` elapses, at which point we throw a
	 * `SharedEvidenceLockError`.
	 */
	private async withLock<T>(fn: () => Promise<T>): Promise<T> {
		const start = Date.now();
		let handle: Awaited<ReturnType<typeof open>> | null = null;
		while (handle === null) {
			try {
				handle = await open(this.lockPath, "wx");
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "EEXIST") {
					// Some other I/O failure (permission denied,
					// missing parent dir, etc.) — not contention, so
					// do not spin.
					throw err;
				}
				if (Date.now() - start >= this.lockTimeoutMs) {
					throw new SharedEvidenceLockError(this.path, this.lockPath, this.lockTimeoutMs);
				}
				await sleep(LOCK_RETRY_INTERVAL_MS);
			}
		}
		try {
			return await fn();
		} finally {
			// Best-effort cleanup: close the file handle, then
			// unlink the sidecar. If the process crashes, the OS
			// releases the handle and a future attempt will see a
			// stale `.lock` file — the timeout above bounds the
			// wait, so the worst case is `lockTimeoutMs` of
			// spinning.
			try {
				await handle.close();
			} catch {
				// ignore
			}
			try {
				await rm(this.lockPath, { force: true });
			} catch {
				// ignore
			}
		}
	}

	/* ---------------------------------------------------------------------- */
	/* For tests / cleanup                                                    */
	/* ---------------------------------------------------------------------- */

	/**
	 * Remove the backing file and its sidecar lock. Intended for
	 * test teardown — production callers should use `clear` instead.
	 * Waits for any pending write to drain first, so a queued write
	 * from earlier in the test cannot race with the unlink and
	 * surface as an unhandled `ENOENT`.
	 */
	async destroy(): Promise<void> {
		this.destroyed = true;
		try {
			await this.pendingWrite;
		} catch {
			// The pending write itself swallows its own errors; this
			// is a defensive await in case a future change re-throws.
		}
		try {
			await unlink(this.path);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		try {
			await unlink(this.lockPath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		this.entries.clear();
	}

	/**
	 * Re-read the on-disk file into the in-memory cache, discarding
	 * the current cache. Used by tests to verify that a sibling
	 * process's write is visible to a fresh handle on the same path.
	 */
	async reload(): Promise<void> {
		this.entries.clear();
		this.loadFromDisk();
	}
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Return the parent directory of an absolute path. Handles both
 * POSIX and Windows separators without pulling in `node:path` (which
 * has different semantics for `posix.dirname` vs `win32.dirname`).
 */
function dirnameOf(p: string): string {
	const lastSlash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	if (lastSlash <= 0) return ".";
	return p.slice(0, lastSlash);
}

