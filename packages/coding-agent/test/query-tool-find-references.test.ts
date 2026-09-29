/**
 * F1 `query` tool — find-references intent.
 *
 * Uses `MockSemanticQueryAdapter.setMockResult` to inject deterministic
 * reference locations, then asserts the tool maps them to the
 * expected reference results.
 */

import { describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { MockSemanticQueryAdapter, type SemanticResult } from "../src/core/repository/semantic-queries.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";
import { createQueryTool } from "../src/core/tools/query.ts";

function makeManifest(): FileManifestEntry[] {
	return [
		{
			path: "src/a.ts",
			absolutePath: "/abs/src/a.ts",
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		},
	];
}

function makeIndex(): SymbolEntry[] {
	return [{ kind: "function", name: "foo", path: "src/a.ts", startLine: 1, endLine: 1, language: "typescript" }];
}

describe("query tool — find-references", () => {
	it("returns injected reference results mapped to the reference result kind", async () => {
		const adapter = new MockSemanticQueryAdapter();
		const injected: SemanticResult = {
			relation: "reference",
			symbol: "foo",
			locations: [
				{ path: "src/a.ts", startLine: 1, endLine: 1 },
				{ path: "src/a.ts", startLine: 5, endLine: 5 },
			],
			certainty: "exact",
			coverage: "complete",
		};
		adapter.setMockResult("reference", "foo", injected);

		const tool = createQueryTool(makeManifest(), makeIndex(), adapter);
		const result = await tool.execute("call-1", { intent: "find-references", query: "foo" });

		const output = (result.details as { output: { results: Array<{ kind: string; path: string; symbol: string }> } })
			.output;
		expect(output.results.length).toBe(2);
		expect(output.results[0].kind).toBe("reference");
		expect(output.results[0].path).toBe("src/a.ts");
		expect(output.results[0].symbol).toBe("foo");
	});

	it("falls back to the regex reference scanner when the mock returns unknown + no locations", async () => {
		// No injection on the mock adapter -> it returns the default
		// `certainty: "unknown"` with empty locations. The tool should
		// fall back to the F1 reference scanner for a real answer.
		const adapter = new MockSemanticQueryAdapter();
		const manifest: FileManifestEntry[] = [
			{
				path: "src/foo.ts",
				absolutePath: "/abs/src/foo.ts",
				byteLength: 0,
				language: "typescript",
				generated: false,
				ignored: false,
			},
		];
		// No file written to disk; the scanner should still return an
		// empty list (the file's `getReferences` opens the file and
		// scans it). The point of this test is that the tool itself
		// doesn't throw.
		const tool = createQueryTool(manifest, [], adapter);
		const result = await tool.execute("call-2", { intent: "find-references", query: "no-such-symbol" });
		const output = result.details as { output: { results: unknown[] } };
		expect(Array.isArray(output.output.results)).toBe(true);
	});
});

