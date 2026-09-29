/**
 * F1 file-watcher — debounce coalescing.
 *
 * Five rapid modifications to the same path inside a 50ms window must
 * collapse to a single `change` event.
 */

import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileWatcher, type WatcherEvent } from "../src/core/repository/file-watcher.ts";

import { collectAround, makeTempDir, removeTempDir, touchFile } from "./file-watcher-helpers.ts";

describe("createFileWatcher — debounce", () => {
	let root: string;
	const events: WatcherEvent[] = [];
	let unsubscribe: (() => void) | null = null;
	let watcher: ReturnType<typeof createFileWatcher> | null = null;

	beforeEach(async () => {
		events.length = 0;
		root = await makeTempDir("file-watcher-debounce");
		await touchFile(root, "rapid.txt", "v0");
		watcher = createFileWatcher({ root, debounceMs: 50 });
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

	it("collapses 5 rapid modifications into a single event", async () => {
		const target = `${root}/rapid.txt`;
		const collected = await collectAround(
			events,
			async () => {
				for (let i = 1; i <= 5; i += 1) {
					await writeFile(target, `v${i}`, "utf-8");
				}
			},
			300,
		);

		const rapidEvents = collected.filter(
			(e): e is Extract<WatcherEvent, { kind: "change" | "create" | "delete" }> =>
				e.kind === "change" && e.path === "rapid.txt",
		);
		expect(rapidEvents.length).toBe(1);
		expect(rapidEvents[0].kind).toBe("change");
	});
});

