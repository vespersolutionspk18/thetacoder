/**
 * F1 live manifest — `overflow` event handling.
 *
 * The audit specifies that after a watcher overflow the live manifest
 * must auto-enable `verifyOnQuery` so that subsequent queries
 * re-validate entries against disk. `reconcile()` clears the flag once
 * a clean baseline is re-established.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveManifest } from "../src/core/repository/live-manifest.ts";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";

import { makeFakeWatcher, makeTempDir, removeTempDir, touchFile } from "./live-manifest-helpers.ts";

describe("createLiveManifest — overflow event", () => {
	let root: string;
	let live: ReturnType<typeof createLiveManifest> | null = null;
	const fake = makeFakeWatcher();

	beforeEach(async () => {
		root = await makeTempDir("live-manifest-overflow");
		await touchFile(root, "a.txt", "a");
	});

	afterEach(async () => {
		if (live) live.stop();
		live = null;
		await removeTempDir(root);
	});

	it("auto-enables verifyOnQuery when an overflow event fires", async () => {
		const manifest: FileManifestEntry[] = [
			{
				path: "a.txt",
				absolutePath: `${root}/a.txt`,
				byteLength: 1,
				language: null,
				generated: false,
				ignored: false,
			},
		];
		// Start with verification explicitly off, so the change to
		// `true` can be observed.
		live = createLiveManifest({ manifest, watcher: fake.watcher, root, verifyOnQuery: false });
		expect(live.isVerifyOnQuery()).toBe(false);

		await fake.fire({ kind: "overflow", timestamp: Date.now() });

		expect(live.isVerifyOnQuery()).toBe(true);
	});

	it("forces verifyOnQuery back to true after overflow, even if reconcile cleared it earlier", async () => {
		const manifest: FileManifestEntry[] = [
			{
				path: "a.txt",
				absolutePath: `${root}/a.txt`,
				byteLength: 1,
				language: null,
				generated: false,
				ignored: false,
			},
		];
		live = createLiveManifest({ manifest, watcher: fake.watcher, root, verifyOnQuery: false });
		await fake.fire({ kind: "overflow", timestamp: Date.now() });
		expect(live.isVerifyOnQuery()).toBe(true);
		await live.reconcile();
		expect(live.isVerifyOnQuery()).toBe(false);

		await fake.fire({ kind: "overflow", timestamp: Date.now() });
		expect(live.isVerifyOnQuery()).toBe(true);
	});
});

