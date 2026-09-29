/**
 * F1 `query` tool — `find-relevant-context` intent: explicit path hint.
 *
 * Verifies that `options.path` is forwarded into the F1
 * `TaskQuery.hints.explicitPaths` array, and that the tool surfaces the
 * requested file as a `context-item` with `certainty: "exact"`,
 * `reasons: ["explicit-path"]`, and `score: 1.0`.
 */

import { describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";
import { createQueryTool } from "../src/core/tools/query.ts";

function makeManifest(): FileManifestEntry[] {
	return [
		{
			path: "src/foo.ts",
			absolutePath: "/abs/src/foo.ts",
			byteLength: 1024,
			language: "typescript",
			package: "@theta/test",
			generated: false,
			ignored: false,
		},
		{
			path: "src/bar.ts",
			absolutePath: "/abs/src/bar.ts",
			byteLength: 512,
			language: "typescript",
			package: "@theta/test",
			generated: false,
			ignored: false,
		},
		{
			path: "src/baz.ts",
			absolutePath: "/abs/src/baz.ts",
			byteLength: 256,
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
			name: "doFoo",
			path: "src/foo.ts",
			startLine: 1,
			endLine: 10,
			language: "typescript",
		},
	];
}

describe("query tool — find-relevant-context (explicit path hint)", () => {
	it("surfaces the requested file when options.path is forwarded to explicitPaths", async () => {
		const tool = createQueryTool(makeManifest(), makeIndex(), new MockSemanticQueryAdapter());
		const result = await tool.execute("call-1", {
			intent: "find-relevant-context",
			query: "anything",
			options: { path: "src/foo.ts" },
		});

		const output = result.details as {
			output: {
				intent: string;
				results: Array<{
					kind: string;
					path: string;
					score: number;
					reasons: string[];
					certainty: string;
				}>;
				totalCandidates: number;
				uncertainty: "low" | "medium" | "high";
			};
		};

		expect(output.output.intent).toBe("find-relevant-context");

		// The requested file must be present in the result.
		const fooItem = output.output.results.find((r) => r.path === "src/foo.ts");
		expect(fooItem).toBeDefined();
		expect(fooItem?.kind).toBe("context-item");
		expect(fooItem?.score).toBe(1.0);
		expect(fooItem?.reasons).toContain("explicit-path");
		expect(fooItem?.certainty).toBe("exact");
	});

	it("does not surface unrelated files when an explicit path hint is provided", async () => {
		const tool = createQueryTool(makeManifest(), makeIndex(), new MockSemanticQueryAdapter());
		const result = await tool.execute("call-2", {
			intent: "find-relevant-context",
			query: "anything",
			options: { path: "src/foo.ts" },
		});

		const output = result.details as {
			output: { results: Array<{ path: string }> };
		};

		const paths = output.output.results.map((r) => r.path);
		// `src/bar.ts` and `src/baz.ts` were not in `hints.explicitPaths`
		// and no natural-language identifier matches them, so they are
		// absent from the result.
		expect(paths).not.toContain("src/bar.ts");
		expect(paths).not.toContain("src/baz.ts");
	});

	it("classifies uncertainty as 'low' when every item is an exact explicit-path match", async () => {
		const tool = createQueryTool(makeManifest(), makeIndex(), new MockSemanticQueryAdapter());
		const result = await tool.execute("call-3", {
			intent: "find-relevant-context",
			query: "anything",
			options: { path: "src/foo.ts" },
		});

		const output = result.details as {
			output: {
				uncertainty: "low" | "medium" | "high";
				totalCandidates: number;
			};
		};

		// An explicit-path item has `coverage: "exact"` and a reason
		// in the explicit-... family, so the bundle qualifies as
		// `low` uncertainty.
		expect(output.output.uncertainty).toBe("low");
		expect(output.output.totalCandidates).toBeGreaterThan(0);
	});
});

