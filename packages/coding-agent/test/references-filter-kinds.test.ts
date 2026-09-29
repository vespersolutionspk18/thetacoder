/**
 * F1 reference resolution — filter by `kinds`.
 *
 * Same fixture as the basic test; only `declaration` and `call`
 * references should be returned when the kinds filter is set.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { getReferences, type ReferenceKind } from "../src/core/repository/references.ts";

let tmpDir: string;
let aPath: string;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "refs-kinds-"));
	aPath = join(tmpDir, "a.ts");
	const content = [
		"function foo() {}",
		"foo();",
		"const x: foo = 1;",
		'import { foo } from "./x";',
		"export { foo };",
		"foo = 2;",
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

describe("getReferences — kinds filter", () => {
	it("returns only the kinds the caller asked for", async () => {
		const allowed: ReferenceKind[] = ["declaration", "call"];
		const result = await getReferences("foo", makeManifest(), [], { kinds: allowed });

		expect(result.references.length).toBe(2);
		const kinds = result.references.map((r) => r.kind).sort();
		expect(kinds).toEqual(["call", "declaration"]);
	});

	it("returns [] when the kinds filter excludes everything in the file", async () => {
		const result = await getReferences("foo", makeManifest(), [], { kinds: ["string-mention"] });
		expect(result.references).toEqual([]);
		// totalMatches still counts active matches (kind filter is
		// separate from zone filtering).
		expect(result.totalMatches).toBe(6);
		expect(result.truncated).toBe(false);
	});
});

