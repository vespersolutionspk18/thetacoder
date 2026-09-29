/**
 * Shared helpers for the live-manifest tests.
 *
 * Provides:
 *  - `makeFakeWatcher()` — a deterministic `FileWatcher` stub whose
 *    `fire()` method invokes all registered handlers (awaiting each one
 *    in turn) so tests can assert on the post-event state without races.
 *  - `makeTempDir()` / `removeTempDir()` / `touchFile()` — temp-dir
 *    utilities mirroring the file-watcher test helpers.
 *  - `sha256OfString()` — compute the SHA-256 hex digest of a string,
 *    matching the algorithm the live manifest uses internally.
 *  - `waitForVerifications()` — poll a live-manifest's verification
 *    counter until it reaches a target value.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FileWatcher, WatcherEvent } from "../src/core/repository/file-watcher.ts";
import type { LiveManifest } from "../src/core/repository/live-manifest.ts";

/* -------------------------------------------------------------------------- */
/* Temp dir helpers                                                           */
/* -------------------------------------------------------------------------- */

/** Create a unique temp dir and return its absolute path. */
export async function makeTempDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), `theta-${prefix}-`));
}

/** Recursively remove a temp dir. Safe to call on a missing path. */
export async function removeTempDir(path: string): Promise<void> {
	await rm(path, { recursive: true, force: true });
}

/** Write `content` to a file inside `root` and return the absolute path. */
export async function touchFile(root: string, rel: string, content: string): Promise<string> {
	const absolute = join(root, rel);
	await writeFile(absolute, content, "utf-8");
	return absolute;
}

/* -------------------------------------------------------------------------- */
/* Hashing                                                                    */
/* -------------------------------------------------------------------------- */

/** Compute the SHA-256 hex digest of a string. */
export function sha256OfString(content: string): string {
	return createHash("sha256").update(content, "utf-8").digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Fake FileWatcher                                                            */
/* -------------------------------------------------------------------------- */

export interface FakeWatcher {
	watcher: FileWatcher;
	/** Deliver `event` to every registered handler, awaiting each. */
	fire(event: WatcherEvent): Promise<void>;
	/** Number of times the underlying `start()` was called. */
	readonly startCalls: number;
	/** Number of times the underlying `stop()` was called. */
	readonly stopCalls: number;
	/** True after the first `start()` resolves. */
	isStarted(): boolean;
	/** True after the first `stop()` resolves. */
	isStopped(): boolean;
}

/**
 * Build a fake `FileWatcher` that records its lifecycle calls and
 * lets the test fire events at will. Handler invocation is awaited so
 * the caller's post-event assertions see the resulting state.
 */
export function makeFakeWatcher(): FakeWatcher {
	const handlers = new Set<(event: WatcherEvent) => void | Promise<void>>();
	let started = false;
	let stopped = false;
	let startCalls = 0;
	let stopCalls = 0;

	const watcher: FileWatcher = {
		start: async () => {
			startCalls += 1;
			started = true;
		},
		stop: async () => {
			stopCalls += 1;
			stopped = true;
		},
		onEvent: (handler) => {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		onError: () => {
			return () => {};
		},
	};

	const fake: FakeWatcher = {
		watcher,
		fire: async (event) => {
			// Snapshot to allow safe unsubscribe during dispatch.
			const snapshot = Array.from(handlers);
			for (const handler of snapshot) {
				try {
					await handler(event);
				} catch {
					// Swallow handler errors so one bad handler does not
					// prevent the rest of the pipeline from observing
					// the event. The real `FileWatcher` does the same.
				}
			}
		},
		startCalls: 0,
		stopCalls: 0,
		isStarted: () => started,
		isStopped: () => stopped,
	};
	Object.defineProperty(fake, "startCalls", { get: () => startCalls });
	Object.defineProperty(fake, "stopCalls", { get: () => stopCalls });
	return fake;
}

/* -------------------------------------------------------------------------- */
/* Polling helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Poll `live.getVerificationsCount()` until it reaches `target`, or
 * fail after `timeoutMs`. Used to wait for fire-and-forget query
 * verifications to settle.
 */
export async function waitForVerifications(live: LiveManifest, target: number, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (live.getVerificationsCount() < target) {
		if (Date.now() - start >= timeoutMs) {
			throw new Error(
				`Timed out after ${timeoutMs}ms waiting for verifications to reach ${target} (got ${live.getVerificationsCount()})`,
			);
		}
		await new Promise((r) => setTimeout(r, 5));
	}
}

