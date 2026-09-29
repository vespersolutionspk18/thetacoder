/**
 * F1 file-watcher — `stop()` halts event delivery.
 *
 * After `stop()` resolves, modifications to the watched root must not
 * produce any further events.
 */

import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileWatcher, type WatcherEvent } from "../src/core/repository/file-watcher.ts";

import { collectAround, makeTempDir, removeTempDir, touchFile } from "./file-watcher-helpers.ts";

describe("createFileWatcher — stop", () => {
	let root: string;
	const events: WatcherEvent[] = [];
	let unsubscribe: (() => void) | null = null;
	let watcher: ReturnType<typeof createFileWatcher> | null = null;

	beforeEach(async () => {
		events.length = 0;
		root = await makeTempDir("file-watcher-stop");
		await touchFile(root, "before-stop.txt", "v0");
		watcher = createFileWatcher({ root, debounceMs: 30 });
		unsubscribe = watcher.onEvent((event) => events.push(event));
		await watcher.start();
		await new Promise((r) => setTimeout(r, 50));
		events.length = 0;
	});

	afterEach(async () => {
		if (watcher) await watcher.stop();
		if (unsubscribe) unsubscribe();
		await removeTempDir(root);
	});

	it("delivers no further events after stop()", async () => {
		await watcher?.stop();
		watcher = null;

		const collected = await collectAround(
			events,
			async () => {
				await writeFile(`${root}/before-stop.txt`, "v1", "utf-8");
				await writeFile(`${root}/after-stop.txt`, "new", "utf-8");
			},
			300,
		);
		expect(collected).toEqual([]);
	});
});

