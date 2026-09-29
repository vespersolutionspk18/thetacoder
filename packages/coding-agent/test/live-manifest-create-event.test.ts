/**
 * F1 live manifest — `create` event handling.
 *
 * A `create` event for a previously-unknown file must add a fresh
 * entry to the live manifest, populated with the on-disk hash, size,
 * language, and the always-derived `generated` / `ignored` flags.
 */

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLiveManifest } from "../src/core/repository/live-manifest.ts";

import { makeFakeWatcher, makeTempDir, removeTempDir, sha256OfString, touchFile } from "./live-manifest-helpers.ts";

describe("createLiveManifest — create event", () => {
	let root: string;
	let live: ReturnType<typeof createLiveManifest> | null = null;
	const fake = makeFakeWatcher();

	beforeEach(async () => {
		root = await makeTempDir("live-manifest-create");
	});

	afterEach(async () => {
		if (live) live.stop();
		live = null;
		await removeTempDir(root);
	});

	it("adds a new entry when a `create` event fires for a new file", async () => {
		await touchFile(root, "new.ts", "export const x = 42;");

		live = createLiveManifest({ manifest: [], watcher: fake.watcher, root, verifyOnQuery: false });
		expect(live.getFile("new.ts")).toBeUndefined();

		await fake.fire({ kind: "create", path: "new.ts", timestamp: Date.now() });

		const entry = live.getFile("new.ts");
		expect(entry).toBeDefined();
		expect(entry?.path).toBe("new.ts");
		expect(entry?.absolutePath).toBe(join(root, "new.ts"));
		expect(entry?.byteLength).toBe("export const x = 42;".length);
		expect(entry?.contentHash).toBe(sha256OfString("export const x = 42;"));
		expect(entry?.language).toBe("typescript");
		expect(entry?.generated).toBe(false);
		expect(entry?.ignored).toBe(false);
	});

	it("does not insert an entry when the file is missing on disk", async () => {
		live = createLiveManifest({ manifest: [], watcher: fake.watcher, root, verifyOnQuery: false });

		await fake.fire({ kind: "create", path: "ghost.ts", timestamp: Date.now() });

		expect(live.getFile("ghost.ts")).toBeUndefined();
		expect(live.getEntries()).toEqual([]);
	});
});

