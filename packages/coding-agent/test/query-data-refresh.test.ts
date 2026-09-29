/**
 * F1 `query` tool — live data layer, manual refresh.
 *
 * `LiveQueryToolData.refresh()` forces a rebuild. The new snapshot
 * must reflect the on-disk state at the time of the call — files
 * added after the initial `getToolData()` should appear after a
 * refresh, and each refresh must yield a distinct `QueryToolData`
 * object (so callers can detect the rebuild).
 *
 * Each test passes a `maxAgeMs` larger than any plausible test
 * duration so the only thing that triggers a rebuild is the
 * explicit `refresh()` call.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveQueryToolData } from "../src/core/repository/query-data.ts";

import { makeTempDir, removeTempDir, touchFile } from "./live-manifest-helpers.ts";

const EFFECTIVELY_NEVER = 24 * 60 * 60 * 1000;

describe("createLiveQueryToolData — refresh", () => {
	let root: string;

	beforeEach(async () => {
		root = await makeTempDir("query-data-refresh");
		await touchFile(root, "a.ts", "export const a = 1;");
	});

	afterEach(async () => {
		await removeTempDir(root);
	});

	it("returns a new QueryToolData object after refresh", async () => {
		const live = createLiveQueryToolData({ root, maxAgeMs: EFFECTIVELY_NEVER });
		const first = await live.getToolData();
		await live.refresh();
		const second = await live.getToolData();
		expect(second).not.toBe(first);
	});

	it("returns a new manifest array after refresh", async () => {
		const live = createLiveQueryToolData({ root, maxAgeMs: EFFECTIVELY_NEVER });
		const first = await live.getToolData();
		await live.refresh();
		const second = await live.getToolData();
		expect(second.manifest).not.toBe(first.manifest);
	});

	it("picks up files added after the initial build", async () => {
		const live = createLiveQueryToolData({ root, maxAgeMs: EFFECTIVELY_NEVER });
		const before = await live.getToolData();
		const beforePaths = before.manifest.map((entry) => entry.path);
		expect(beforePaths).toContain("a.ts");
		expect(beforePaths).not.toContain("new.ts");

		await touchFile(root, "new.ts", "export const nu = 3;");
		await live.refresh();

		const after = await live.getToolData();
		const afterPaths = after.manifest.map((entry) => entry.path);
		expect(afterPaths).toContain("a.ts");
		expect(afterPaths).toContain("new.ts");
	});

	it("can be called multiple times in a row", async () => {
		const live = createLiveQueryToolData({ root, maxAgeMs: EFFECTIVELY_NEVER });
		await live.getToolData();
		await live.refresh();
		await live.refresh();
		const data = await live.getToolData();
		expect(data.manifest.length).toBeGreaterThan(0);
	});
});

