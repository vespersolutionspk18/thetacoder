/**
 * F1 `query` tool — find-files intent.
 *
 * Filters the manifest by language and package and asserts the tool
 * returns only the matching files.
 */

import { describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";
import { createQueryTool } from "../src/core/tools/query.ts";

function makeManifest(): FileManifestEntry[] {
	return [
		{
			path: "src/a.ts",
			absolutePath: "/abs/src/a.ts",
			byteLength: 100,
			language: "typescript",
			package: "@theta/agent",
			generated: false,
			ignored: false,
		},
		{
			path: "src/b.ts",
			absolutePath: "/abs/src/b.ts",
			byteLength: 200,
			language: "typescript",
			package: "@theta/ai",
			generated: false,
			ignored: false,
		},
		{
			path: "src/c.py",
			absolutePath: "/abs/src/c.py",
			byteLength: 300,
			language: "python",
			package: "@theta/agent",
			generated: false,
			ignored: false,
		},
		{
			path: "docs/README.md",
			absolutePath: "/abs/docs/README.md",
			byteLength: 400,
			language: "markdown",
			package: "@theta/agent",
			generated: false,
			ignored: false,
		},
	];
}

describe("query tool — find-files", () => {
	it("filters by language only", async () => {
		const tool = createQueryTool(makeManifest(), [], new MockSemanticQueryAdapter());
		const result = await tool.execute("call-1", {
			intent: "find-files",
			query: "**/*",
			options: { language: "typescript" },
		});
		const output = result.details as {
			output: { results: Array<{ kind: string; path: string; language: string | null }> };
		};
		const paths = output.output.results.map((r) => r.path).sort();
		expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
		for (const r of output.output.results) {
			expect(r.kind).toBe("file");
			expect(r.language).toBe("typescript");
		}
	});

	it("filters by language AND package", async () => {
		const tool = createQueryTool(makeManifest(), [], new MockSemanticQueryAdapter());
		const result = await tool.execute("call-2", {
			intent: "find-files",
			query: "**/*",
			options: { language: "typescript", package: "@theta/agent" },
		});
		const output = result.details as { output: { results: Array<{ path: string }> } };
		expect(output.output.results.map((r) => r.path)).toEqual(["src/a.ts"]);
	});

	it("applies a path glob via the query string", async () => {
		const tool = createQueryTool(makeManifest(), [], new MockSemanticQueryAdapter());
		const result = await tool.execute("call-3", {
			intent: "find-files",
			query: "src/**",
		});
		const output = result.details as { output: { results: Array<{ path: string }> } };
		const paths = output.output.results.map((r) => r.path).sort();
		expect(paths).toEqual(["src/a.ts", "src/b.ts", "src/c.py"]);
	});

	it("returns all files when no filters are set and query is empty", async () => {
		const tool = createQueryTool(makeManifest(), [], new MockSemanticQueryAdapter());
		const result = await tool.execute("call-4", { intent: "find-files", query: "" });
		const output = result.details as { output: { results: unknown[] } };
		expect(output.output.results.length).toBe(makeManifest().length);
	});
});

