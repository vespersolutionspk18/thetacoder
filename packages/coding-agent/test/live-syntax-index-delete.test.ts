/**
 * F1 live syntax index — `delete` event handling.
 *
 * A `delete` event must remove the corresponding file's symbols from
 * the live index. Subsequent lookups by path return `[]` and the
 * symbols are excluded from `getSymbols()`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveSyntaxIndex } from "../src/core/repository/live-syntax-index.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";

import { makeFakeWatcher, makeTempDir, removeTempDir, touchFile } from "./live-syntax-index-helpers.ts";

describe("createLiveSyntaxIndex — delete event", () => {
	let root: string;
	let live: ReturnType<typeof createLiveSyntaxIndex> | null = null;
	const fake = makeFakeWatcher();

	beforeEach(async () => {
		root = await makeTempDir("live-syntax-index-delete");
		await touchFile(root, "doomed.ts", "export const doomed = 1;");
		await touchFile(root, "survivor.ts", "export const survivor = 2;");
	});

	afterEach(async () => {
		if (live) live.stop();
		live = null;
		await removeTempDir(root);
	});

	it("removes the file's symbols when a `delete` event fires", async () => {
		const seed: SymbolEntry[] = [
			{ kind: "variable", name: "doomed", path: "doomed.ts", startLine: 1, endLine: 1, language: "typescript" },
			{
				kind: "variable",
				name: "survivor",
				path: "survivor.ts",
				startLine: 1,
				endLine: 1,
				language: "typescript",
			},
		];
		live = createLiveSyntaxIndex({ index: seed, watcher: fake.watcher, root });

		expect(live.getSymbolsForFile("doomed.ts")).toHaveLength(1);

		await fake.fire({ kind: "delete", path: "doomed.ts", timestamp: Date.now() });

		expect(live.getSymbolsForFile("doomed.ts")).toEqual([]);
		const names = live.getSymbols().map((s) => s.name);
		expect(names).not.toContain("doomed");
		expect(names).toContain("survivor");
	});

	it("tolerates a `delete` for a path that was never tracked", async () => {
		live = createLiveSyntaxIndex({ index: [], watcher: fake.watcher, root });

		await fake.fire({ kind: "delete", path: "never-existed.ts", timestamp: Date.now() });

		expect(live.getSymbols()).toEqual([]);
	});

	it("removes all of a file's symbols when the file had many", async () => {
		const seed: SymbolEntry[] = [
			{ kind: "function", name: "a", path: "multi.ts", startLine: 1, endLine: 1, language: "typescript" },
			{ kind: "function", name: "b", path: "multi.ts", startLine: 2, endLine: 2, language: "typescript" },
			{ kind: "function", name: "c", path: "multi.ts", startLine: 3, endLine: 3, language: "typescript" },
		];
		live = createLiveSyntaxIndex({ index: seed, watcher: fake.watcher, root });
		expect(live.getSymbolsForFile("multi.ts")).toHaveLength(3);

		await fake.fire({ kind: "delete", path: "multi.ts", timestamp: Date.now() });

		expect(live.getSymbolsForFile("multi.ts")).toEqual([]);
	});
});

