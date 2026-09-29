/**
 * F1 syntax index — edge cases.
 *
 * Empty files, single-line files, malformed input, and
 * `maxSymbolsPerFile` enforcement all need to behave without
 * throwing.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import {
	buildSyntaxIndex,
	extractJsonSymbols,
	extractMarkdownSymbols,
	extractPythonSymbols,
	extractTypeScriptSymbols,
} from "../src/core/repository/syntax-index.ts";

describe("edge cases — extractors on degenerate input", () => {
	it("returns [] for an empty TypeScript file", () => {
		expect(extractTypeScriptSymbols("", "empty.ts", "typescript")).toEqual([]);
	});

	it("returns [] for a single-line file with no declarations", () => {
		expect(extractTypeScriptSymbols("// nothing here", "x.ts", "typescript")).toEqual([]);
	});

	it("returns [] for an empty Python file", () => {
		expect(extractPythonSymbols("", "empty.py", "python")).toEqual([]);
	});

	it("returns [] for an empty JSON file (parse error → [])", () => {
		expect(extractJsonSymbols("", "empty.json", "json")).toEqual([]);
	});

	it("returns [] for an empty Markdown file", () => {
		expect(extractMarkdownSymbols("", "empty.md", "markdown")).toEqual([]);
	});

	it("does not throw on a malformed (unclosed brace) TypeScript file", () => {
		const malformed = [
			"function broken() {", // 1
			"  return 1", // 2
			"// no closing brace", // 3
		].join("\n");
		const out = extractTypeScriptSymbols(malformed, "broken.ts", "typescript");
		// Should still extract the function declaration even if the
		// body is malformed.
		expect(out.find((s) => s.name === "broken" && s.kind === "function")).toBeDefined();
	});

	it("does not throw on a malformed JSON file (parse fails → [])", () => {
		const out = extractJsonSymbols("{ broken: not valid,", "x.json", "json");
		expect(out).toEqual([]);
	});

	it("does not throw on an unterminated fenced Markdown code block", () => {
		const truncated = ["# Heading", "```typescript", "const x = 1;"].join("\n");
		const out = extractMarkdownSymbols(truncated, "x.md", "markdown");
		// Heading still extracted.
		expect(out.find((s) => s.kind === "heading" && s.name === "Heading")).toBeDefined();
		// Unterminated code-block recorded with the unterminated modifier.
		const cb = out.find((s) => s.kind === "code-block");
		expect(cb).toBeDefined();
		expect(cb?.modifiers).toContain("unterminated");
	});
});

describe("edge cases — buildSyntaxIndex dispatcher", () => {
	async function writeFixture(name: string, content: string): Promise<{ manifest: FileManifestEntry[]; dir: string }> {
		const dir = await mkdtemp(join(tmpdir(), "syn-edge-"));
		const file = join(dir, name);
		await writeFile(file, content, "utf-8");
		const manifest: FileManifestEntry[] = [
			{
				path: name,
				absolutePath: file,
				byteLength: content.length,
				language: detectLang(name),
				generated: false,
				ignored: false,
			},
		];
		return { manifest, dir };
	}

	function detectLang(name: string): string {
		if (name.endsWith(".ts")) return "typescript";
		if (name.endsWith(".py")) return "python";
		if (name.endsWith(".json")) return "json";
		if (name.endsWith(".md")) return "markdown";
		return "unknown";
	}

	it("enforces maxSymbolsPerFile and does not throw", async () => {
		// A file with 50 functions: cap at 10.
		const lines: string[] = [];
		for (let i = 0; i < 50; i += 1) lines.push(`export function f${i}() {}`);
		const { manifest, dir } = await writeFixture("many.ts", lines.join("\n"));
		try {
			const idx = await buildSyntaxIndex(manifest, { maxSymbolsPerFile: 10 });
			expect(idx.length).toBe(10);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("returns [] for an empty file via the dispatcher", async () => {
		const { manifest, dir } = await writeFixture("empty.ts", "");
		try {
			const idx = await buildSyntaxIndex(manifest);
			expect(idx).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("returns [] for an unsupported language without throwing", async () => {
		const { manifest, dir } = await writeFixture("binary.rs", "fn main() {}");
		try {
			const idx = await buildSyntaxIndex(manifest);
			expect(idx).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("filters by the `languages` option", async () => {
		const { manifest, dir } = await writeFixture("x.ts", "function real() {}");
		try {
			const idx = await buildSyntaxIndex(manifest, { languages: ["python"] });
			expect(idx).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("sorts the index by (path, startLine, kind)", async () => {
		const a = await writeFixture("a.ts", "function b() {}\nfunction a() {}");
		const c = await writeFixture("c.ts", "function z() {}");
		const manifest = [...a.manifest, ...c.manifest];
		try {
			const idx = await buildSyntaxIndex(manifest);
			expect(idx.length).toBe(3);
			expect(idx.map((s) => `${s.path}:${s.startLine}:${s.name}`)).toEqual(["a.ts:1:b", "a.ts:2:a", "c.ts:1:z"]);
		} finally {
			await rm(a.dir, { recursive: true, force: true });
			await rm(c.dir, { recursive: true, force: true });
		}
	});
});

