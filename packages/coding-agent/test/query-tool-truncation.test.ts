/**
 * F1 `query` tool — truncation.
 *
 * A large `find-symbol` input with `maxResults: 3` should produce
 * exactly 3 results and mark `truncated: true`.
 */

import { describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";
import { createQueryTool } from "../src/core/tools/query.ts";

function makeManifest(): FileManifestEntry[] {
	return [
		{
			path: "src/big.ts",
			absolutePath: "/abs/src/big.ts",
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		},
	];
}

function makeBigIndex(): SymbolEntry[] {
	const out: SymbolEntry[] = [];
	for (let i = 0; i < 50; i += 1) {
		out.push({
			kind: "function",
			name: `bigFunc${i}`,
			path: "src/big.ts",
			startLine: i + 1,
			endLine: i + 1,
			language: "typescript",
		});
	}
	return out;
}

describe("query tool — truncation", () => {
	it("truncates find-symbol results when maxResults is small", async () => {
		const tool = createQueryTool(makeManifest(), makeBigIndex(), new MockSemanticQueryAdapter());
		const result = await tool.execute("call-1", {
			intent: "find-symbol",
			query: "bigFunc",
			options: { maxResults: 3 },
		});

		const output = result.details as {
			output: { results: unknown[]; truncated: boolean; totalCandidates: number };
		};
		expect(output.output.results.length).toBe(3);
		expect(output.output.truncated).toBe(true);
		expect(output.output.totalCandidates).toBe(3);
	});

	it("does not mark truncated when results fit within the cap", async () => {
		const tool = createQueryTool(makeManifest(), makeBigIndex(), new MockSemanticQueryAdapter());
		const result = await tool.execute("call-2", {
			intent: "find-symbol",
			query: "bigFunc",
			options: { maxResults: 100 },
		});
		const output = result.details as { output: { truncated: boolean } };
		expect(output.output.truncated).toBe(false);
	});
});

