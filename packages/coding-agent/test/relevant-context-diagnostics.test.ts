/**
 * F1 getRelevantContext — diagnostics hint.
 *
 * A query that lists recent diagnostics should surface them as
 * `kind: "diagnostic"` items.
 */

import { describe, expect, it } from "vitest";
import { getRelevantContext } from "../src/core/repository/relevant-context.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";

describe("getRelevantContext — diagnostics", () => {
	it("includes each diagnostic as a diagnostic item", async () => {
		const result = await getRelevantContext(
			{
				task: "Investigate the build failure",
				hints: {
					diagnostics: [
						{ file: "src/foo.ts", line: 12, code: "TS2304" },
						{ file: "src/bar.ts", line: 7 },
					],
				},
			},
			[],
			[] satisfies SymbolEntry[],
		);

		const diagnostics = result.items.filter((i) => i.kind === "diagnostic");
		expect(diagnostics.length).toBe(2);

		const byFile = new Map(diagnostics.map((d) => [(d as { file: string }).file, d]));
		const foo = byFile.get("src/foo.ts");
		const bar = byFile.get("src/bar.ts");
		expect(foo).toBeDefined();
		expect(bar).toBeDefined();
		if (foo?.kind === "diagnostic") {
			expect(foo.line).toBe(12);
			expect(foo.code).toBe("TS2304");
		}
		if (bar?.kind === "diagnostic") {
			expect(bar.line).toBe(7);
			expect(bar.code).toBeUndefined();
		}

		expect(result.selectionSummary.diagnosticsConsidered).toBe(2);
	});

	it("produces low uncertainty because diagnostics are exact", async () => {
		const result = await getRelevantContext(
			{
				task: "Investigate",
				hints: { diagnostics: [{ file: "src/foo.ts", line: 1 }] },
			},
			[],
			[],
		);
		expect(result.uncertainty).toBe("low");
	});
});

