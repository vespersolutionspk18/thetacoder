/**
 * F10 subagent evidence sharing.
 *
 * The F10 audit noted that child subagents repeat the parent's
 * initialization and repository discovery work because the two
 * processes are isolated. The shared evidence store
 * (`FileSharedEvidenceStore`) is the IPC bridge that lets the parent
 * hand already-computed facts to a child before the child process
 * even starts, and lets the parent observe what the child produced
 * while it was running.
 *
 * This module is the wiring layer:
 *
 *   - `shareEvidenceWithSubagent` copies a curated subset of the
 *     parent's evidence into the subagent's backing file. We carry
 *     `file-manifest` and `syntax-index` wholesale (they are the
 *     slow, worktree-wide scans a child would otherwise repeat) and
 *     filter `file-content` to only the paths the child is likely
 *     to need (its declared task paths).
 *   - `consumeChildEvidence` opens a fresh handle on the child's
 *     store path and polls it for records the child produced. It
 *     stops when the child process exits or the configured timeout
 *     elapses, whichever comes first. The consumer parameter is a
 *     borrowed context object: the function drives its own polling
 *     against the child's file and returns the records it observed.
 *
 * The functions do not own the parent's `SharedEvidenceStore` —
 * they borrow it. Multi-process file locking and parent-teardown
 * ordering are the caller's responsibility.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Evidence, SharedEvidenceStore } from "./repository/shared-evidence.ts";
import type { SharedEvidenceConsumer } from "./repository/shared-evidence-consumer.ts";
import { FileSharedEvidenceStore } from "./repository/shared-evidence-ipc.ts";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Options for `shareEvidenceWithSubagent`.
 *
 * `taskPaths` is the path filter for `file-content` records: only
 * records whose `payload.path` matches one of these are copied. A
 * missing or empty list means "do not copy any file-content
 * records" — manifests and syntax indices are still copied.
 */
export interface ShareEvidenceOptions {
	/**
	 * Absolute paths the subagent is expected to read. Used to
	 * filter `file-content` records so the child does not receive
	 * arbitrary files the parent happened to read earlier.
	 */
	taskPaths?: string[];
}

/**
 * Result of a share. `manifestCount`, `syntaxIndexCount`, and
 * `fileContentCount` let callers verify the copy at a glance and
 * emit telemetry without re-walking the store.
 */
export interface ShareEvidenceResult {
	manifestCount: number;
	syntaxIndexCount: number;
	fileContentCount: number;
}

/**
 * Options for `consumeChildEvidence`.
 */
export interface ConsumeChildEvidenceOptions {
	/**
	 * How often to poll the child's store, in milliseconds.
	 * Defaults to 50. The poll is a cheap disk stat + JSON parse,
	 * so this does not need to be aggressive.
	 */
	pollIntervalMs?: number;
	/**
	 * Maximum time to wait for the child process to exit, in
	 * milliseconds. Defaults to 30_000 (30 s). When the timeout
	 * elapses the function returns whatever it has already
	 * observed; it does not abort the child.
	 */
	timeoutMs?: number;
	/**
	 * Source label the parent should filter for. When set, the
	 * function only returns evidence whose `source` matches; this
	 * is how the parent ignores its own records that the
	 * subagent-evidence-share write produced and only sees what
	 * the child newly produced.
	 */
	childSource?: string;
}

/**
 * Result of a consume. `consumed` is the list of evidence records
 * the child wrote during the lifetime of the function. `timedOut`
 * is `true` when the timeout fired before the child exited.
 */
