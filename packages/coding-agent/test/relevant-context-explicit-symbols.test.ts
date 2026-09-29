/**
 * F1 getRelevantContext — explicitSymbols hint.
 *
 * A query that names a symbol should surface all syntax index
 * entries with that name at score 1.0, certainty "exact", and the
 * "explicit-symbol" reason.
 */

import { describe, expect, it } from "vitest";
import { getRelevantContext } from "../src/core/repository/relevant-context.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";

function makeIndex(): SymbolEntry[] {
	return [
		{ kind: "function", name: "myFunction", path: "src/foo.ts", startLine: 10, endLine: 10, language: "typescript" },
		{ kind: "function", name: "myFunction", path: "src/foo.ts", startLine: 50, endLine: 50, language: "typescript" },
		{ kind: "function", name: "other", path: "src/bar.ts", startLine: 1, endLine: 1, language: "typescript" },
	];
}

describe("getRelevantContext — explicitSymbols", () => {
	it("includes every symbol with the named name at score 1.0 with explicit-symbol reason", async () => {
		const result = await getRelevantContext(
			{ task: "Investigate myFunction", hints: { explicitSymbols: ["myFunction"] } },
			[],
			makeIndex(),
		);

		const symbols = result.items.filter((i) => i.kind === "symbol");
		expect(symbols.length).toBe(2);
		for (const s of symbols) {
			if (s.kind !== "symbol") throw new Error("expected symbol");
			expect(s.name).toBe("myFunction");
			expect(s.score).toBe(1.0);
			expect(s.certainty).toBe("exact");
			expect(s.reasons).toContain("explicit-symbol");
		}
		expect(result.uncertainty).toBe("low");
	});

	it("returns no symbols when the explicit name is not in the index", async () => {
		const result = await getRelevantContext(
			{ task: "Investigate missing", hints: { explicitSymbols: ["doesNotExist"] } },
			[],
			makeIndex(),
		);
		const symbols = result.items.filter((i) => i.kind === "symbol");
		expect(symbols.length).toBe(0);
	});
});

