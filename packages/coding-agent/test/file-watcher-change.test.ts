/**
 * F1 file-watcher — `change` event detection.
 *
 * Pre-create a file before starting the watcher, then modify it after
 * the watcher is attached. The audit spec treats watcher events as
 * hints, so a missing `change` on some platforms (e.g. Windows when
 * the OS coalesces) should not fail the test — we retry the mutation
 * and accept either a `change` or a series of `change` events.
 */

import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileWatcher, type WatcherEvent } from "../src/core/repository/file-watcher.ts";

import { collectAround, makeTempDir, removeTempDir, touchFile } from "./file-watcher-helpers.ts";

describe("createFileWatcher — change event", () => {
	let root: string;
	const events: WatcherEvent[] = [];
	let unsubscribe: (() => void) | null = null;
	let watcher: ReturnType<typeof createFileWatcher> | null = null;

	beforeEach(async () => {
		events.length = 0;
		root = await makeTempDir("file-watcher-change");
		// Create the target file *before* attaching the watcher so
		// that the test is only measuring modifications, not creation.
		await touchFile(root, "edit.txt", "v0");
		watcher = createFileWatcher({ root, debounceMs: 30 });
		unsubscribe = watcher.onEvent((event) => events.push(event));
		await watcher.start();
		// Give the watcher a moment to settle, then drain startup events.
		await new Promise((r) => setTimeout(r, 50));
		events.length = 0;
	});

	afterEach(async () => {
		if (watcher) await watcher.stop();
		if (unsubscribe) unsubscribe();
		await removeTempDir(root);
	});

	it("emits a `change` event when an existing file is modified", async () => {
		// Re-write the file. A second write guarantees a different
		// size/content on every platform, which avoids the case where
		// the OS coalesces the "no change" and fires nothing.
		const collected = await collectAround(
			events,
			async () => {
				await writeFile(`${root}/edit.txt`, "v1", "utf-8");
				await writeFile(`${root}/edit.txt`, "v2", "utf-8");
			},
			800,
		);
		const match = collected.find((e) => e.kind === "change" && e.path === "edit.txt");
		expect(match).toBeDefined();
		if (match && match.kind === "change") {
			expect(typeof match.timestamp).toBe("number");
		}
	});
});

