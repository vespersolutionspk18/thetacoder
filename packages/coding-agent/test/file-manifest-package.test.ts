/**
 * F1 manifest — package detection.
 *
 * Creates a temp tree with nested `package.json` files and verifies that
 * each file's `package` field reflects the *nearest* `package.json` when
 * walking up.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildManifest, getByPackage, resetPackageCacheForTests } from "../src/core/repository/manifest.ts";

describe("package detection", () => {
	let tempRoot: string;

	beforeEach(async () => {
		resetPackageCacheForTests();
		tempRoot = await mkdtemp(join(tmpdir(), "theta-file-manifest-pkg-"));
	});

	afterEach(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("uses the nearest package.json walking up", async () => {
		// Outer package.
		await writeFile(join(tempRoot, "package.json"), JSON.stringify({ name: "outer-pkg", version: "1.0.0" }));
		// Inner package nested under `packages/inner`.
		await mkdir(join(tempRoot, "packages", "inner", "src"), { recursive: true });
		await writeFile(
			join(tempRoot, "packages", "inner", "package.json"),
			JSON.stringify({ name: "inner-pkg", version: "0.1.0" }),
		);

		await writeFile(join(tempRoot, "outer.ts"), "export const a = 1;\n");
		await writeFile(join(tempRoot, "packages", "inner", "src", "index.ts"), "export const b = 2;\n");
		// A file under the inner package but with no `src/` subdir.
		await writeFile(join(tempRoot, "packages", "inner", "top.ts"), "export const c = 3;\n");

		const manifest = await buildManifest({ root: tempRoot });

		const outer = manifest.find((e) => e.path === "outer.ts");
		expect(outer?.package).toBe("outer-pkg");

		const innerSrc = manifest.find((e) => e.path === "packages/inner/src/index.ts");
		expect(innerSrc?.package).toBe("inner-pkg");

		const innerTop = manifest.find((e) => e.path === "packages/inner/top.ts");
		expect(innerTop?.package).toBe("inner-pkg");

		// Group-by-package helper works.
		const innerEntries = getByPackage(manifest, "inner-pkg")
			.map((e) => e.path)
			.sort();
		expect(innerEntries).toEqual(["packages/inner/src/index.ts", "packages/inner/top.ts"]);

		const outerEntries = getByPackage(manifest, "outer-pkg").map((e) => e.path);
		expect(outerEntries).toEqual(["outer.ts"]);

		const none = getByPackage(manifest, "does-not-exist");
		expect(none).toEqual([]);
	});

	it("returns undefined package when no package.json is in the ancestry", async () => {
		await mkdir(join(tempRoot, "loose", "src"), { recursive: true });
		await writeFile(join(tempRoot, "loose", "src", "free.ts"), "export const z = 0;\n");

		const manifest = await buildManifest({ root: tempRoot });
		const free = manifest.find((e) => e.path === "loose/src/free.ts");
		expect(free).toBeDefined();
		expect(free?.package).toBeUndefined();
	});

	it("ignores package.json without a string name field", async () => {
		await writeFile(join(tempRoot, "package.json"), JSON.stringify({ version: "1.0.0" }));
		await writeFile(join(tempRoot, "x.ts"), "export const x = 1;\n");

		const manifest = await buildManifest({ root: tempRoot });
		const x = manifest.find((e) => e.path === "x.ts");
		expect(x).toBeDefined();
		// `name` is missing → walk continues but no name is set.
		expect(x?.package).toBeUndefined();
	});
});

