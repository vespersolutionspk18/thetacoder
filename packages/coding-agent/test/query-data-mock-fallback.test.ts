/**
 * F1 `query` tool — live data layer, mock fallback.
 *
 * When the worktree does not look like a TypeScript project — either
 * because it has no `tsconfig.json` at the root, or because the
 * manifest contains no `.ts` / `.tsx` / `.mts` / `.cts` files —
 * `createLiveQueryToolData` must fall back to the
 * `MockSemanticQueryAdapter`. The explicit `semanticBackend: "mock"`
 * option also always selects the mock, even when the worktree would
 * otherwise auto-detect as TypeScript.
 *
 * The mock returns `certainty: "unknown"` placeholders, so any
 * semantic call that resolves a real symbol would be a regression
 * (i.e. an adapter other than the mock being returned).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLiveQueryToolData } from "../src/core/repository/query-data.ts";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";
import { TypeScriptLanguageServiceAdapter } from "../src/core/repository/typescript-semantic-adapter.ts";

describe("createLiveQueryToolData — mock fallback", () => {
	let root: string;

	afterEach(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	});

	it("falls back to the mock adapter when the worktree has .ts files but no tsconfig.json", async () => {
		root = await mkdtemp(join(tmpdir(), "theta-query-data-mock-"));
		await mkdir(join(root, "src"), { recursive: true });
		// .ts file present, tsconfig.json absent => auto-detect should
		// pick the mock.
		await writeFile(
			join(root, "src", "math.ts"),
			["export function add(a: number, b: number): number {", "    return a + b;", "}", ""].join("\n"),
			"utf-8",
		);

		const live = createLiveQueryToolData({ root });
		const data = await live.getToolData();
		expect(data.semanticAdapter).toBeInstanceOf(MockSemanticQueryAdapter);
		expect(data.semanticAdapter).not.toBeInstanceOf(TypeScriptLanguageServiceAdapter);
	});

	it("falls back to the mock adapter when the worktree has a tsconfig but no .ts files", async () => {
		root = await mkdtemp(join(tmpdir(), "theta-query-data-mock-"));
		// tsconfig.json present, but only a .js file in the manifest =>
		// the manifest has no TS file, so the second auto-detect
		// pre-condition fails.
		await writeFile(
			join(root, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { target: "ES2022", module: "ESNext", noEmit: true },
			}),
			"utf-8",
		);
		await writeFile(join(root, "script.js"), "module.exports = 1;\n", "utf-8");

		const live = createLiveQueryToolData({ root });
		const data = await live.getToolData();
		expect(data.semanticAdapter).toBeInstanceOf(MockSemanticQueryAdapter);
	});

	it("falls back to the mock adapter when the worktree is completely empty", async () => {
		root = await mkdtemp(join(tmpdir(), "theta-query-data-mock-"));
		const live = createLiveQueryToolData({ root });
		const data = await live.getToolData();
		expect(data.semanticAdapter).toBeInstanceOf(MockSemanticQueryAdapter);
	});

	it("explicit semanticBackend: 'mock' forces the mock even when the worktree would auto-detect as TS", async () => {
		root = await mkdtemp(join(tmpdir(), "theta-query-data-mock-"));
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(
			join(root, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { target: "ES2022", noEmit: true } }),
			"utf-8",
		);
		await writeFile(
			join(root, "src", "math.ts"),
			["export function add(a: number, b: number): number {", "    return a + b;", "}", ""].join("\n"),
			"utf-8",
		);

		const live = createLiveQueryToolData({ root, semanticBackend: "mock" });
		const data = await live.getToolData();
		expect(data.semanticAdapter).toBeInstanceOf(MockSemanticQueryAdapter);
		expect(data.semanticAdapter).not.toBeInstanceOf(TypeScriptLanguageServiceAdapter);
	});

	it("the mock's getDefinition returns the unknown placeholder, confirming the mock is in play", async () => {
		root = await mkdtemp(join(tmpdir(), "theta-query-data-mock-"));
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(
			join(root, "src", "math.ts"),
			["export function add(a: number, b: number): number {", "    return a + b;", "}", ""].join("\n"),
			"utf-8",
		);

		const live = createLiveQueryToolData({ root });
		const data = await live.getToolData();
		const result = await data.semanticAdapter.getDefinition("add");
		expect(result.relation).toBe("definition");
		if (result.relation !== "definition") throw new Error("narrow");
		expect(result.certainty).toBe("unknown");
		expect(result.locations).toEqual([]);
	});
});

