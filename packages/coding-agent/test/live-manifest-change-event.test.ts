/**
 * F1 live manifest — `change` event handling.
 *
 * When the watcher reports that an existing file changed, the live
 * manifest must re-read the file from disk and update the entry's
 * `contentHash` (and `byteLength`) to reflect the new contents.
 */

import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveManifest } from "../src/core/repository/live-manifest.ts";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";

import { makeFakeWatcher, makeTempDir, removeTempDir, sha256OfString, touchFile } from "./live-manifest-helpers.ts";

describe("createLiveManifest — change event", () => {
	let root: string;
	let live: ReturnType<typeof createLiveManifest> | null = null;
	const fake = makeFakeWatcher();

	beforeEach(async () => {
		root = await makeTempDir("live-manifest-change");
		await touchFile(root, "edit.txt", "v0");
	});

	afterEach(async () => {
		if (live) live.stop();
		live = null;
		await removeTempDir(root);
	});

	it("updates the entry's contentHash when a `change` event fires", async () => {
		const initialHash = sha256OfString("v0");
		const manifest: FileManifestEntry[] = [
			{
				path: "edit.txt",
				absolutePath: `${root}/edit.txt`,
				byteLength: 2,
				contentHash: initialHash,
				language: null,
				generated: false,
				ignored: false,
			},
		];
		live = createLiveManifest({ manifest, watcher: fake.watcher, root, verifyOnQuery: false });

		// Mutate the file on disk.
		await writeFile(`${root}/edit.txt`, "version-1-payload", "utf-8");

		// Fire the change event. The fake watcher awaits handlers, so
		// the entry is fully refreshed by the time `fire` resolves.
		await fake.fire({ kind: "change", path: "edit.txt", timestamp: Date.now() });

		const entry = live.getFile("edit.txt");
		expect(entry).toBeDefined();
		expect(entry?.contentHash).toBe(sha256OfString("version-1-payload"));
		expect(entry?.byteLength).toBe("version-1-payload".length);
	});

	it("removes the entry when the file disappears between event and read", async () => {
		const initialHash = sha256OfString("v0");
		const manifest: FileManifestEntry[] = [
			{
				path: "edit.txt",
				absolutePath: `${root}/edit.txt`,
				byteLength: 2,
				contentHash: initialHash,
				language: null,
				generated: false,
				ignored: false,
			},
		];
		live = createLiveManifest({ manifest, watcher: fake.watcher, root, verifyOnQuery: false });

		// Delete the file on disk before the change event reaches us.
		const { rm } = await import("node:fs/promises");
		await rm(`${root}/edit.txt`, { force: true });

		await fake.fire({ kind: "change", path: "edit.txt", timestamp: Date.now() });

		expect(live.getFile("edit.txt")).toBeUndefined();
	});
});

