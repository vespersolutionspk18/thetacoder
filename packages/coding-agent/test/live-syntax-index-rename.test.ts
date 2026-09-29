/**
 * F1 live syntax index — `rename` event handling.
 *
 * A `rename` event carries both an `oldPath` (gone) and a `newPath`
 * (present). The live index must drop the old file's symbols and add
 * the new file's freshly-extracted symbols.
 */

import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveSyntaxIndex } from "../src/core/repository/live-syntax-index.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";

import { makeFakeWatcher, makeTempDir, removeTempDir, touchFile } from "./live-syntax-index-helpers.ts";

describe("createLiveSyntaxIndex — rename event", () => {
	let root: string;
	let live: ReturnType<typeof createLiveSyntaxIndex> | null = null;
	const fake = makeFakeWatcher();

	beforeEach(async () => {
		root = await makeTempDir("live-syntax-index-rename");
	});

	afterEach(async () => {
		if (live) live.stop();
		live = null;
		await removeTempDir(root);
	});

	it("removes the old file's symbols and adds the new file's symbols", async () => {
		// The new-path file already exists on disk; the rename event
		// tells us the new path, and the live index re-extracts it.
		await writeFile(`${root}/renamed.ts`, "export function y(): number { return 7; }", "utf-8");

		const seed: SymbolEntry[] = [
			{ kind: "function", name: "x", path: "old.ts", startLine: 1, endLine: 1, language: "typescript" },
		];
		live = createLiveSyntaxIndex({ index: seed, watcher: fake.watcher, root });

		await fake.fire({
			kind: "rename",
			oldPath: "old.ts",
			newPath: "renamed.ts",
			timestamp: Date.now(),
		});

		// Old path is gone.
		expect(live.getSymbolsForFile("old.ts")).toEqual([]);
		// New path reflects the on-disk file.
		const newSyms = live.getSymbolsForFile("renamed.ts");
		expect(newSyms.map((s) => s.name)).toEqual(["y"]);
		for (const s of newSyms) {
			expect(s.language).toBe("typescript");
		}
	});

	it("drops the old file's symbols even if the new file is not on disk", async () => {
		const seed: SymbolEntry[] = [
			{ kind: "function", name: "x", path: "old.ts", startLine: 1, endLine: 1, language: "typescript" },
		];
		live = createLiveSyntaxIndex({ index: seed, watcher: fake.watcher, root });

		await fake.fire({
			kind: "rename",
			oldPath: "old.ts",
			newPath: "missing.ts",
			timestamp: Date.now(),
		});

		expect(live.getSymbolsForFile("old.ts")).toEqual([]);
		expect(live.getSymbolsForFile("missing.ts")).toEqual([]);
		expect(live.getSymbols()).toEqual([]);
	});

	it("does not affect symbols belonging to other files", async () => {
		await touchFile(root, "bystander.ts", "export const z = 0;");
		await writeFile(`${root}/renamed.ts`, "export function renamedFn(): number { return 1; }", "utf-8");

		const seed: SymbolEntry[] = [
			{ kind: "function", name: "oldFn", path: "old.ts", startLine: 1, endLine: 1, language: "typescript" },
			{
				kind: "variable",
				name: "z",
				path: "bystander.ts",
				startLine: 1,
				endLine: 1,
				language: "typescript",
			},
		];
		live = createLiveSyntaxIndex({ index: seed, watcher: fake.watcher, root });

		await fake.fire({
			kind: "rename",
			oldPath: "old.ts",
			newPath: "renamed.ts",
			timestamp: Date.now(),
		});

		// Bystander untouched.
		const bystander = live.getSymbolsForFile("bystander.ts");
		expect(bystander.map((s) => s.name)).toEqual(["z"]);
		// Renamed file is the only one with the new symbol.
		const renamed = live.getSymbolsForFile("renamed.ts");
		expect(renamed.map((s) => s.name)).toEqual(["renamedFn"]);
	});
});

