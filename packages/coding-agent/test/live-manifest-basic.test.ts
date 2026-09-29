/**
 * F1 live manifest — initial state.
 *
 * Building a `LiveManifest` from a non-empty manifest must expose those
 * entries verbatim through `getEntries()`. The initial copy must be
 * defensive: mutating the caller's array afterward must not affect the
 * live view.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveManifest } from "../src/core/repository/live-manifest.ts";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";

import { makeFakeWatcher, makeTempDir, removeTempDir, touchFile } from "./live-manifest-helpers.ts";

describe("createLiveManifest — basic", () => {
	let root: string;
	let live: ReturnType<typeof createLiveManifest> | null = null;
	const fake = makeFakeWatcher();

	beforeEach(async () => {
		root = await makeTempDir("live-manifest-basic");
		await touchFile(root, "a.ts", "export const a = 1;");
		await touchFile(root, "b.ts", "export const b = 2;");
	});

	afterEach(async () => {
		if (live) live.stop();
		live = null;
		await removeTempDir(root);
	});

	it("returns the initial entries via getEntries()", () => {
		const manifest: FileManifestEntry[] = [
			{
				path: "a.ts",
				absolutePath: `${root}/a.ts`,
				byteLength: 20,
				contentHash: "hash-a",
				language: "typescript",
				generated: false,
				ignored: false,
			},
			{
				path: "b.ts",
				absolutePath: `${root}/b.ts`,
				byteLength: 20,
				contentHash: "hash-b",
				language: "typescript",
				generated: false,
				ignored: false,
			},
		];
		live = createLiveManifest({ manifest, watcher: fake.watcher, root });
		const entries = live.getEntries();
		expect(entries).toHaveLength(2);
		const paths = entries.map((e) => e.path).sort();
		expect(paths).toEqual(["a.ts", "b.ts"]);
	});

	it("returns the same entries across repeated getEntries() calls", () => {
		const manifest: FileManifestEntry[] = [
			{
				path: "a.ts",
				absolutePath: `${root}/a.ts`,
				byteLength: 20,
				language: "typescript",
				generated: false,
				ignored: false,
			},
		];
		live = createLiveManifest({ manifest, watcher: fake.watcher, root });
		const first = live.getEntries();
		const second = live.getEntries();
		expect(first.map((e) => e.path)).toEqual(["a.ts"]);
		expect(second.map((e) => e.path)).toEqual(["a.ts"]);
	});

	it("does not alias the caller's manifest array", () => {
		const manifest: FileManifestEntry[] = [
			{
				path: "a.ts",
				absolutePath: `${root}/a.ts`,
				byteLength: 20,
				language: "typescript",
				generated: false,
				ignored: false,
			},
		];
		live = createLiveManifest({ manifest, watcher: fake.watcher, root });
		// Mutate the caller's array after construction.
		manifest.push({
			path: "intruder.ts",
			absolutePath: `${root}/intruder.ts`,
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		});
		const paths = live.getEntries().map((e) => e.path);
		expect(paths).toEqual(["a.ts"]);
	});

	it("returns no entries when the initial manifest is empty", () => {
		live = createLiveManifest({ manifest: [], watcher: fake.watcher, root });
		expect(live.getEntries()).toEqual([]);
	});
});

