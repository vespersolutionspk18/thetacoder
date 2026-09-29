/**
 * F1 reference resolution — pagination via `maxResults`.
 *
 * A file with 10 call lines; the caller sets `maxResults: 5`. The
 * returned `references` must be capped, but `totalMatches` must still
 * reflect the full count and `truncated` must be `true`.
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
	tmpDir = mkdtempSync(join(tmpdir(), "refs-pag-"));
	aPath = join(tmpDir, "a.ts");
	const lines: string[] = [];
	for (let i = 0; i < 10; i += 1) lines.push(`foo(${i});`);
	writeFileSync(aPath, lines.join("\n"));
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function makeManifest(): FileManifestEntry[] {
	return [
		{ path: "a.ts", absolutePath: aPath, byteLength: 0, language: "typescript", generated: false, ignored: false },
	];
}

describe("getReferences — pagination", () => {
	it("caps the returned array at maxResults and reports the true total", async () => {
		const result = await getReferences("foo", makeManifest(), [], { maxResults: 5 });

		expect(result.references.length).toBe(5);
		expect(result.totalMatches).toBe(10);
		expect(result.truncated).toBe(true);
	});

	it("returns everything when maxResults is above the actual count", async () => {
		const result = await getReferences("foo", makeManifest(), [], { maxResults: 100 });
		expect(result.references.length).toBe(10);
		expect(result.totalMatches).toBe(10);
		expect(result.truncated).toBe(false);
	});
});

