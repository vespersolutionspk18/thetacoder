/**
 * F1 `query` tool — default list.
 *
 * Asserts the `query` tool is included in `createCodingToolDefinitions`
 * when the caller provides the data layer via `options.query`.
 */

import { describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";
import { createCodingToolDefinitions, createCodingTools } from "../src/core/tools/index.ts";

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

describe("query tool — default list", () => {
	it("appears in createCodingToolDefinitions when options.query is provided", () => {
		const tools = createCodingToolDefinitions("/tmp", {
			query: {
				manifest: makeManifest(),
				symbolIndex: makeIndex(),
				semanticAdapter: new MockSemanticQueryAdapter(),
			},
		});
		const names = tools.map((t) => t.name);
		expect(names).toContain("query");
		// The other coding tools must still be present.
		expect(names).toContain("read");
		expect(names).toContain("bash");
		expect(names).toContain("edit");
		expect(names).toContain("write");
	});

	it("is omitted from createCodingToolDefinitions when options.query is absent", () => {
		const tools = createCodingToolDefinitions("/tmp");
		const names = tools.map((t) => t.name);
		expect(names).not.toContain("query");
	});

	it("appears in createCodingTools when options.query is provided", () => {
		const tools = createCodingTools("/tmp", {
			query: {
				manifest: makeManifest(),
				symbolIndex: makeIndex(),
				semanticAdapter: new MockSemanticQueryAdapter(),
			},
		});
		const names = tools.map((t) => t.name);
		expect(names).toContain("query");
	});
});

