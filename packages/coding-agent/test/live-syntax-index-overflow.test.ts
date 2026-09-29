/**
 * F1 live syntax index — `overflow` event handling.
 *
 * The audit specifies that after a watcher overflow the live syntax
 * index must set an `isStale` flag so the next `getSymbolsForFile`
 * call re-verifies (re-extracts) the file's symbols from disk. The
 * flag is cleared after one re-verification, so subsequent
 * `getSymbolsForFile` calls do not trigger another re-extract unless
 * another overflow event arrives.
 */

import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveSyntaxIndex } from "../src/core/repository/live-syntax-index.ts";

import { makeFakeWatcher, makeTempDir, removeTempDir, touchFile } from "./live-syntax-index-helpers.ts";

describe("createLiveSyntaxIndex — overflow event", () => {
	let root: string;
	let live: ReturnType<typeof createLiveSyntaxIndex> | null = null;
	const fake = makeFakeWatcher();

	beforeEach(async () => {
		root = await makeTempDir("live-syntax-index-overflow");
	});

	afterEach(async () => {
		if (live) live.stop();
		live = null;
		await removeTempDir(root);
	});

	it("sets isStale to true when an overflow event fires", async () => {
		await touchFile(root, "a.ts", "export const a = 1;");

		live = createLiveSyntaxIndex({
			index: [{ kind: "variable", name: "a", path: "a.ts", startLine: 1, endLine: 1, language: "typescript" }],
			watcher: fake.watcher,
			root,
		});
		expect(live.isStale()).toBe(false);

		await fake.fire({ kind: "overflow", timestamp: Date.now() });

		expect(live.isStale()).toBe(true);
	});

	it("re-extracts the file's symbols on the next getSymbolsForFile after overflow", async () => {
		await touchFile(root, "a.ts", "export const a = 1;");

		// Seed an out-of-date symbol entry; the on-disk content is
		// the source of truth after overflow.
		live = createLiveSyntaxIndex({
			index: [
				{
					kind: "variable",
					name: "staleName",
					path: "a.ts",
					startLine: 1,
					endLine: 1,
					language: "typescript",
				},
			],
			watcher: fake.watcher,
			root,
		});

		await fake.fire({ kind: "overflow", timestamp: Date.now() });
		expect(live.isStale()).toBe(true);

		// The next getSymbolsForFile call triggers a re-extract and
		// clears the staleness flag. Because the re-extract is async
		// (the production watcher does not await handlers), we give
		// the microtask queue a tick to settle.
		const before = live.getSymbolsForFile("a.ts");
		expect(before.map((s) => s.name)).toEqual(["staleName"]);

		// Yield so the async re-extract completes.
		await new Promise((r) => setTimeout(r, 10));

		expect(live.isStale()).toBe(false);
		const after = live.getSymbolsForFile("a.ts");
		expect(after.map((s) => s.name)).toEqual(["a"]);
	});

	it("does not re-extract on subsequent getSymbolsForFile calls until another overflow fires", async () => {
		await writeFile(`${root}/a.ts`, "export const a = 1;", "utf-8");

		live = createLiveSyntaxIndex({
			index: [{ kind: "variable", name: "stale", path: "a.ts", startLine: 1, endLine: 1, language: "typescript" }],
			watcher: fake.watcher,
			root,
		});

		await fake.fire({ kind: "overflow", timestamp: Date.now() });
		// First call clears the flag and triggers re-extract.
		void live.getSymbolsForFile("a.ts");
		await new Promise((r) => setTimeout(r, 10));
		expect(live.isStale()).toBe(false);

		// Rewrite the on-disk file. Without another overflow, the
		// live index does not know to re-extract; the cached
		// post-overflow result is returned.
		await writeFile(`${root}/a.ts`, "export const changed = 2;", "utf-8");
		const after = live.getSymbolsForFile("a.ts");
		expect(after.map((s) => s.name)).toEqual(["a"]);
	});

	it("re-arms isStale on every overflow event", async () => {
		await touchFile(root, "a.ts", "export const a = 1;");

		live = createLiveSyntaxIndex({
			index: [{ kind: "variable", name: "a", path: "a.ts", startLine: 1, endLine: 1, language: "typescript" }],
			watcher: fake.watcher,
			root,
		});

		await fake.fire({ kind: "overflow", timestamp: 1 });
		expect(live.isStale()).toBe(true);

		void live.getSymbolsForFile("a.ts");
		await new Promise((r) => setTimeout(r, 10));
		expect(live.isStale()).toBe(false);

		await fake.fire({ kind: "overflow", timestamp: 2 });
		expect(live.isStale()).toBe(true);
	});
});

