/**
 * F1 `query` tool — find-relevant-context intent.
 *
 * Passes a natural-language task with a known identifier and asserts
 * the tool surfaces the matching file and symbol via the F1 relevant
 * context pipeline.
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
		},
	];
}

describe("query tool — find-relevant-context", () => {
	it("builds context from a natural-language task mentioning an identifier", async () => {
		const tool = createQueryTool(makeManifest(), makeIndex(), new MockSemanticQueryAdapter());
		const result = await tool.execute("call-1", {
			intent: "find-relevant-context",
			query: "fix the myFunction in auth.ts",
		});

		const output = result.details as {
			output: {
				intent: string;
				results: Array<{ kind: string; path: string; certainty: string }>;
				uncertainty: string;
			};
		};
		expect(output.output.intent).toBe("find-relevant-context");
		expect(output.output.results.length).toBeGreaterThan(0);

		const paths = output.output.results.map((r) => r.path);
		expect(paths).toContain("src/auth.ts");
	});

	it("maps the result items to the context-item kind", async () => {
		const tool = createQueryTool(makeManifest(), makeIndex(), new MockSemanticQueryAdapter());
		const result = await tool.execute("call-2", {
			intent: "find-relevant-context",
			query: "audit myFunction in auth",
		});
		const output = result.details as { output: { results: Array<{ kind: string }> } };
		for (const item of output.output.results) {
			expect(item.kind).toBe("context-item");
		}
	});
});

