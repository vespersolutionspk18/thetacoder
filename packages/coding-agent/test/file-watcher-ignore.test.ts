/**
 * F1 file-watcher — ignored-pattern filtering.
 *
 * Configures the watcher with a single `*.tmp` pattern, creates a
 * matching file, and asserts that no event is produced. Then creates
 * a `.ts` file and asserts a normal `create` event is observed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileWatcher, type WatcherEvent } from "../src/core/repository/file-watcher.ts";

import { collectAround, makeTempDir, removeTempDir, touchFile } from "./file-watcher-helpers.ts";

describe("createFileWatcher — ignored patterns", () => {
	let root: string;
	const events: WatcherEvent[] = [];
	let unsubscribe: (() => void) | null = null;
	let watcher: ReturnType<typeof createFileWatcher> | null = null;

	beforeEach(async () => {
		events.length = 0;
		root = await makeTempDir("file-watcher-ignore");
		watcher = createFileWatcher({
			root,
			ignored: ["*.tmp"],
			debounceMs: 30,
		});
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

	it("does not emit events for ignored files", async () => {
		const collected = await collectAround(
			events,
			async () => {
				await touchFile(root, "scratch.tmp", "ignored");
			},
			400,
		);
		expect(collected).toEqual([]);
	});

	it("still emits events for non-ignored files", async () => {
		const collected = await collectAround(
			events,
			async () => {
				await touchFile(root, "keep.ts", "export const x = 1;\n");
			},
			800,
		);
		const match = collected.find((e) => e.kind === "create" && e.path === "keep.ts");
		expect(match).toBeDefined();
	});
});

