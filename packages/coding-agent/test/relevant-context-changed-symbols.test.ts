/**
 * F1 getRelevantContext — changedSymbols hint.
 *
 * A query that lists known-changed symbols should include those
 * symbol entries (score 0.9, "changed-symbol" reason) plus any
 * references pre-computed for them in `referenceResults`.
 */

import { describe, expect, it } from "vitest";
import type { Reference } from "../src/core/repository/references.ts";
import { getRelevantContext } from "../src/core/repository/relevant-context.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";

function makeIndex(): SymbolEntry[] {
	return [
		{ kind: "function", name: "changed", path: "src/foo.ts", startLine: 20, endLine: 20, language: "typescript" },
		{ kind: "function", name: "unchanged", path: "src/bar.ts", startLine: 1, endLine: 1, language: "typescript" },
	];
}

function makeReferences(): Map<string, Reference[]> {
	const map = new Map<string, Reference[]>();
	map.set("changed", [
		{
			path: "src/caller.ts",
			startLine: 5,
			endLine: 5,
			kind: "call",
			symbol: "changed",
			certainty: "exact",
		},
		{
			path: "src/caller2.ts",
			startLine: 12,
			endLine: 12,
			kind: "call",
			symbol: "changed",
			certainty: "exact",
		},
	]);
	return map;
}

describe("getRelevantContext — changedSymbols", () => {
	it("includes the changed symbol with score 0.9 and changed-symbol reason", async () => {
		const result = await getRelevantContext(
			{ task: "Review the recent edit", hints: { changedSymbols: ["changed"] } },
			[],
			makeIndex(),
		);

		const symbols = result.items.filter((i) => i.kind === "symbol");
		expect(symbols.length).toBe(1);
		const sym = symbols[0];
		if (sym.kind !== "symbol") throw new Error("expected symbol");
		expect(sym.name).toBe("changed");
		expect(sym.score).toBe(0.9);
		expect(sym.certainty).toBe("exact");
		expect(sym.reasons).toContain("changed-symbol");
	});

	it("also includes the pre-computed references to the changed symbol", async () => {
		const refs = makeReferences();
		const result = await getRelevantContext(
			{ task: "Review the recent edit", hints: { changedSymbols: ["changed"] } },
			[],
			makeIndex(),
			refs,
		);

		const referenceItems = result.items.filter((i) => i.kind === "reference");
		expect(referenceItems.length).toBe(2);
		const symbols = result.items.filter((i) => i.kind === "symbol");
		expect(symbols.length).toBe(1);

		// Symbol is exact (changed-symbol reason) and both references are
		// exact too => "low" uncertainty.
		expect(result.uncertainty).toBe("low");
	});

	it("does not include unrelated symbols or references", async () => {
		const result = await getRelevantContext(
			{ task: "Review the recent edit", hints: { changedSymbols: ["changed"] } },
			[],
			makeIndex(),
		);
		const names = result.items.filter((i) => i.kind === "symbol").map((i) => (i as { name: string }).name);
		expect(names).not.toContain("unchanged");
	});
});

