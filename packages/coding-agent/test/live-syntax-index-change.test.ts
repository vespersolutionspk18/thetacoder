/**
 * F1 live syntax index — `change` event handling.
 *
 * When the watcher reports that an existing file changed, the live
 * syntax index must re-read the file from disk and replace the file's
 * symbols with the freshly-extracted set.
 */

import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveSyntaxIndex } from "../src/core/repository/live-syntax-index.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";

import { makeFakeWatcher, makeTempDir, removeTempDir, touchFile } from "./live-syntax-index-helpers.ts";

describe("createLiveSyntaxIndex — change event", () => {
	let root: string;
	let live: ReturnType<typeof createLiveSyntaxIndex> | null = null;
	const fake = makeFakeWatcher();

	beforeEach(async () => {
		root = await makeTempDir("live-syntax-index-change");
	});

	afterEach(async () => {
		if (live) live.stop();
		live = null;
		await removeTempDir(root);
	});

	it("replaces a file's symbols when a `change` event fires", async () => {
		// Seed the file with a function named `first`.
		await touchFile(root, "edit.ts", "export function first(): number { return 1; }");

		const seed: SymbolEntry[] = [
			{
				kind: "function",
				name: "first",
				path: "edit.ts",
				startLine: 1,
				endLine: 1,
				language: "typescript",
			},
		];
		live = createLiveSyntaxIndex({ index: seed, watcher: fake.watcher, root });
		expect(live.getSymbolsForFile("edit.ts").map((s) => s.name)).toEqual(["first"]);

		// Overwrite the file with a new declaration.
		await writeFile(`${root}/edit.ts`, "export function second(): number { return 2; }", "utf-8");

		await fake.fire({ kind: "change", path: "edit.ts", timestamp: Date.now() });

		const after = live.getSymbolsForFile("edit.ts");
		expect(after.map((s) => s.name)).toEqual(["second"]);
		// The `first` entry must be gone from the overall index.
		const allNames = live.getSymbols().map((s) => s.name);
		expect(allNames).not.toContain("first");
		expect(allNames).toContain("second");
	});

	it("replaces a file's symbols when a `change` event fires for a multi-declaration file", async () => {
		await touchFile(root, "multi.ts", "export function a(): void {}\nexport function b(): void {}");

		const seed: SymbolEntry[] = [
			{ kind: "function", name: "oldA", path: "multi.ts", startLine: 1, endLine: 1, language: "typescript" },
			{ kind: "function", name: "oldB", path: "multi.ts", startLine: 2, endLine: 2, language: "typescript" },
		];
		live = createLiveSyntaxIndex({ index: seed, watcher: fake.watcher, root });

		await writeFile(
			`${root}/multi.ts`,
			"export function x(): void {}\nexport function y(): void {}\nexport function z(): void {}",
			"utf-8",
		);

		await fake.fire({ kind: "change", path: "multi.ts", timestamp: Date.now() });

		const after = live
			.getSymbolsForFile("multi.ts")
			.map((s) => s.name)
			.sort();
		expect(after).toEqual(["x", "y", "z"]);
	});

	it("clears the file's symbols when the file disappears between event and read", async () => {
		await touchFile(root, "ghost.ts", "export const x = 1;");

		const seed: SymbolEntry[] = [
			{ kind: "variable", name: "x", path: "ghost.ts", startLine: 1, endLine: 1, language: "typescript" },
		];
		live = createLiveSyntaxIndex({ index: seed, watcher: fake.watcher, root });
		expect(live.getSymbolsForFile("ghost.ts")).toHaveLength(1);

		const { rm } = await import("node:fs/promises");
		await rm(`${root}/ghost.ts`, { force: true });

		await fake.fire({ kind: "change", path: "ghost.ts", timestamp: Date.now() });

		expect(live.getSymbolsForFile("ghost.ts")).toEqual([]);
	});

	it("does not affect symbols belonging to other files", async () => {
		await touchFile(root, "kept.ts", "export function kept(): number { return 1; }");
		await touchFile(root, "edited.ts", "export function before(): number { return 1; }");

		const seed: SymbolEntry[] = [
			{ kind: "function", name: "kept", path: "kept.ts", startLine: 1, endLine: 1, language: "typescript" },
			{ kind: "function", name: "before", path: "edited.ts", startLine: 1, endLine: 1, language: "typescript" },
		];
		live = createLiveSyntaxIndex({ index: seed, watcher: fake.watcher, root });

		await writeFile(`${root}/edited.ts`, "export function after(): number { return 2; }", "utf-8");

		await fake.fire({ kind: "change", path: "edited.ts", timestamp: Date.now() });

		// `kept.ts` symbols are untouched.
		const keptSyms = live.getSymbolsForFile("kept.ts");
		expect(keptSyms.map((s) => s.name)).toEqual(["kept"]);
		// `edited.ts` reflects the new file contents.
		const editedSyms = live.getSymbolsForFile("edited.ts");
		expect(editedSyms.map((s) => s.name)).toEqual(["after"]);
	});
});

