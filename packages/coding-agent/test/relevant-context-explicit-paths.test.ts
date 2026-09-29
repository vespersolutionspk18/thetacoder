/**
 * F1 getRelevantContext — explicitPaths hint.
 *
 * A query that names a path should surface the matching manifest
 * entry with score 1.0, exact coverage, and the
 * "explicit-path" reason. The path hint does not require the file
 * to exist in the syntax index.
 */

import { describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { getRelevantContext } from "../src/core/repository/relevant-context.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";

function makeManifest(): FileManifestEntry[] {
	return [
		{
			path: "src/foo.ts",
			absolutePath: "/abs/src/foo.ts",
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		},
		{
			path: "src/bar.ts",
			absolutePath: "/abs/src/bar.ts",
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		},
		{
			path: "src/baz.ts",
			absolutePath: "/abs/src/baz.ts",
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		},
	];
}

function makeSymbolIndex(): SymbolEntry[] {
	return [];
}

describe("getRelevantContext — explicitPaths", () => {
	it("includes the file with score 1.0, exact coverage, and the explicit-path reason", async () => {
		const result = await getRelevantContext(
			{ task: "Look at foo", hints: { explicitPaths: ["src/foo.ts"] } },
			makeManifest(),
			makeSymbolIndex(),
		);

		const files = result.items.filter((i) => i.kind === "file");
		expect(files.length).toBe(1);
		const item = files[0];
		if (item.kind !== "file") throw new Error("expected file item");
		expect(item.path).toBe("src/foo.ts");
		expect(item.score).toBe(1.0);
		expect(item.coverage).toBe("exact");
		expect(item.reasons).toContain("explicit-path");
		expect(result.uncertainty).toBe("low");
	});

	it("matches only the paths the user listed", async () => {
		const result = await getRelevantContext(
			{ task: "Look at bar", hints: { explicitPaths: ["src/bar.ts"] } },
			makeManifest(),
			makeSymbolIndex(),
		);
		const files = result.items.filter((i) => i.kind === "file");
		expect(files.length).toBe(1);
		if (files[0].kind !== "file") throw new Error("expected file");
		expect(files[0].path).toBe("src/bar.ts");
	});

	it("ignores explicit paths that are not in the manifest", async () => {
		const result = await getRelevantContext(
			{ task: "Look at missing", hints: { explicitPaths: ["src/missing.ts"] } },
			makeManifest(),
			makeSymbolIndex(),
		);
		const files = result.items.filter((i) => i.kind === "file");
		expect(files.length).toBe(0);
	});
});

