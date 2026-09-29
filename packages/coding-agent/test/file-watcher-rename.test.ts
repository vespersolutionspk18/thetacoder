/**
 * F1 file-watcher — `rename` event detection.
 *
 * Pre-create a file, start the watcher, then rename it. Asserts that a
 * `rename` event with both `oldPath` and `newPath` is observed. The
 * watcher pairs the underlying delete + create that the OS reports as
 * a single `rename` event when both happen in the same directory
 * within the pairing window.
 */

import { rename } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileWatcher, type WatcherEvent } from "../src/core/repository/file-watcher.ts";

import { collectAround, makeTempDir, removeTempDir, touchFile } from "./file-watcher-helpers.ts";

describe("createFileWatcher — rename event", () => {
	let root: string;
	const events: WatcherEvent[] = [];
	let unsubscribe: (() => void) | null = null;
	let watcher: ReturnType<typeof createFileWatcher> | null = null;

	beforeEach(async () => {
		events.length = 0;
		root = await makeTempDir("file-watcher-rename");
		await touchFile(root, "before.txt", "x");
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

	it("emits a `rename` event when a file is renamed in the same directory", async () => {
		const collected = await collectAround(
			events,
			async () => {
				await rename(`${root}/before.txt`, `${root}/after.txt`);
			},
			800,
		);
		const match = collected.find((e) => e.kind === "rename");
		expect(match).toBeDefined();
		if (match && match.kind === "rename") {
			expect(match.oldPath).toBe("before.txt");
			expect(match.newPath).toBe("after.txt");
		}
	});
});

