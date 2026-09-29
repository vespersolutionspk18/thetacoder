/**
 * F1 file-watcher — `create` event detection.
 *
 * Start a watcher on a temp directory, write a new file, and assert
 * that a `create` event is observed within 1 second. The watcher is
 * torn down on success or failure to avoid leaking file handles.
 */

import { appendFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileWatcher, type WatcherEvent } from "../src/core/repository/file-watcher.ts";

import { collectAround, makeTempDir, removeTempDir, touchFile } from "./file-watcher-helpers.ts";

describe("createFileWatcher — create event", () => {
	let root: string;
	const events: WatcherEvent[] = [];
	let unsubscribe: (() => void) | null = null;
	let watcher: ReturnType<typeof createFileWatcher> | null = null;

	beforeEach(async () => {
		events.length = 0;
		root = await makeTempDir("file-watcher-create");
		watcher = createFileWatcher({ root, debounceMs: 30 });
		unsubscribe = watcher.onEvent((event) => events.push(event));
		await watcher.start();
		// Drain any startup events (none expected on an empty dir, but
		// some platforms emit one when the watcher first attaches).
		await new Promise((r) => setTimeout(r, 50));
		events.length = 0;
	});

	afterEach(async () => {
		if (watcher) await watcher.stop();
		if (unsubscribe) unsubscribe();
		await removeTempDir(root);
	});

	it("emits a `create` event when a new file appears", async () => {
		const collected = await collectAround(
			events,
			async () => {
				await touchFile(root, "new.txt", "hello\n");
			},
			800,
		);

		const createEvents = collected.filter((e) => e.kind === "create");
		expect(createEvents.length).toBeGreaterThan(0);
		const match = createEvents.find((e) => e.kind === "create" && e.path === "new.txt");
		expect(match).toBeDefined();
		if (match && match.kind === "create") {
			expect(typeof match.timestamp).toBe("number");
			expect(match.timestamp).toBeGreaterThan(0);
		}
	});

	it("emits a `create` event for a file written after a small delay", async () => {
		const collected = await collectAround(
			events,
			async () => {
				const filePath = await touchFile(root, "delayed.txt", "x");
				// Append to give the OS time to flush; some platforms
				// (Windows) need a follow-up write to surface the create
				// event.
				await appendFile(filePath, "y");
			},
			800,
		);
		const match = collected.find((e) => e.kind === "create" && e.path === "delayed.txt");
		expect(match).toBeDefined();
	});
});

