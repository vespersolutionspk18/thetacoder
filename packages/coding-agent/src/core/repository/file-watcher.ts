/**
 * F1 file-watcher data layer.
 *
 * Minimum-viable watcher that emits `WatcherEvent` notifications for
 * file changes under a single root directory. The watcher is the
 * foundation of the F1 invalidation pipeline (audit Section 11.4):
 * downstream consumers (manifest, syntax index, reference resolver)
 * subscribe to events and re-derive the data they need.
 *
 * ## Design notes
 *
 * - **Hints, not truth.** The audit calls out that watcher events are
 *   hints; verification happens at query and mutation boundaries. This
 *   module makes no claim of completeness. On platforms where the
 *   underlying `fs.watch` reports a `filename === null` after buffer
 *   overflow we emit a single `overflow` event so callers can trigger
 *   a full reconcile pass.
 *
 * - **No new dependencies.** The watcher uses `node:fs.watch` directly
 *   on macOS / Windows and on Linux (Node 20+ supports `recursive:
 *   true`). The `polling` option falls back to a periodic snapshot diff
 *   when the native watcher is unavailable.
 *
 * - **Debounce per path.** The OS can fire many events for a single
 *   user action (e.g. a save produces several `change` events). We
 *   coalesce events per relative path inside the configured debounce
 *   window and emit one `WatcherEvent` per path at the end of the
 *   window. When a path accumulates `change` and `create` events we
 *   emit `create`; when it accumulates a `delete` we emit `delete`.
 *
 * - **Rename pairing.** Most platforms report a rename as two events
 *   (`rename` for the old path disappearing, then `rename` for the
 *   new path appearing). We pair them with a short pending-delete
 *   buffer and emit a single `rename` event with both paths. A
 *   deletion that does not get paired within the window collapses to
 *   a `delete` event.
 *
 * - **Ignored patterns.** The matcher reuses the simple glob grammar
 *   from `./manifest.ts` so users get the same semantics across the
 *   F1 data layer: `*`, `?`, `**`, leading `/` anchor, trailing `/`.
 *   Negation (`!`) is supported.
 */

import { type Dirent, existsSync, type FSWatcher, readdirSync, statSync, watch } from "node:fs";
import { relative, resolve, sep } from "node:path";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export type WatcherEvent =
	| { kind: "change"; path: string; timestamp: number }
	| { kind: "create"; path: string; timestamp: number }
	| { kind: "delete"; path: string; timestamp: number }
	| { kind: "rename"; oldPath: string; newPath: string; timestamp: number }
	| { kind: "overflow"; timestamp: number };

export interface FileWatcherOptions {
	/** Absolute path to the directory to watch. */
	root: string;
	/** Additional ignore patterns, applied in addition to the always-ignored list. */
	ignored?: string[];
	/** Coalesce events per path within this window. Default `50` ms. */
	debounceMs?: number;
	/** Backend selection. Default `"fs.watch"`. */
	native?: "fs.watch" | "chokidar" | "polling";
}

export interface FileWatcher {
	start(): Promise<void>;
	stop(): Promise<void>;
	/** Subscribe to events. Returns an unsubscribe function. */
	onEvent(handler: (event: WatcherEvent) => void): () => void;
	/** Subscribe to errors from the underlying watcher. Returns an unsubscribe function. */
	onError(handler: (err: Error) => void): () => void;
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

const ALWAYS_IGNORED_DIRS = new Set([".git", "node_modules", ".theta", ".theta"]);

/** Normalize any backslashes to forward slashes for consistent matching. */
function toPosix(path: string): string {
	return path.split(sep).join("/");
}

interface GlobToRegExpOptions {
	leadingSlash: boolean;
}

/** Convert a simple glob to a `RegExp`. Shared semantics with `manifest.ts`. */
function globToRegExp(pattern: string, options: GlobToRegExpOptions): RegExp {
	let regex = "";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				regex += ".*";
				i += 2;
				if (pattern[i] === "/") i += 1;
			} else {
				regex += "[^/]*";
				i += 1;
			}
		} else if (ch === "?") {
			regex += "[^/]";
			i += 1;
		} else if (
			ch === "." ||
			ch === "(" ||
			ch === ")" ||
			ch === "+" ||
			ch === "|" ||
			ch === "^" ||
			ch === "$" ||
			ch === "{"
		) {
			regex += `\\${ch}`;
			i += 1;
		} else if (ch === "\\" && i + 1 < pattern.length) {
			regex += `\\${pattern[i + 1]}`;
			i += 2;
		} else {
			regex += ch;
			i += 1;
		}
	}
	const anchor = options.leadingSlash ? "^" : "(^|/)";
	return new RegExp(`${anchor}${regex}(/|$)`);
}

