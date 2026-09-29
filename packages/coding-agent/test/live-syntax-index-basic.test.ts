/**
 * F1 live syntax index — initial state.
 *
 * Constructing a `LiveSyntaxIndex` from a non-empty `SymbolEntry[]`
 * must expose those symbols verbatim through `getSymbols()` and
 * `getSymbolsForFile()`. The initial copy must be defensive:
 * mutating the caller's array afterward must not affect the live
 * view.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveSyntaxIndex } from "../src/core/repository/live-syntax-index.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";

import { makeFakeWatcher, makeTempDir, removeTempDir, touchFile } from "./live-syntax-index-helpers.ts";

function makeSymbol(overrides: Partial<SymbolEntry> & { name: string; path: string }): SymbolEntry {
	return {
		kind: "function",
		startLine: 1,
		endLine: 1,
		language: "typescript",
		...overrides,
	};
}

describe("createLiveSyntaxIndex — basic", () => {
	let root: string;
	let live: ReturnType<typeof createLiveSyntaxIndex> | null = null;
	const fake = makeFakeWatcher();

	beforeEach(async () => {
		root = await makeTempDir("live-syntax-index-basic");
		// Create the file so the language can be detected from the path
		// on a re-extract. (The seed symbols below are used directly;
		// the file is only here so the resolver doesn't see a missing
		// path on the very first construction.)
		await touchFile(root, "a.ts", "export function alpha(): number { return 1; }");
		await touchFile(root, "b.ts", "export function beta(): number { return 2; }");
	});

	afterEach(async () => {
		if (live) live.stop();
		live = null;
		await removeTempDir(root);
	});

	it("returns the initial symbols via getSymbols()", () => {
		const index: SymbolEntry[] = [
			makeSymbol({ name: "alpha", path: "a.ts", startLine: 1, endLine: 3 }),
			makeSymbol({ name: "beta", path: "b.ts", startLine: 1, endLine: 3 }),
		];
		live = createLiveSyntaxIndex({ index, watcher: fake.watcher, root });
		const symbols = live.getSymbols();
		expect(symbols).toHaveLength(2);
		const names = symbols.map((s) => s.name).sort();
		expect(names).toEqual(["alpha", "beta"]);
	});

	it("returns the same symbols across repeated getSymbols() calls", () => {
		const index: SymbolEntry[] = [makeSymbol({ name: "alpha", path: "a.ts" })];
		live = createLiveSyntaxIndex({ index, watcher: fake.watcher, root });
		const first = live.getSymbols();
		const second = live.getSymbols();
		expect(first.map((s) => s.name)).toEqual(["alpha"]);
		expect(second.map((s) => s.name)).toEqual(["alpha"]);
	});

	it("does not alias the caller's index array", () => {
		const index: SymbolEntry[] = [makeSymbol({ name: "alpha", path: "a.ts" })];
		live = createLiveSyntaxIndex({ index, watcher: fake.watcher, root });
		// Mutate the caller's array after construction.
		index.push(makeSymbol({ name: "intruder", path: "intruder.ts" }));
		const names = live.getSymbols().map((s) => s.name);
		expect(names).toEqual(["alpha"]);
	});

	it("returns no symbols when the initial index is empty", () => {
		live = createLiveSyntaxIndex({ index: [], watcher: fake.watcher, root });
		expect(live.getSymbols()).toEqual([]);
	});

	it("getSymbolsForFile() returns only entries whose path matches", () => {
		const index: SymbolEntry[] = [
			makeSymbol({ name: "alpha", path: "a.ts" }),
			makeSymbol({ name: "alpha2", path: "a.ts", startLine: 5 }),
			makeSymbol({ name: "beta", path: "b.ts" }),
		];
		live = createLiveSyntaxIndex({ index, watcher: fake.watcher, root });
		const aSyms = live.getSymbolsForFile("a.ts");
		expect(aSyms).toHaveLength(2);
		for (const s of aSyms) expect(s.path).toBe("a.ts");
	});

	it("getSymbolsForFile() returns [] for an unknown path", () => {
		const index: SymbolEntry[] = [makeSymbol({ name: "alpha", path: "a.ts" })];
		live = createLiveSyntaxIndex({ index, watcher: fake.watcher, root });
		expect(live.getSymbolsForFile("nope.ts")).toEqual([]);
	});

	it("isStale() defaults to false on a freshly constructed index", () => {
		live = createLiveSyntaxIndex({ index: [], watcher: fake.watcher, root });
		expect(live.isStale()).toBe(false);
	});
});

