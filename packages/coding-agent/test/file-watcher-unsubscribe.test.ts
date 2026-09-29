/**
 * F1 file-watcher — `onEvent()` returns an unsubscribe function.
 *
 * After calling the returned unsubscribe, the handler must not be
 * invoked for subsequent file events even though the watcher is still
 * running.
 */

import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileWatcher, type WatcherEvent } from "../src/core/repository/file-watcher.ts";

import { collectAround, makeTempDir, removeTempDir, touchFile } from "./file-watcher-helpers.ts";

describe("createFileWatcher — unsubscribe", () => {
	let root: string;
	const events: WatcherEvent[] = [];
	const handler = (event: WatcherEvent) => events.push(event);
	let unsubscribe: (() => void) | null = null;
	let watcher: ReturnType<typeof createFileWatcher> | null = null;

	beforeEach(async () => {
		events.length = 0;
		root = await makeTempDir("file-watcher-unsubscribe");
		await touchFile(root, "file.txt", "v0");
		watcher = createFileWatcher({ root, debounceMs: 30 });
		unsubscribe = watcher.onEvent(handler);
		await watcher.start();
		await new Promise((r) => setTimeout(r, 50));
		events.length = 0;
	});

	afterEach(async () => {
		if (watcher) await watcher.stop();
		if (unsubscribe) unsubscribe();
		await removeTempDir(root);
	});

	it("removes the handler after unsubscribe() is called", async () => {
		unsubscribe?.();
		unsubscribe = null;

		const collected = await collectAround(
			events,
			async () => {
				await writeFile(`${root}/file.txt`, "v1", "utf-8");
				await writeFile(`${root}/another.txt`, "new", "utf-8");
			},
			300,
		);
		expect(collected).toEqual([]);
	});
});