function matchesGitignorePattern(posix: string, pattern: string): boolean {
	const isNegation = pattern.startsWith("!");
	const body = isNegation ? pattern.slice(1) : pattern;
	if (body === "") return false;

	let anchored = body;
	let dirOnly = false;
	if (anchored.endsWith("/")) {
		dirOnly = true;
		anchored = anchored.slice(0, -1);
	}
	let leadingSlash = false;
	if (anchored.startsWith("/")) {
		leadingSlash = true;
		anchored = anchored.slice(1);
	}
	if (anchored === "") return false;

	const regex = globToRegExp(anchored, { leadingSlash });
	if (dirOnly) {
		if (!isNegation && !regex.test(posix)) return false;
		return posix === anchored || posix.startsWith(`${anchored}/`);
	}
	return regex.test(posix);
}

function matchesAlwaysIgnored(posix: string): boolean {
	if (posix === "") return false;
	const segments = posix.split("/");
	for (const segment of segments) {
		if (ALWAYS_IGNORED_DIRS.has(segment)) return true;
	}
	return false;
}

/**
 * Resolve whether a relative POSIX path should be ignored, given the
 * configured patterns. The patterns use the same grammar as
 * `manifest.ts` (negation, leading-slash anchor, trailing-slash dir-only,
 * `*`/`?`/`**`).
 */
function isIgnoredByPatterns(posix: string, patterns: string[]): boolean {
	if (matchesAlwaysIgnored(posix)) return true;
	if (patterns.length === 0) return false;

	let ignored = false;
	for (const raw of patterns) {
		const pattern = raw.trim();
		if (pattern === "" || pattern.startsWith("#")) continue;
		if (matchesGitignorePattern(posix, pattern)) {
			ignored = !pattern.startsWith("!");
		}
	}
	return ignored;
}

/* -------------------------------------------------------------------------- */
/* Pending-event buffer + debounce                                             */
/* -------------------------------------------------------------------------- */

/**
 * A pending event for a single relative path, accumulated during the
 * debounce window. We track the set of kinds accumulated so that a
 * `change → change → change` burst collapses to a single `change`,
 * while a `change → delete` sequence is forwarded correctly (the
 * delete wins because the file is gone by the time we flush).
 */
interface PendingEntry {
	/** Set of kinds accumulated during the window. */
	kinds: Set<"change" | "create">;
	/** Timer that will flush this entry. */
	timer: NodeJS.Timeout | null;
}

interface PendingDelete {
	path: string;
	timestamp: number;
}

const RENAME_PAIR_WINDOW_MS = 250;

class EventBuffer {
	private readonly entries = new Map<string, PendingEntry>();
	private readonly pendingDeletes: PendingDelete[] = [];
	private readonly debounceMs: number;
	private readonly rootAbsolute: string;
	private readonly patterns: string[];
	private readonly handlers = new Set<(event: WatcherEvent) => void>();
	/** Timer for the next pending-delete prune. Null when nothing is pending. */
	private pruneTimer: NodeJS.Timeout | null = null;

	constructor(deps: { rootAbsolute: string; patterns: string[]; debounceMs: number }) {
		this.rootAbsolute = deps.rootAbsolute;
		this.patterns = deps.patterns;
		this.debounceMs = deps.debounceMs;
	}

