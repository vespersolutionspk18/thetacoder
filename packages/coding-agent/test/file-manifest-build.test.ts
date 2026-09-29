/**
 * F1 manifest — build() smoke test.
 *
 * Walks the real `packages/coding-agent/src/core/` directory and asserts
 * basic invariants: non-empty, relative forward-slash paths, sorted
 * order, and that at least one TypeScript file is present.
 */

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildManifest,
	detectLanguage,
	getByLanguage,
	resetPackageCacheForTests,
} from "../src/core/repository/manifest.ts";

const CORE_DIR = resolve(__dirname, "..", "src", "core");

describe("buildManifest on packages/coding-agent/src/core/", () => {
	it("returns a non-empty, sorted, relative-path manifest", async () => {
		resetPackageCacheForTests();
		const manifest = await buildManifest({ root: CORE_DIR });

		expect(manifest.length).toBeGreaterThan(0);

		// Every path is relative, forward-slash, and does not start with
		// an absolute prefix.
		for (const entry of manifest) {
			expect(entry.path).not.toMatch(/^[A-Za-z]:[\\/]/);
			expect(entry.path).not.toMatch(/^[\\/]/);
			expect(entry.path).toBe(entry.path.split("\\").join("/"));
		}

		// Result is sorted lexicographically by path.
		const sorted = [...manifest].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		expect(manifest.map((e) => e.path)).toEqual(sorted.map((e) => e.path));

		// At least one .ts file is detected as TypeScript.
		const tsEntries = getByLanguage(manifest, "typescript");
		expect(tsEntries.length).toBeGreaterThan(0);
		for (const entry of tsEntries) {
			expect(entry.path.endsWith(".ts") || entry.path.endsWith(".tsx")).toBe(true);
		}
	});

	it("detects the coding-agent package for nested source files", async () => {
		resetPackageCacheForTests();
		const manifest = await buildManifest({ root: CORE_DIR });
		const tsEntries = manifest.filter((e) => e.language === "typescript");
		expect(tsEntries.length).toBeGreaterThan(0);
		for (const entry of tsEntries) {
			expect(entry.package).toBe("@theta/coding-agent");
		}
	});

	it("exposes a working detectLanguage helper", () => {
		expect(detectLanguage("foo.ts")).toBe("typescript");
		expect(detectLanguage("foo/bar.tsx")).toBe("typescript");
		expect(detectLanguage("README")).toBeNull();
	});
});

