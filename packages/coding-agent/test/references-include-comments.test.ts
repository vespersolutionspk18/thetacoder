/**
 * F1 reference resolution — `includeComments: true`.
 *
 * Comment-zone matches must be returned, classified as
 * `kind: "comment-mention"`. The line still appears in `context`.
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
	tmpDir = mkdtempSync(join(tmpdir(), "refs-incc-"));
	aPath = join(tmpDir, "a.ts");
	const content = [
		"function foo() {}", // 1 real reference
		"// foo in a comment", // 2 comment-mention
		"/* foo in a block comment */", // 3 comment-mention
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

describe("getReferences — includeComments: true", () => {
	it("includes comment-zone matches classified as comment-mention", async () => {
		const result = await getReferences("foo", makeManifest(), [], { includeComments: true });

		expect(result.references.length).toBe(3);
		const commentRefs = result.references.filter((r) => r.kind === "comment-mention");
		expect(commentRefs.length).toBe(2);
		const commentLines = commentRefs.map((r) => r.startLine).sort((a, b) => a - b);
		expect(commentLines).toEqual([2, 3]);

		// The non-comment reference is still classified normally.
		const decl = result.references.find((r) => r.startLine === 1);
		expect(decl?.kind).toBe("declaration");
	});

	it("does not include block-comment matches when includeComments is false", async () => {
		const result = await getReferences("foo", makeManifest(), [], { includeComments: false });
		const blockRef = result.references.find((r) => r.startLine === 3);
		expect(blockRef).toBeUndefined();
	});
});

