/**
 * F1 live syntax index — `create` event handling.
 *
 * A `create` event for a previously-unknown file must extract that
 * file's symbols and add them to the live index.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveSyntaxIndex } from "../src/core/repository/live-syntax-index.ts";

import { makeFakeWatcher, makeTempDir, removeTempDir, touchFile } from "./live-syntax-index-helpers.ts";

describe("createLiveSyntaxIndex — create event", () => {
	let root: string;
	let live: ReturnType<typeof createLiveSyntaxIndex> | null = null;
	const fake = makeFakeWatcher();

	beforeEach(async () => {
		root = await makeTempDir("live-syntax-index-create");
	});

	afterEach(async () => {
		if (live) live.stop();
		live = null;
		await removeTempDir(root);
	});

	it("adds new symbols when a `create` event fires for a new file", async () => {
		// The file is on disk so the extractor has something to read.
		await touchFile(root, "new.ts", "export function added(): number { return 42; }");

		live = createLiveSyntaxIndex({ index: [], watcher: fake.watcher, root });
		expect(live.getSymbolsForFile("new.ts")).toEqual([]);

		await fake.fire({ kind: "create", path: "new.ts", timestamp: Date.now() });

		const symbols = live.getSymbolsForFile("new.ts");
		expect(symbols.length).toBeGreaterThan(0);
		const names = symbols.map((s) => s.name);
		expect(names).toContain("added");
		// Language detection must tag the symbols correctly.
		for (const s of symbols) {
			expect(s.language).toBe("typescript");
		}
	});

	it("extracts multiple symbols from a freshly-created file", async () => {
		await touchFile(
			root,
			"multi.ts",
			"export function alpha(): void {}\nexport function beta(): void {}\nexport class Gamma {}",
		);

		live = createLiveSyntaxIndex({ index: [], watcher: fake.watcher, root });

		await fake.fire({ kind: "create", path: "multi.ts", timestamp: Date.now() });

		const names = live
			.getSymbolsForFile("multi.ts")
			.map((s) => s.name)
			.sort();
		expect(names).toEqual(["Gamma", "alpha", "beta"]);
	});

	it("does not insert symbols when the file is missing on disk", async () => {
		live = createLiveSyntaxIndex({ index: [], watcher: fake.watcher, root });

		await fake.fire({ kind: "create", path: "ghost.ts", timestamp: Date.now() });

		expect(live.getSymbolsForFile("ghost.ts")).toEqual([]);
		expect(live.getSymbols()).toEqual([]);
	});

	it("supports unsupported languages (no symbols inserted, no throw)", async () => {
		// .rs (Rust) is not in the extractor table.
		await touchFile(root, "main.rs", "fn main() {}");

		live = createLiveSyntaxIndex({ index: [], watcher: fake.watcher, root });

		await fake.fire({ kind: "create", path: "main.rs", timestamp: Date.now() });

		expect(live.getSymbolsForFile("main.rs")).toEqual([]);
	});
});

