/**
 * F1 getRelevantContext — empty query.
 *
 * When the natural-language task is empty and no hints are set, the
 * result must be empty and uncertainty must be "high".
 */

import { describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { getRelevantContext } from "../src/core/repository/relevant-context.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";

function makeManifest(): FileManifestEntry[] {
	return [
		{
			path: "src/foo.ts",
			absolutePath: "/abs/src/foo.ts",
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		},
		{
			path: "src/bar.ts",
			absolutePath: "/abs/src/bar.ts",
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		},
	];
}

function makeIndex(): SymbolEntry[] {
	return [
		{ kind: "function", name: "alpha", path: "src/foo.ts", startLine: 1, endLine: 1, language: "typescript" },
		{ kind: "function", name: "beta", path: "src/bar.ts", startLine: 1, endLine: 1, language: "typescript" },
	];
}

describe("getRelevantContext — empty query", () => {
	it("returns an empty context with high uncertainty when the task is empty and no hints are set", async () => {
		const result = await getRelevantContext({ task: "" }, makeManifest(), makeIndex());
		expect(result.items.length).toBe(0);
		expect(result.totalCandidates).toBe(0);
		expect(result.truncated).toBe(false);
		expect(result.uncertainty).toBe("high");
		expect(result.selectionSummary).toEqual({
			filesConsidered: 0,
			symbolsConsidered: 0,
			referencesConsidered: 0,
			diagnosticsConsidered: 0,
		});
	});

	it("also returns empty when the task is whitespace only", async () => {
		const result = await getRelevantContext({ task: "   " }, makeManifest(), makeIndex());
		expect(result.items.length).toBe(0);
		expect(result.uncertainty).toBe("high");
	});
});

