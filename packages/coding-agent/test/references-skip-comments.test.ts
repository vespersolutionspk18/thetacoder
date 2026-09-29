/**
 * F1 reference resolution — default behaviour: skip comment mentions.
 *
 * `includeComments` defaults to `false`, so a `// foo` line must not
 * appear in the results. A non-comment reference to the same symbol
 * in the same file must still be returned.
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
	tmpDir = mkdtempSync(join(tmpdir(), "refs-skip-"));
	aPath = join(tmpDir, "a.ts");
	const content = [
		"function foo() {}", // 1 real reference (declaration)
		"// foo in a comment", // 2 must be skipped
		"/* foo in a block comment */", // 3 must be skipped
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

describe("getReferences — skip comments by default", () => {
	it("omits line and block comment matches when includeComments is unset", async () => {
		const result = await getReferences("foo", makeManifest(), [], {});

		expect(result.references.length).toBe(1);
		expect(result.references[0]?.startLine).toBe(1);
		expect(result.references[0]?.kind).toBe("declaration");
		// totalMatches reflects the active line only.
		expect(result.totalMatches).toBe(1);
	});

	it("explicitly setting includeComments: false has the same effect", async () => {
		const result = await getReferences("foo", makeManifest(), [], { includeComments: false });
		expect(result.references.length).toBe(1);
	});
});

