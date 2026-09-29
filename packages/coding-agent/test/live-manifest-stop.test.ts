/**
 * F1 live manifest — `stop()` halts the underlying watcher.
 *
 * After `stop()` returns, the underlying `FileWatcher.stop()` must
 * have been invoked. Subsequent events delivered by the watcher must
 * not affect the live manifest's state, because the subscription has
 * been torn down.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLiveManifest } from "../src/core/repository/live-manifest.ts";

import { makeFakeWatcher, makeTempDir, removeTempDir, touchFile } from "./live-manifest-helpers.ts";

describe("createLiveManifest — stop", () => {
	let root: string;
	let fake: ReturnType<typeof makeFakeWatcher>;

	beforeEach(async () => {
		root = await makeTempDir("live-manifest-stop");
		await touchFile(root, "a.txt", "a");
		fake = makeFakeWatcher();
	});

	afterEach(async () => {
		await removeTempDir(root);
	});

	it("calls the underlying watcher's stop() exactly once", () => {
		const live = createLiveManifest({
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

		expect(fake.stopCalls).toBe(0);
		live.stop();
		// The underlying watcher's stop() is async; give it a tick to run.
		return new Promise<void>((resolveFn) => {
			const check = () => {
				if (fake.stopCalls >= 1) {
					expect(fake.stopCalls).toBe(1);
					resolveFn();
					return;
				}
				setTimeout(check, 5);
			};
			check();
		});
	});

	it("is idempotent — calling stop() twice does not re-invoke watcher.stop()", async () => {
		const live = createLiveManifest({
			manifest: [],
			watcher: fake.watcher,
			root,
			verifyOnQuery: false,
		});

		live.stop();
		live.stop();
		await new Promise((r) => setTimeout(r, 20));
		expect(fake.stopCalls).toBe(1);
	});

	it("detaches the watcher subscription so further events are ignored", async () => {
		const live = createLiveManifest({
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

		live.stop();
		// Even though we fire a change event after stop(), the entry
		// must not be refreshed because the handler is detached.
		await fake.fire({ kind: "change", path: "a.txt", timestamp: 1 });
		const entry = live.getFile("a.txt");
		expect(entry).toBeDefined();
		// The original byteLength / language are preserved.
		expect(entry?.byteLength).toBe(1);
	});
});

