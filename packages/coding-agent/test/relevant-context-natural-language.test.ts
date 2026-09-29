/**
 * F1 getRelevantContext — natural-language identifier extraction.
 *
 * A free-form task description like "fix the myFunction in auth.ts"
 * should be parsed for identifiers. Identifiers shorter than 2
 * characters and common English stopwords must be dropped.
 */

import { describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { extractIdentifiersFromTask, getRelevantContext } from "../src/core/repository/relevant-context.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";

function makeManifest(): FileManifestEntry[] {
	return [
		{
			path: "src/auth.ts",
			absolutePath: "/abs/src/auth.ts",
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		},
		{
			path: "src/user.ts",
			absolutePath: "/abs/src/user.ts",
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		},
		{
			path: "src/utils.ts",
			absolutePath: "/abs/src/utils.ts",
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		},
	];
}

function makeIndex(): SymbolEntry[] {
	return [
		{ kind: "function", name: "myFunction", path: "src/auth.ts", startLine: 10, endLine: 20, language: "typescript" },
	];
}

describe("extractIdentifiersFromTask", () => {
	it("extracts CamelCase and snake_case identifiers from the natural-language task", () => {
		const out = extractIdentifiersFromTask("fix the myFunction in auth.ts");
		expect(out).toContain("myFunction");
		expect(out).toContain("auth");
	});

	it("drops English stopwords", () => {
		const out = extractIdentifiersFromTask("the cat is on the mat");
		// 'the' and 'is' are stopwords; 'cat'/'on'/'mat' are single tokens.
		expect(out).not.toContain("the");
		expect(out).not.toContain("is");
	});

	it("returns an empty array for an empty input", () => {
		expect(extractIdentifiersFromTask("")).toEqual([]);
	});

	it("deduplicates identifiers", () => {
		const out = extractIdentifiersFromTask("auth auth auth");
		expect(out.filter((x) => x === "auth")).toEqual(["auth"]);
	});
});

describe("getRelevantContext — natural-language identifier extraction", () => {
	it("surfaces the file and symbol whose name matches an extracted identifier", async () => {
		const result = await getRelevantContext({ task: "fix the myFunction in auth.ts" }, makeManifest(), makeIndex());

		const filePaths = result.items.filter((i) => i.kind === "file").map((i) => (i as { path: string }).path);
		expect(filePaths).toContain("src/auth.ts");

		const symbolNames = result.items.filter((i) => i.kind === "symbol").map((i) => (i as { name: string }).name);
		expect(symbolNames).toContain("myFunction");
	});
});

