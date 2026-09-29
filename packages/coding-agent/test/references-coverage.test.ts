/**
 * F1 reference resolution — coverage metadata.
 *
 * Verifies that `coverage.filesScanned`, `coverage.filesSkipped`, and
 * `coverage.manifestVersion` are populated deterministically. Uses a
 * small manifest (no large-manifest filter) so `filesSkipped` is 0.
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
let bPath: string;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "refs-cov-"));
	aPath = join(tmpDir, "a.ts");
	bPath = join(tmpDir, "b.ts");
	writeFileSync(aPath, "function foo() {}\nfoo();");
	writeFileSync(bPath, "function bar() {}\nbar();");
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function makeManifest(): FileManifestEntry[] {
	// Sorted by path so the manifest version is deterministic.
	return [
		{ path: "a.ts", absolutePath: aPath, byteLength: 0, language: "typescript", generated: false, ignored: false },
		{ path: "b.ts", absolutePath: bPath, byteLength: 0, language: "typescript", generated: false, ignored: false },
	];
}

describe("getReferences — coverage metadata", () => {
	it("reports filesScanned = files that were read, filesSkipped = 0 below threshold", async () => {
		const result = await getReferences("foo", makeManifest(), [], {});
		expect(result.coverage.filesScanned).toBe(2);
		expect(result.coverage.filesSkipped).toBe(0);
	});

	it("computes manifestVersion from length and first/last path", async () => {
		const result = await getReferences("foo", makeManifest(), [], {});
		expect(result.coverage.manifestVersion).toBe("2:a.ts:b.ts");
	});

	it("uses the literal 'empty' when the manifest has no entries", async () => {
		const result = await getReferences("foo", [], [], {});
		expect(result.coverage.manifestVersion).toBe("empty");
		expect(result.coverage.filesScanned).toBe(0);
		expect(result.coverage.filesSkipped).toBe(0);
	});

	it("skips files in large manifests that have no symbolIndex entry for the query", async () => {
		// Build a manifest of 1001 entries; only the first file is
		// flagged as relevant via the syntax index. The remaining
		// 1000 should be reported in `filesSkipped`.
		const manifest: FileManifestEntry[] = [];
		for (let i = 0; i < 1001; i += 1) {
			manifest.push({
				path: `f${i}.ts`,
				absolutePath: aPath, // path is irrelevant — file is never read
				byteLength: 0,
				language: "typescript",
				generated: false,
				ignored: false,
			});
		}
		const symbolIndex: SymbolEntry[] = [
			{ kind: "function", name: "foo", path: "f0.ts", startLine: 1, endLine: 1, language: "typescript" },
		];
		const result = await getReferences("foo", manifest, symbolIndex, {});
		expect(result.coverage.filesScanned).toBe(1);
		expect(result.coverage.filesSkipped).toBe(1000);
	});
});

