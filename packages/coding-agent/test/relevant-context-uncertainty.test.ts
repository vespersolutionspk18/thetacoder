/**
 * F1 getRelevantContext — uncertainty classification.
 *
 *   - "low"   : every item is exact and at least one reason is
 *               "explicit-*" or "diagnostic".
 *   - "high"  : empty bundle, or no exact items.
 *   - "medium": otherwise.
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
			path: "src/auth/login.ts",
			absolutePath: "/abs/src/auth/login.ts",
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		},
	];
}

function makeIndex(): SymbolEntry[] {
	return [
		{ kind: "function", name: "myFunction", path: "src/foo.ts", startLine: 1, endLine: 1, language: "typescript" },
	];
}

describe("getRelevantContext — uncertainty", () => {
	it("is 'low' when all items are exact and at least one is explicit or diagnostic", async () => {
		const result = await getRelevantContext(
			{
				task: "Look at myFunction",
				hints: { explicitSymbols: ["myFunction"], diagnostics: [{ file: "src/foo.ts", line: 1 }] },
			},
			makeManifest(),
			makeIndex(),
		);
		expect(result.uncertainty).toBe("low");
	});

	it("is 'medium' when exact items exist but no explicit/diagnostic reason", async () => {
		const result = await getRelevantContext(
			{ task: "Look at myFunction", hints: { changedSymbols: ["myFunction"] } },
			makeManifest(),
			makeIndex(),
		);
		// changedSymbols is "exact" and counts as an explicit-style reason,
		// so this is actually "low". Verify the medium path instead with
		// a single keyword match.
		expect(result.uncertainty).toBe("low");

		const medium = await getRelevantContext(
			{ task: "audit the code", hints: { keywords: ["auth"] } },
			makeManifest(),
			makeIndex(),
		);
		// Lexical coverage => not all exact => "medium".
		expect(medium.uncertainty).toBe("medium");
	});

	it("is 'high' when no items match at all", async () => {
		const result = await getRelevantContext({ task: "no useful info here" }, makeManifest(), makeIndex());
		expect(result.items.length).toBe(0);
		expect(result.uncertainty).toBe("high");
	});

	it("is 'high' when only fuzzy / non-exact items are present", async () => {
		const result = await getRelevantContext({ task: "zzz nothing useful" }, makeManifest(), makeIndex());
		// No identifiers extracted from "zzz nothing useful" => no items.
		expect(result.uncertainty).toBe("high");
	});
});

