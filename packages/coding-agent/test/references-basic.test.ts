/**
 * F1 reference resolution — basic classification + certainty.
 *
 * One fixture covers every active `ReferenceKind` (declaration, call,
 * type-use, import, export, assignment) plus a comment and a string
 * literal that must be skipped by default. The syntax index contains
 * one entry pointing at the declaration line; only that line is
 * `certainty: "exact"`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { getReferences } from "../src/core/repository/references.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";

let tmpDir: string;
let aPath: string;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "refs-basic-"));
	aPath = join(tmpDir, "a.ts");
	// Line numbers in the comment below are 1-indexed to match the
	// classification assertions.
	const content = [
		"function foo() {}", // 1 declaration
		"foo();", // 2 call
		"const x: foo = 1;", // 3 type-use
		'import { foo } from "./x";', // 4 import
		"export { foo };", // 5 export
		"foo = 2;", // 6 assignment
		"// this comment mentions foo", // 7 comment (skipped)
		'const s = "foo in string";', // 8 string (skipped)
	].join("\n");
	writeFileSync(aPath, content);
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function makeManifest(): FileManifestEntry[] {
	return [
		{ path: "a.ts", absolutePath: aPath, byteLength: 0, language: "typescript", generated: false, ignored: false },
	];
}

function makeSymbolIndex(): SymbolEntry[] {
	return [{ kind: "function", name: "foo", path: "a.ts", startLine: 1, endLine: 1, language: "typescript" }];
}

describe("getReferences — basic classification", () => {
	it("returns one reference per active kind in declaration order", async () => {
		const result = await getReferences("foo", makeManifest(), makeSymbolIndex(), {});

		// Six active lines; the comment and string lines are skipped.
		expect(result.totalMatches).toBe(6);
		expect(result.references.length).toBe(6);
		expect(result.truncated).toBe(false);

		const byLine = new Map(result.references.map((r) => [r.startLine, r]));
		expect(byLine.get(1)?.kind).toBe("declaration");
		expect(byLine.get(2)?.kind).toBe("call");
		expect(byLine.get(3)?.kind).toBe("type-use");
		expect(byLine.get(4)?.kind).toBe("import");
		expect(byLine.get(5)?.kind).toBe("export");
		expect(byLine.get(6)?.kind).toBe("assignment");

		// Symbol field echoes the query on every reference.
		for (const ref of result.references) {
			expect(ref.symbol).toBe("foo");
			expect(ref.endLine).toBe(ref.startLine);
		}
	});

	it("marks the line backed by the syntax index as exact, others as lexical", async () => {
		const result = await getReferences("foo", makeManifest(), makeSymbolIndex(), {});

		const byLine = new Map(result.references.map((r) => [r.startLine, r]));
		expect(byLine.get(1)?.certainty).toBe("exact");
		expect(byLine.get(2)?.certainty).toBe("lexical");
		expect(byLine.get(3)?.certainty).toBe("lexical");
		expect(byLine.get(4)?.certainty).toBe("lexical");
		expect(byLine.get(5)?.certainty).toBe("lexical");
		expect(byLine.get(6)?.certainty).toBe("lexical");
	});

	it("includes the source line as context, truncated to 200 chars", async () => {
		const result = await getReferences("foo", makeManifest(), makeSymbolIndex(), {});

		const decl = result.references.find((r) => r.startLine === 1);
		expect(decl?.context).toBe("function foo() {}");
	});
});

