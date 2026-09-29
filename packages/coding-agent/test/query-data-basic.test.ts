/**
 * F1 `query` tool — live data layer, basic build.
 *
 * `createLiveQueryToolData` walks the worktree at construction time
 * (lazily, on the first `getToolData()` call) and returns a snapshot
 * that includes the manifest, the syntax index, the supplied (or
 * mock) semantic adapter, and the resolved root.
 *
 * This file asserts the snapshot shape: a non-empty manifest derived
 * from a temp directory, the supplied adapter is preserved, and the
 * root is the absolute path the caller asked for.
 */

import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveQueryToolData } from "../src/core/repository/query-data.ts";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";

import { makeTempDir, removeTempDir, touchFile } from "./live-manifest-helpers.ts";

describe("createLiveQueryToolData — basic", () => {
	let root: string;

	beforeEach(async () => {
		root = await makeTempDir("query-data-basic");
		await touchFile(root, "a.ts", "export const a = 1;");
		await touchFile(root, "b.ts", "export function b(): number { return 2; }");
	});

	afterEach(async () => {
		await removeTempDir(root);
	});

	it("returns a manifest with the worktree's files", async () => {
		const live = createLiveQueryToolData({ root });
		const data = await live.getToolData();
		const paths = data.manifest.map((entry) => entry.path).sort();
		expect(paths).toContain("a.ts");
		expect(paths).toContain("b.ts");
	});

	it("returns a syntax index with the worktree's symbols", async () => {
		const live = createLiveQueryToolData({ root });
		const data = await live.getToolData();
		const names = data.symbolIndex.map((entry) => entry.name);
		expect(names).toContain("a");
		expect(names).toContain("b");
	});

	it("preserves a caller-supplied adapter", async () => {
		const adapter = new MockSemanticQueryAdapter();
		const live = createLiveQueryToolData({ root, adapter });
		const data = await live.getToolData();
		expect(data.semanticAdapter).toBe(adapter);
	});

	it("uses a mock adapter when none is supplied", async () => {
		const live = createLiveQueryToolData({ root });
		const data = await live.getToolData();
		expect(data.semanticAdapter).toBeInstanceOf(MockSemanticQueryAdapter);
	});

	it("resolves the root to an absolute path", async () => {
		const live = createLiveQueryToolData({ root });
		const data = await live.getToolData();
		expect(data.root).toBe(resolve(root));
	});

	it("skips the syntax index when computeSymbolIndex is false", async () => {
		const live = createLiveQueryToolData({ root, computeSymbolIndex: false });
		const data = await live.getToolData();
		expect(data.symbolIndex).toEqual([]);
		// Manifest is still built.
		expect(data.manifest.length).toBeGreaterThan(0);
	});
});