	addHandler(handler: (event: WatcherEvent) => void): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	/** True when the path is ignored by the configured patterns. */
	isIgnored(absolutePath: string): boolean {
		const rel = toPosix(relative(this.rootAbsolute, absolutePath));
		if (rel === "" || rel.startsWith("..")) return true;
		return isIgnoredByPatterns(rel, this.patterns);
	}

	/**
	 * Pair a `create` event with a recent `delete` in the same
	 * directory. If a match is found, returns the matching delete and
	 * removes it from the pending list. Otherwise returns null.
	 */
	private pairRename(newRel: string): PendingDelete | null {
		this.prunePendingDeletes(Date.now());
		const newDir = directoryOf(newRel);
		for (let i = 0; i < this.pendingDeletes.length; i += 1) {
			const candidate = this.pendingDeletes[i];
			if (directoryOf(candidate.path) === newDir) {
				return this.pendingDeletes.splice(i, 1)[0];
			}
		}
		return null;
	}

	/** Record a change / create event for `absolutePath`. */
	enqueueMutation(absolutePath: string, kind: "change" | "create"): void {
		if (this.isIgnored(absolutePath)) return;
		const rel = toPosix(relative(this.rootAbsolute, absolutePath));

		// Try to pair with a recent delete in the same directory.
		if (kind === "create") {
			const pair = this.pairRename(rel);
			if (pair) {
				this.emit({
					kind: "rename",
					oldPath: pair.path,
					newPath: rel,
					timestamp: Date.now(),
				});
				return;
			}
		}

		const existing = this.entries.get(rel);
		if (existing) {
			existing.kinds.add(kind);
			if (existing.timer) clearTimeout(existing.timer);
			existing.timer = this.scheduleFlush(rel, existing);
		} else {
			const entry: PendingEntry = {
				kinds: new Set([kind]),
				timer: null,
			};
			entry.timer = this.scheduleFlush(rel, entry);
			this.entries.set(rel, entry);
		}
	}

	/** Record a deletion for `absolutePath`. */
	enqueueDelete(absolutePath: string): void {
		if (this.isIgnored(absolutePath)) return;
		const rel = toPosix(relative(this.rootAbsolute, absolutePath));
		const now = Date.now();
		this.pendingDeletes.push({ path: rel, timestamp: now });
		this.schedulePendingPrune(now);
		this.prunePendingDeletes(now);

		// Cancel any pending mutation flush for this path — the file
		// is gone, so a `change`/`create` is meaningless.
		const existing = this.entries.get(rel);
		if (existing) {
			if (existing.timer) clearTimeout(existing.timer);
			this.entries.delete(rel);
		}
	}

	/** Drop all pending state. Used by `stop()`. */
	clear(): void {
		for (const entry of this.entries.values()) {
			if (entry.timer) clearTimeout(entry.timer);
		}
		this.entries.clear();
		this.pendingDeletes.length = 0;
		if (this.pruneTimer) {
			clearTimeout(this.pruneTimer);
			this.pruneTimer = null;
		}
	}

	/** Emit an `overflow` event. */
	emitOverflow(): void {
		this.emit({ kind: "overflow", timestamp: Date.now() });
	}

	private emit(event: WatcherEvent): void {
		for (const handler of this.handlers) {
			try {
				handler(event);
			} catch {
				// Handler errors must not crash the watcher.
			}
		}
	}

	private scheduleFlush(rel: string, entry: PendingEntry): NodeJS.Timeout {
		return setTimeout(() => {
			this.flushEntry(rel, entry);
		}, this.debounceMs);
	}

	private flushEntry(rel: string, entry: PendingEntry): void {
		this.entries.delete(rel);
		// Determine the effective kind:
		//   - create wins over change (first appearance).
		//   - otherwise emit change.
		let effective: "change" | "create";
		if (entry.kinds.has("create")) {
			effective = "create";
		} else {
			effective = "change";
		}
		this.emit({ kind: effective, path: rel, timestamp: Date.now() });
	}

