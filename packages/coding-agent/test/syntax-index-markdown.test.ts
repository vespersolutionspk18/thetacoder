/**
 * F1 syntax index — Markdown extractor coverage.
 *
 * Covers ATX headings and fenced code blocks (with and without a
 * language tag).
 */

import { describe, expect, it } from "vitest";
import { extractMarkdownSymbols } from "../src/core/repository/syntax-index.ts";

const FIXTURE = [
	"# Top", // 1
	"", // 2
	"Intro paragraph.", // 3
	"", // 4
	"## Section A", // 5
	"", // 6
	"```typescript", // 7
	"const x: number = 1;", // 8
	"```", // 9
	"", // 10
	"```", // 11
	"no language", // 12
	"```", // 13
	"", // 14
	"### Subsection", // 15
].join("\n");

describe("extractMarkdownSymbols", () => {
	const symbols = extractMarkdownSymbols(FIXTURE, "README.md", "markdown");

	it("extracts every ATX heading with the right level modifier", () => {
		const headings = symbols.filter((s) => s.kind === "heading");
		expect(headings.length).toBe(3);
		const h1 = headings.find((h) => h.name === "Top");
		expect(h1?.modifiers).toContain("h1");
		const h2 = headings.find((h) => h.name === "Section A");
		expect(h2?.modifiers).toContain("h2");
		const h3 = headings.find((h) => h.name === "Subsection");
		expect(h3?.modifiers).toContain("h3");
	});

	it("extracts a fenced code block with its language tag", () => {
		const blocks = symbols.filter((s) => s.kind === "code-block");
		expect(blocks.length).toBe(2);

		const tsBlock = blocks.find((b) => b.name === "typescript");
		expect(tsBlock).toBeDefined();
		expect(tsBlock?.startLine).toBe(7);
		expect(tsBlock?.endLine).toBe(9);
		expect(tsBlock?.modifiers).toContain("fenced");
	});

	it("extracts a fenced code block without a language as empty name", () => {
		const blocks = symbols.filter((s) => s.kind === "code-block");
		const empty = blocks.find((b) => b.name === "");
		expect(empty).toBeDefined();
		expect(empty?.startLine).toBe(11);
		expect(empty?.endLine).toBe(13);
	});

	it("does not extract inline content as headings", () => {
		const headings = symbols.filter((s) => s.kind === "heading");
		for (const h of headings) {
			expect(h.name).not.toBe("Intro paragraph.");
		}
	});
});

