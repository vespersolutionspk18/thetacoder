/**
 * F1 live manifest — `rename` event handling.
 *
 * A `rename` event carries both an `oldPath` (gone) and a `newPath`
 * (present). The live manifest must drop the old entry and add a new
 * one for the new path, populated from the on-disk file.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveManifest } from "../src/core/repository/live-manifest.ts";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";

import { makeFakeWatcher, makeTempDir, removeTempDir, sha256OfString } from "./live-manifest-helpers.ts";

describe("createLiveManifest — rename event", () => {
	let root: string;
	let live: ReturnType<typeof createLiveManifest> | null = null;
	const fake = makeFakeWatcher();

	beforeEach(async () => {
		root = await makeTempDir("live-manifest-rename");
	});

	afterEach(async () => {
		if (live) live.stop();
		live = null;
		await removeTempDir(root);
	});

	it("removes the old entry and adds a new entry for the new path", async () => {
		// The new-path file already exists on disk; the rename event
		// tells us the new path, and the live manifest re-reads it.
		await writeFile(`${root}/renamed.ts`, "export const y = 7;", "utf-8");

		const manifest: FileManifestEntry[] = [
			{
				path: "old.ts",
				absolutePath: join(root, "old.ts"),
				byteLength: 0,
				language: "typescript",
				generated: false,
				ignored: false,
			},
		];
		live = createLiveManifest({ manifest, watcher: fake.watcher, root, verifyOnQuery: false });

		await fake.fire({
			kind: "rename",
			oldPath: "old.ts",
			newPath: "renamed.ts",
			timestamp: Date.now(),
		});

		expect(live.getFile("old.ts")).toBeUndefined();
		const entry = live.getFile("renamed.ts");
		expect(entry).toBeDefined();
		expect(entry?.path).toBe("renamed.ts");
		expect(entry?.absolutePath).toBe(join(root, "renamed.ts"));
		expect(entry?.contentHash).toBe(sha256OfString("export const y = 7;"));
		expect(entry?.language).toBe("typescript");
	});

	it("drops the old entry even if the new file is not on disk", async () => {
		const manifest: FileManifestEntry[] = [
			{
				path: "old.ts",
				absolutePath: join(root, "old.ts"),
				byteLength: 0,
				language: "typescript",
				generated: false,
				ignored: false,
			},
		];
		live = createLiveManifest({ manifest, watcher: fake.watcher, root, verifyOnQuery: false });

		await fake.fire({
			kind: "rename",
			oldPath: "old.ts",
			newPath: "missing.ts",
			timestamp: Date.now(),
		});

		expect(live.getFile("old.ts")).toBeUndefined();
		expect(live.getFile("missing.ts")).toBeUndefined();
		expect(live.getEntries()).toEqual([]);
	});
});