	private prunePendingDeletes(now: number): void {
		const cutoff = now - RENAME_PAIR_WINDOW_MS;
		while (this.pendingDeletes.length > 0 && this.pendingDeletes[0].timestamp < cutoff) {
			const stale = this.pendingDeletes.shift() as PendingDelete;
			// No pair arrived in time — emit a `delete` for it.
			this.emit({ kind: "delete", path: stale.path, timestamp: now });
		}
		// If entries are still pending, schedule another prune so the
		// later ones get emitted too.
		if (this.pendingDeletes.length > 0 && this.pruneTimer === null) {
			this.pruneTimer = setTimeout(() => {
				this.pruneTimer = null;
				this.prunePendingDeletes(Date.now());
			}, RENAME_PAIR_WINDOW_MS);
		}
	}

	/**
	 * (Re)arm the prune timer so a fresh `delete` can still pair with
	 * a `create` that arrives a few hundred milliseconds later.
	 */
	private schedulePendingPrune(_now: number): void {
		if (this.pruneTimer) {
			clearTimeout(this.pruneTimer);
		}
		this.pruneTimer = setTimeout(() => {
			this.pruneTimer = null;
			this.prunePendingDeletes(Date.now());
		}, RENAME_PAIR_WINDOW_MS);
	}
}

/** Return the directory portion of a posix-relative path. */
function directoryOf(posixRel: string): string {
	const slash = posixRel.lastIndexOf("/");
	return slash >= 0 ? posixRel.slice(0, slash) : "";
}

/* -------------------------------------------------------------------------- */
/* fs.watch backend                                                           */
/* -------------------------------------------------------------------------- */

function pathExists(absolutePath: string): boolean {
	try {
		statSync(absolutePath);
		return true;
	} catch {
		return false;
	}
}

function startNativeWatcher(deps: {
	rootAbsolute: string;
	buffer: EventBuffer;
	onError: (err: Error) => void;
}): FSWatcher {
	const listener: Parameters<typeof watch>[1] = (eventType, filename) => {
		if (filename === null || filename === undefined) {
			// Native overflow — see Node docs. Treat as a hint to reconcile.
			deps.buffer.emitOverflow();
			return;
		}

		const childPath = resolve(deps.rootAbsolute, filename.toString());
		const rel = toPosix(relative(deps.rootAbsolute, childPath));
		if (rel === "" || rel.startsWith("..")) return;

		if (eventType === "change") {
			if (!pathExists(childPath)) return;
			deps.buffer.enqueueMutation(childPath, "change");
			return;
		}

		if (eventType === "rename") {
			// `rename` is overloaded: it covers both file creation and
			// file deletion on most platforms. We do a synchronous
			// stat to decide which, and only fall back to a deferred
			// probe when the OS fired the event before the path
			// became visible. Synchronous stat is essential for
			// rename pairing: if we deferred the delete, a subsequent
			// create for the new name would never find a partner.
			if (pathExists(childPath)) {
				deps.buffer.enqueueMutation(childPath, "create");
			} else {
				deps.buffer.enqueueDelete(childPath);
			}
		}
	};

	return watch(deps.rootAbsolute, { recursive: true }, listener);
}

/* -------------------------------------------------------------------------- */
/* Polling backend                                                            */
/* -------------------------------------------------------------------------- */

interface PollSnapshot {
	mtime: number;
	size: number;
}

function snapshotDir(rootAbsolute: string, patterns: string[]): Map<string, PollSnapshot> {
	const out = new Map<string, PollSnapshot>();
	const stack: string[] = [rootAbsolute];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = resolve(dir, entry.name);
			const rel = toPosix(relative(rootAbsolute, full));
			if (rel === "" || rel.startsWith("..")) continue;
			if (isIgnoredByPatterns(rel, patterns)) continue;
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (!entry.isFile()) continue;
			try {
				const st = statSync(full);
				out.set(rel, { mtime: st.mtimeMs, size: st.size });
			} catch {
				// File disappeared between readdir and stat; treat as
				// missing so the next tick sees a delete.
				out.set(rel, { mtime: -1, size: -1 });
			}
		}
	}
	return out;
}

