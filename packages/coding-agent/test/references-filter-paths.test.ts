/**
 * F1 reference resolution — filter by `paths`.
 *
 * A manifest with two files; the caller restricts the scan to
 * `src/a.ts`. The `src/b.ts` matches must not appear in the result.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { getReferences } from "../src/core/repository/references.ts";

let tmpDir: string;
let aPath: string;
let bPath: string;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "refs-paths-"));
	const srcDir = join(tmpDir, "src");
	// mkdtempSync guarantees `tmpDir` exists; we still need `src/`
	// because writeFileSync does not create parent directories.
	mkdirSync(srcDir);
	aPath = join(srcDir, "a.ts");
	bPath = join(srcDir, "b.ts");
	writeFileSync(aPath, "function foo() { return foo; }");
	writeFileSync(bPath, ["function bar() {}", "foo = 1;"].join("\n"));
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function makeManifest(): FileManifestEntry[] {
	return [
		{
			path: "src/a.ts",
			absolutePath: aPath,
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		},
		{
			path: "src/b.ts",
			absolutePath: bPath,
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		},
	];
}

describe("getReferences — paths filter", () => {
	it("only scans the listed paths", async () => {
		const result = await getReferences("foo", makeManifest(), [], { paths: ["src/a.ts"] });

		expect(result.references.length).toBeGreaterThan(0);
		for (const ref of result.references) {
			expect(ref.path).toBe("src/a.ts");
		}
	});

	it("ignores other files in the manifest", async () => {
		// `src/b.ts` contains a `foo = 1;` line, but it's excluded.
		const filtered = await getReferences("foo", makeManifest(), [], { paths: ["src/a.ts"] });
		const unfiltered = await getReferences("foo", makeManifest(), [], {});
		expect(filtered.references.length).toBeLessThan(unfiltered.references.length);
	});
});

