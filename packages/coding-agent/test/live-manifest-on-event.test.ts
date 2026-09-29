/**
 * F1 live manifest — `onEvent` subscription.
 *
 * The `onEvent` method must let callers subscribe to invalidation
 * events propagated by the underlying watcher. The returned function
 * unsubscribes the handler.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WatcherEvent } from "../src/core/repository/file-watcher.ts";
import { createLiveManifest } from "../src/core/repository/live-manifest.ts";

import { makeFakeWatcher, makeTempDir, removeTempDir, touchFile } from "./live-manifest-helpers.ts";

describe("createLiveManifest — onEvent subscription", () => {
	let root: string;
	let live: ReturnType<typeof createLiveManifest> | null = null;
	const fake = makeFakeWatcher();

	beforeEach(async () => {
		root = await makeTempDir("live-manifest-on-event");
		await touchFile(root, "a.txt", "a");
	});

	afterEach(async () => {
		if (live) live.stop();
		live = null;
		await removeTempDir(root);
	});

	it("delivers invalidation events to onEvent subscribers", async () => {
		live = createLiveManifest({
			manifest: [
				{
					path: "a.txt",
					absolutePath: `${root}/a.txt`,
					byteLength: 1,
					language: null,
					generated: false,
					ignored: false,
				},
			],
			watcher: fake.watcher,
			root,
			verifyOnQuery: false,
		});

		const received: WatcherEvent[] = [];
		live.onEvent((event) => received.push(event));

		await fake.fire({ kind: "change", path: "a.txt", timestamp: 111 });
		await fake.fire({ kind: "delete", path: "a.txt", timestamp: 222 });
		await fake.fire({ kind: "overflow", timestamp: 333 });

		expect(received).toEqual([
			{ kind: "change", path: "a.txt", timestamp: 111 },
			{ kind: "delete", path: "a.txt", timestamp: 222 },
			{ kind: "overflow", timestamp: 333 },
		]);
	});

	it("returns an unsubscribe function that detaches the handler", async () => {
		live = createLiveManifest({ manifest: [], watcher: fake.watcher, root, verifyOnQuery: false });
		const received: WatcherEvent[] = [];
		const unsubscribe = live.onEvent((event) => received.push(event));

		await fake.fire({ kind: "change", path: "a.txt", timestamp: 1 });
		unsubscribe();
		await fake.fire({ kind: "change", path: "b.txt", timestamp: 2 });

		expect(received).toEqual([{ kind: "change", path: "a.txt", timestamp: 1 }]);
	});

	it("supports multiple concurrent subscribers", async () => {
		live = createLiveManifest({ manifest: [], watcher: fake.watcher, root, verifyOnQuery: false });
		const a: WatcherEvent[] = [];
		const b: WatcherEvent[] = [];
		live.onEvent((event) => a.push(event));
		live.onEvent((event) => b.push(event));

		await fake.fire({ kind: "overflow", timestamp: 42 });

		expect(a).toEqual([{ kind: "overflow", timestamp: 42 }]);
		expect(b).toEqual([{ kind: "overflow", timestamp: 42 }]);
	});
});

