/**
 * F1 `query` tool — live data layer, time-based cache.
 *
 * `LiveQueryToolData.getToolData()` should return the cached snapshot
 * without rebuilding as long as the cache is younger than `maxAgeMs`.
 * This file asserts that the second consecutive call returns the
 * same `QueryToolData` object (and therefore the same `manifest`
 * array reference), so callers can detect the no-rebuild path.
 *
 * We also assert that a stale cache — one older than `maxAgeMs` —
 * does trigger a rebuild.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveQueryToolData } from "../src/core/repository/query-data.ts";

import { makeTempDir, removeTempDir, touchFile } from "./live-manifest-helpers.ts";

const EFFECTIVELY_NEVER = 24 * 60 * 60 * 1000;

describe("createLiveQueryToolData — cache", () => {
	let root: string;

	beforeEach(async () => {
		root = await makeTempDir("query-data-cache");
		await touchFile(root, "a.ts", "export const a = 1;");
	});

	afterEach(async () => {
		await removeTempDir(root);
	});

	it("returns the same snapshot on a second call within maxAgeMs", async () => {
		const live = createLiveQueryToolData({ root, maxAgeMs: EFFECTIVELY_NEVER });
		const first = await live.getToolData();
		const second = await live.getToolData();
		expect(second).toBe(first);
	});

	it("returns the same manifest array reference on a cached call", async () => {
		const live = createLiveQueryToolData({ root, maxAgeMs: EFFECTIVELY_NEVER });
		const first = await live.getToolData();
		const second = await live.getToolData();
		expect(second.manifest).toBe(first.manifest);
	});

	it("returns the same symbol index reference on a cached call", async () => {
		const live = createLiveQueryToolData({ root, maxAgeMs: EFFECTIVELY_NEVER });
		const first = await live.getToolData();
		const second = await live.getToolData();
		expect(second.symbolIndex).toBe(first.symbolIndex);
	});

	it("rebuilds when the cache is older than maxAgeMs", async () => {
		// 1ms is the smallest possible window: the second call, even
		// when scheduled immediately, will land on a later Date.now()
		// and trigger a rebuild.
		const live = createLiveQueryToolData({ root, maxAgeMs: 1 });
		const first = await live.getToolData();
		// Yield the event loop a tick so Date.now() advances.
		await new Promise((r) => setTimeout(r, 5));
		const second = await live.getToolData();
		expect(second).not.toBe(first);
		expect(second.manifest).not.toBe(first.manifest);
	});
});

