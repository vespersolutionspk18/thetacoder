/**
 * F1 live manifest — `delete` event handling.
 *
 * A `delete` event must remove the corresponding entry from the live
 * manifest. Subsequent lookups by path return `undefined` and the
 * entry is excluded from `getEntries()`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveManifest } from "../src/core/repository/live-manifest.ts";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";

import { makeFakeWatcher, makeTempDir, removeTempDir, touchFile } from "./live-manifest-helpers.ts";

describe("createLiveManifest — delete event", () => {
	let root: string;
	let live: ReturnType<typeof createLiveManifest> | null = null;
	const fake = makeFakeWatcher();

	beforeEach(async () => {
		root = await makeTempDir("live-manifest-delete");
		await touchFile(root, "doomed.txt", "bye");
		await touchFile(root, "survivor.txt", "still here");
	});

	afterEach(async () => {
		if (live) live.stop();
		live = null;
		await removeTempDir(root);
	});

	it("removes the entry when a `delete` event fires", async () => {
		const manifest: FileManifestEntry[] = [
			{
				path: "doomed.txt",
				absolutePath: `${root}/doomed.txt`,
				byteLength: 3,
				language: null,
				generated: false,
				ignored: false,
			},
			{
				path: "survivor.txt",
				absolutePath: `${root}/survivor.txt`,
				byteLength: 10,
				language: null,
				generated: false,
				ignored: false,
			},
		];
		live = createLiveManifest({ manifest, watcher: fake.watcher, root, verifyOnQuery: false });

		expect(live.getFile("doomed.txt")).toBeDefined();

		await fake.fire({ kind: "delete", path: "doomed.txt", timestamp: Date.now() });

		expect(live.getFile("doomed.txt")).toBeUndefined();
		const paths = live.getEntries().map((e) => e.path);
		expect(paths).toEqual(["survivor.txt"]);
	});

	it("tolerates a `delete` for a path that was never tracked", async () => {
		live = createLiveManifest({ manifest: [], watcher: fake.watcher, root, verifyOnQuery: false });

		await fake.fire({ kind: "delete", path: "never-existed.txt", timestamp: Date.now() });

		expect(live.getEntries()).toEqual([]);
	});
});

