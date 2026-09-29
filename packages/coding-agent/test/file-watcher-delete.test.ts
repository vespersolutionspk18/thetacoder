/**
 * F1 file-watcher — `delete` event detection.
 *
 * Pre-create a file, start the watcher, then remove the file. Asserts
 * that a `delete` event is observed within 1 second.
 */

import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileWatcher, type WatcherEvent } from "../src/core/repository/file-watcher.ts";

import { collectAround, makeTempDir, removeTempDir, touchFile } from "./file-watcher-helpers.ts";

describe("createFileWatcher — delete event", () => {
	let root: string;
	const events: WatcherEvent[] = [];
	let unsubscribe: (() => void) | null = null;
	let watcher: ReturnType<typeof createFileWatcher> | null = null;

	beforeEach(async () => {
		events.length = 0;
		root = await makeTempDir("file-watcher-delete");
		await touchFile(root, "doomed.txt", "bye");
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

	it("emits a `delete` event when an existing file is removed", async () => {
		const collected = await collectAround(
			events,
			async () => {
				await rm(`${root}/doomed.txt`);
			},
			800,
		);
		const match = collected.find((e) => e.kind === "delete" && e.path === "doomed.txt");
		expect(match).toBeDefined();
		if (match && match.kind === "delete") {
			expect(typeof match.timestamp).toBe("number");
		}
	});
});

