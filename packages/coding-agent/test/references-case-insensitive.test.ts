/**
 * F1 reference resolution — `caseSensitive` option.
 *
 * The fixture mixes `foo`, `FOO`, and `Foo`. Case-sensitive matching
 * (the default) only returns `foo`; case-insensitive returns all three.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { getReferences } from "../src/core/repository/references.ts";

let tmpDir: string;
let aPath: string;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "refs-case-"));
	aPath = join(tmpDir, "a.ts");
	const content = [
		"function foo() {}", // line 1 — exact case
		"function FOO() {}", // line 2 — different case (declaration)
		"function Foo() {}", // line 3 — different case (declaration)
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

describe("getReferences — case sensitivity", () => {
	it("default (caseSensitive: true) only matches the exact case", async () => {
		const result = await getReferences("foo", makeManifest(), [], {});
		expect(result.totalMatches).toBe(1);
		expect(result.references[0]?.startLine).toBe(1);
	});

	it("caseSensitive: false matches every casing", async () => {
		const result = await getReferences("foo", makeManifest(), [], { caseSensitive: false });
		expect(result.totalMatches).toBe(3);
		const lines = result.references.map((r) => r.startLine).sort((a, b) => a - b);
		expect(lines).toEqual([1, 2, 3]);
	});
});

