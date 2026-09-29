/**
 * F1 live manifest — query-boundary hash re-verification.
 *
 * When `verifyOnQuery` is true, every call to `getFile` /
 * `getByLanguage` / `getByPackage` must increment the
 * `getVerificationsCount()` counter. When the flag is false, no
 * re-verification happens.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveManifest } from "../src/core/repository/live-manifest.ts";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";

import { makeFakeWatcher, makeTempDir, removeTempDir, touchFile } from "./live-manifest-helpers.ts";

describe("createLiveManifest — verify on query", () => {
	let root: string;
	let live: ReturnType<typeof createLiveManifest> | null = null;
	const fake = makeFakeWatcher();

	beforeEach(async () => {
		root = await makeTempDir("live-manifest-verify");
		await touchFile(root, "alpha.ts", "alpha-v0");
		await touchFile(root, "beta.ts", "beta-v0");
	});

	afterEach(async () => {
		if (live) live.stop();
		live = null;
		await removeTempDir(root);
	});

	it("increments getVerificationsCount() on getFile when verifyOnQuery is true", async () => {
		const manifest: FileManifestEntry[] = [
			{
				path: "alpha.ts",
				absolutePath: `${root}/alpha.ts`,
				byteLength: 8,
				language: "typescript",
				generated: false,
				ignored: false,
			},
		];
		live = createLiveManifest({ manifest, watcher: fake.watcher, root, verifyOnQuery: true });
		expect(live.getVerificationsCount()).toBe(0);

		live.getFile("alpha.ts");
		live.getFile("alpha.ts");
		live.getFile("alpha.ts");
		// Wait for the three fire-and-forget verifications to settle.
		await new Promise((r) => setTimeout(r, 50));
		expect(live.getVerificationsCount()).toBe(3);
	});

	it("increments once per matching entry on getByLanguage", async () => {
		const manifest: FileManifestEntry[] = [
			{
				path: "alpha.ts",
				absolutePath: `${root}/alpha.ts`,
				byteLength: 8,
				language: "typescript",
				generated: false,
				ignored: false,
			},
			{
				path: "beta.ts",
				absolutePath: `${root}/beta.ts`,
				byteLength: 7,
				language: "typescript",
				generated: false,
				ignored: false,
			},
		];
		live = createLiveManifest({ manifest, watcher: fake.watcher, root, verifyOnQuery: true });
		live.getByLanguage("typescript");
		await new Promise((r) => setTimeout(r, 50));
		expect(live.getVerificationsCount()).toBe(2);
	});

	it("does not verify when verifyOnQuery is false", () => {
		const manifest: FileManifestEntry[] = [
			{
				path: "alpha.ts",
				absolutePath: `${root}/alpha.ts`,
				byteLength: 8,
				language: "typescript",
				generated: false,
				ignored: false,
			},
		];
		live = createLiveManifest({ manifest, watcher: fake.watcher, root, verifyOnQuery: false });
		live.getFile("alpha.ts");
		live.getByLanguage("typescript");
		live.getByPackage("nope");
		expect(live.getVerificationsCount()).toBe(0);
	});

	it("auto-enables verification after an overflow event", async () => {
		const manifest: FileManifestEntry[] = [
			{
				path: "alpha.ts",
				absolutePath: `${root}/alpha.ts`,
				byteLength: 8,
				language: "typescript",
				generated: false,
				ignored: false,
			},
		];
		live = createLiveManifest({ manifest, watcher: fake.watcher, root, verifyOnQuery: false });
		await fake.fire({ kind: "overflow", timestamp: Date.now() });

		live.getFile("alpha.ts");
		await new Promise((r) => setTimeout(r, 50));
		expect(live.getVerificationsCount()).toBe(1);
	});
});

