/**
 * F1 `query` tool — find-symbol intent.
 *
 * Builds a manifest + symbol index with a known function and asserts
 * the tool returns the matching symbol with the expected fields.
 */

import { describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";
import { createQueryTool } from "../src/core/tools/query.ts";

function makeManifest(): FileManifestEntry[] {
	return [
		{
			path: "src/auth.ts",
			absolutePath: "/abs/src/auth.ts",
			byteLength: 1024,
			language: "typescript",
			package: "@theta/test",
			generated: false,
			ignored: false,
		},
		{
			path: "src/user.ts",
			absolutePath: "/abs/src/user.ts",
			byteLength: 512,
			language: "typescript",
			package: "@theta/test",
			generated: false,
			ignored: false,
		},
	];
}

function makeIndex(): SymbolEntry[] {
	return [
		{
			kind: "function",
			name: "myFunction",
			path: "src/auth.ts",
			startLine: 10,
			endLine: 20,
			language: "typescript",
			signature: "export function myFunction(): void",
		},
		{
			kind: "class",
			name: "AuthService",
			path: "src/auth.ts",
			startLine: 30,
			endLine: 50,
			language: "typescript",
		},
		{
			kind: "function",
			name: "otherHelper",
			path: "src/user.ts",
			startLine: 5,
			endLine: 12,
			language: "typescript",
		},
	];
}

describe("query tool — find-symbol", () => {
	it("returns the matching symbol with structured fields", async () => {
		const tool = createQueryTool(makeManifest(), makeIndex(), new MockSemanticQueryAdapter());
		const result = await tool.execute("call-1", { intent: "find-symbol", query: "myFunction" });

		expect(result.details).toBeDefined();
		const output = (result.details as { output: { results: Array<{ kind: string; name: string }> } }).output;
		expect(output.results.length).toBe(1);
		const sym = output.results[0];
		expect(sym.kind).toBe("symbol");
		expect(sym.name).toBe("myFunction");

		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toContain("SYMBOL");
		expect(text).toContain("myFunction");
		expect(text).toContain("src/auth.ts");
	});

	it("returns an empty result for an unknown symbol with high uncertainty", async () => {
		const tool = createQueryTool(makeManifest(), makeIndex(), new MockSemanticQueryAdapter());
		const result = await tool.execute("call-2", { intent: "find-symbol", query: "noSuchThing" });

		const output = (result.details as { output: { results: unknown[]; uncertainty: string } }).output;
		expect(output.results.length).toBe(0);
		expect(output.uncertainty).toBe("high");
	});
});