export interface ConsumeChildEvidenceResult {
	consumed: Evidence[];
	timedOut: boolean;
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_CONSUME_TIMEOUT_MS = 30_000;

/* -------------------------------------------------------------------------- */
/* Parent → child                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Copy a curated subset of the parent's evidence into the
 * subagent's backing file. After this returns, the file at
 * `subagentStorePath` exists and is ready for the child process to
 * `open` on first read.
 *
 * The contract:
 *
 *   - `file-manifest` records are copied verbatim.
 *   - `syntax-index` records are copied verbatim.
 *   - `file-content` records are copied only when the record's
 *     payload `path` matches one of `options.taskPaths` (string
 *     equality, since the parent's read tool records the absolute
 *     path the parent used).
 *
 * The function flushes its writes before returning so the child
 * process can open the file and observe a consistent view. The
 * transient store used to write the file is destroyed before
 * return so the child's handle starts from a clean state.
 */
export async function shareEvidenceWithSubagent(
	parentStore: SharedEvidenceStore,
	subagentStorePath: string,
	options: ShareEvidenceOptions = {},
): Promise<ShareEvidenceResult> {
	const taskPaths = options.taskPaths ?? [];
	const allowedFileContentPaths = new Set(taskPaths);

	const manifestEntries = parentStore.getByKind("file-manifest");
	const syntaxIndexEntries = parentStore.getByKind("syntax-index");
	const fileContentEntries = parentStore.getByKind("file-content").filter((entry) => {
		if (allowedFileContentPaths.size === 0) return false;
		const path = pathFromPayload(entry);
		if (path === undefined) return false;
		return allowedFileContentPaths.has(path);
	});

	// Write the serialized cache directly. Going through
	// `FileSharedEvidenceStore` would either leave a dangling
	// handle behind (no `close` without unlink) or remove the
	// backing file on `destroy()`. Neither is what we want: the
	// child process needs the file to exist on its first read.
	await writeChildStoreFile(subagentStorePath, [...manifestEntries, ...syntaxIndexEntries, ...fileContentEntries]);

	return {
		manifestCount: manifestEntries.length,
		syntaxIndexCount: syntaxIndexEntries.length,
		fileContentCount: fileContentEntries.length,
	};
}

/* -------------------------------------------------------------------------- */
/* Child → parent                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Poll a child's evidence file and surface the records it produced.
 *
 * The function returns when **either** the process identified by
 * `childPid` exits **or** `options.timeoutMs` elapses. The polling
 * loop reloads the on-disk cache between ticks so writes from the
 * child are visible without a shared process-local cache.
 *
 * `parentConsumer` is borrowed: it is the consumer the parent owns
 * for its own session. The function uses it to drive a per-tick
 * `consume()` snapshot so any `onNew` handler attached to the
 * consumer sees the same evidence this function returns. The
 * consumer's own polling loop (if started) is left untouched.
 */
export async function consumeChildEvidence(
	parentConsumer: SharedEvidenceConsumer,
	childStorePath: string,
	childPid: number,
	options: ConsumeChildEvidenceOptions = {},
): Promise<ConsumeChildEvidenceResult> {
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_CONSUME_TIMEOUT_MS;
	const childSource = options.childSource;

	const childStore = new FileSharedEvidenceStore({ path: childStorePath });
	// Track ids we have already reported this call so a record
	// present in two consecutive reloads is not double-counted.
	// We do not seed the set with the initial on-disk contents:
	// the function is meant to surface every record the child
	// produced, even those that landed on disk before the parent
	// started polling (a real child can finish its first write
	// in tens of milliseconds). The optional `childSource`
	// filter is the right tool for excluding records a prior
	// `shareEvidenceWithSubagent` call left behind.
	const seen = new Set<string>();
	const consumed: Evidence[] = [];
	let timedOut = false;

	try {
		const start = Date.now();
		while (true) {
			// Reload the on-disk cache so records the child wrote
			// since the last tick become visible.
			await childStore.reload();
			for (const entry of collectChildEntries(childStore, childSource)) {
				if (seen.has(entry.id)) continue;
				seen.add(entry.id);
				consumed.push(entry);
			}
			// Drive the parent consumer so any `onNew` handler it
			// was built with sees the same snapshot. This is a
			// no-op when the consumer is bound to a different
			// store than the child's file.
			parentConsumer.consume(() => true);

			if (!isProcessAlive(childPid)) break;
			if (Date.now() - start >= timeoutMs) {
				timedOut = true;
				break;
			}
			await sleep(pollIntervalMs);
		}
	} finally {
		await childStore.destroy();
	}

	return { consumed, timedOut };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Extract the absolute path from a `file-content` record's payload.
 * Returns `undefined` for unexpected payload shapes so the caller
 * can skip them rather than throw.
 */
function pathFromPayload(entry: Evidence): string | undefined {
	const payload = entry.payload;
	if (payload === null || typeof payload !== "object") return undefined;
	const candidate = (payload as { path?: unknown }).path;
	if (typeof candidate !== "string") return undefined;
	return candidate;
}

/**
 * Read every evidence record in the child's on-disk file, filtered
 * by `source` when provided. Walks the kinds so callers can use
 * the result without re-iterating.
 */
function collectChildEntries(store: FileSharedEvidenceStore, source: string | undefined): Evidence[] {
	const kinds: Evidence["kind"][] = [
		"file-manifest",
		"syntax-index",
		"reference-result",
		"file-content",
		"compilation-result",
	];
	const out: Evidence[] = [];
	for (const kind of kinds) {
		for (const entry of store.getByKind(kind)) {
			if (source !== undefined && entry.source !== source) continue;
			out.push(entry);
		}
	}
	return out;
}

/**
 * `true` when the process with the given pid is still running.
 * Uses `process.kill(pid, 0)` which sends no signal but throws
 * `ESRCH` if the process is gone.
 */
function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		// EPERM means the process exists but we cannot signal it
		// (different user on POSIX). Treat as alive so we keep
		// polling rather than giving up early.
		if (code === "EPERM") return true;
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * On-disk format version. Must match
 * `FILE_FORMAT_VERSION` in `shared-evidence-ipc.ts`; if that
 * constant moves, bump this in lockstep.
 */
const FILE_FORMAT_VERSION = 1 as const;

interface PersistedFile {
	version: typeof FILE_FORMAT_VERSION;
	entries: Evidence[];
}

/**
 * Persist `entries` to `path` in the `FileSharedEvidenceStore`
 * format. Writes a `{ version, entries }` JSON blob; the child's
 * own `FileSharedEvidenceStore` reads it on construction.
 */
async function writeChildStoreFile(path: string, entries: Evidence[]): Promise<void> {
	const serialized = JSON.stringify({
		version: FILE_FORMAT_VERSION,
		entries,
	} satisfies PersistedFile);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, serialized, "utf-8");
}

/* -------------------------------------------------------------------------- */
/* Convenience: temp store path                                                */
/* -------------------------------------------------------------------------- */

/**
 * Create a unique file path for a subagent evidence store inside
 * the OS temp dir. The file is not created — the store will create
 * it on first write. The returned `cleanup` removes the temp dir
 * and is safe to call after the test, even on failure.
 *
 * Exported so tests do not have to repeat the `mkdtemp` boilerplate.
 */
export async function makeSubagentStorePath(prefix: string): Promise<{
	path: string;
	dir: string;
	cleanup: () => Promise<void>;
}> {
	const dir = await mkdtemp(join(tmpdir(), `subagent-evidence-${prefix}-`));
	const path = join(dir, "evidence.json");
	return {
		path,
		dir,
		cleanup: async () => {
			await rm(dir, { recursive: true, force: true });
		},
	};
}

