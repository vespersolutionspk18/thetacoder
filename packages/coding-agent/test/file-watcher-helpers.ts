/**
 * Shared helpers for the file-watcher tests.
 *
 * Kept in a separate module so each test file can `import` the same
 * setup/teardown logic without duplicating boilerplate. Helpers
 * intentionally stay minimal — no test framework abstractions, just
 * `mkdtemp`, `rm`, and a small polling helper that resolves the first
 * time a predicate becomes true.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WatcherEvent } from "../src/core/repository/file-watcher.ts";

/** Create a unique temp dir and return its absolute path. */
export async function makeTempDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), `theta-${prefix}-`));
}

/** Recursively remove a temp dir. Safe to call on a missing path. */
export async function removeTempDir(path: string): Promise<void> {
	await rm(path, { recursive: true, force: true });
}

/** Write `content` to a path inside `root`. */
export async function touchFile(root: string, rel: string, content: string): Promise<string> {
	const absolute = join(root, rel);
	await writeFile(absolute, content, "utf-8");
	return absolute;
}

/** Build a poll-based event waiter. */
export function makeWaiter(
	events: WatcherEvent[],
): (predicate: (event: WatcherEvent) => boolean, timeoutMs?: number) => Promise<WatcherEvent> {
	return (predicate, timeoutMs = 1000) =>
		new Promise<WatcherEvent>((resolvePromise, rejectPromise) => {
			const start = Date.now();
			const check = () => {
				for (const event of events) {
					if (predicate(event)) {
						resolvePromise(event);
						return;
					}
				}
				if (Date.now() - start >= timeoutMs) {
					rejectPromise(
						new Error(
							`Timed out after ${timeoutMs}ms waiting for matching WatcherEvent (received ${events.length})`,
						),
					);
					return;
				}
				setTimeout(check, 10);
			};
			check();
		});
}

/**
 * Collect events produced while `trigger` runs, then for `extraMs` more.
 * Captures the start-length *before* invoking `trigger` so events that
 * arrive synchronously from the OS watcher are not lost.
 */
export async function collectAround(
	events: WatcherEvent[],
	trigger: () => Promise<void> | void,
	extraMs = 0,
): Promise<WatcherEvent[]> {
	const startLength = events.length;
	await trigger();
	if (extraMs <= 0) {
		// Return whatever has already arrived.
		return events.slice(startLength);
	}
	await new Promise((r) => setTimeout(r, extraMs));
	return events.slice(startLength);
}