function startPollingBackend(deps: {
	rootAbsolute: string;
	patterns: string[];
	buffer: EventBuffer;
	intervalMs: number;
}): NodeJS.Timeout {
	let previous = snapshotDir(deps.rootAbsolute, deps.patterns);
	const tick = () => {
		const current = snapshotDir(deps.rootAbsolute, deps.patterns);
		// Detect creates + changes.
		for (const [rel, snap] of current) {
			if (snap.mtime < 0) continue;
			const prev = previous.get(rel);
			if (!prev) {
				deps.buffer.enqueueMutation(resolve(deps.rootAbsolute, rel), "create");
			} else if (prev.mtime !== snap.mtime || prev.size !== snap.size) {
				deps.buffer.enqueueMutation(resolve(deps.rootAbsolute, rel), "change");
			}
		}
		// Detect deletes: previous had a path, current does not.
		for (const rel of previous.keys()) {
			if (!current.has(rel)) {
				deps.buffer.enqueueDelete(resolve(deps.rootAbsolute, rel));
			}
		}
		previous = current;
	};
	return setInterval(tick, deps.intervalMs);
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Create a `FileWatcher` rooted at `options.root`. The returned watcher
 * is not active until `start()` resolves; calling `start()` more than
 * once is a no-op, and `stop()` is idempotent.
 *
 * The watcher keeps a single `root` directory and never follows
 * symlinks outside it. Ignored paths are computed against forward-slash
 * relative paths, so callers can pass patterns from `.gitignore` or a
 * `theta-ignore` file without translation.
 */
export function createFileWatcher(options: FileWatcherOptions): FileWatcher {
	const rootAbsolute = resolve(options.root);
	const debounceMs = options.debounceMs ?? 50;
	const patterns = options.ignored ?? [];
	const backend = options.native ?? "fs.watch";

	const buffer = new EventBuffer({ rootAbsolute, patterns, debounceMs });
	const errorHandlers = new Set<(err: Error) => void>();

	let nativeWatcher: FSWatcher | null = null;
	let pollingTimer: NodeJS.Timeout | null = null;
	let started = false;
	let stopPromise: Promise<void> | null = null;

	const emitError = (err: Error) => {
		for (const handler of errorHandlers) {
			try {
				handler(err);
			} catch {
				// Swallow handler errors.
			}
		}
	};

	const watcher: FileWatcher = {
		start: async () => {
			if (started) return;
			started = true;

			if (backend === "polling") {
				pollingTimer = startPollingBackend({
					rootAbsolute,
					patterns,
					buffer,
					intervalMs: Math.max(debounceMs, 100),
				});
				return;
			}

			// `chokidar` is not an installed dependency; treat the request
			// as a configuration error rather than silently fall back.
			if (backend === "chokidar") {
				started = false;
				throw new Error("createFileWatcher: 'chokidar' backend is not available in this build");
			}

			try {
				nativeWatcher = startNativeWatcher({
					rootAbsolute,
					buffer,
					onError: emitError,
				});
				nativeWatcher.on("error", emitError);
			} catch (err) {
				started = false;
				const error = err instanceof Error ? err : new Error(String(err));
				emitError(error);
				throw error;
			}
		},

		stop: async () => {
			if (stopPromise) return stopPromise;
			stopPromise = (async () => {
				if (nativeWatcher) {
					try {
						nativeWatcher.close();
					} catch {
						// Ignore close errors.
					}
					nativeWatcher = null;
				}
				if (pollingTimer) {
					clearInterval(pollingTimer);
					pollingTimer = null;
				}
				buffer.clear();
				started = false;
			})();
			return stopPromise;
		},

		onEvent: (handler) => buffer.addHandler(handler),

		onError: (handler) => {
			errorHandlers.add(handler);
			return () => {
				errorHandlers.delete(handler);
			};
		},
	};

	return watcher;
}

/* -------------------------------------------------------------------------- */
/* Test-only utilities                                                        */
/* -------------------------------------------------------------------------- */

/** Test-only: true if `absolutePath` exists on disk. */
export function pathExistsForTesting(absolutePath: string): boolean {
	return existsSync(absolutePath);
}

/** Test-only: re-export the always-ignored list. */
export const __ALWAYS_IGNORED_DIRS_FOR_TESTING = ALWAYS_IGNORED_DIRS;

