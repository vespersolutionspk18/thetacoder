/**
 * F1 manifest — generated / ignored flagging.
 *
 * Creates a temp directory with the classic noise directories and a
 * generated file, then builds the manifest with `includeIgnored: true`
 * so we can inspect the flags directly.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildManifest,
	getByLanguage,
	isGeneratedPath,
	isIgnoredPath,
	resetPackageCacheForTests,
} from "../src/core/repository/manifest.ts";

describe("isGeneratedPath", () => {
	it("matches *.generated.* filenames", () => {
		expect(isGeneratedPath("src/foo.generated.ts")).toBe(true);
		expect(isGeneratedPath("proto/bar.generated.proto")).toBe(true);
	});

	it("matches known build output directories", () => {
		expect(isGeneratedPath("dist/bundle.js")).toBe(true);
		expect(isGeneratedPath("packages/foo/dist/index.js")).toBe(true);
		expect(isGeneratedPath("build/output/main.js")).toBe(true);
		expect(isGeneratedPath(".next/static/chunks/main.js")).toBe(true);
		expect(isGeneratedPath("coverage/lcov.info")).toBe(true);
		expect(isGeneratedPath("out/index.html")).toBe(true);
	});

	it("matches minified JS and CSS", () => {
		expect(isGeneratedPath("public/app.min.js")).toBe(true);
		expect(isGeneratedPath("public/app.min.css")).toBe(true);
	});

	it("does not flag regular source files", () => {
		expect(isGeneratedPath("src/index.ts")).toBe(false);
		expect(isGeneratedPath("packages/foo/src/index.ts")).toBe(false);
		expect(isGeneratedPath("README.md")).toBe(false);
	});
});

describe("isIgnoredPath", () => {
	it("always ignores .git, node_modules, .theta, .theta segments", () => {
		expect(isIgnoredPath(".git/HEAD")).toBe(true);
		expect(isIgnoredPath("packages/foo/node_modules/x/index.js")).toBe(true);
		expect(isIgnoredPath(".theta/state.json")).toBe(true);
		expect(isIgnoredPath(".theta/cache/x.json")).toBe(true);
	});

	it("respects provided gitignore patterns", () => {
		expect(isIgnoredPath("build/output.js", ["build/"])).toBe(true);
		expect(isIgnoredPath("logs/error.log", ["*.log"])).toBe(true);
		expect(isIgnoredPath("docs/x.md", ["*.log"])).toBe(false);
	});

	it("supports negation patterns", () => {
		// Even with `*.log` ignored, `!keep.log` is un-ignored.
		expect(isIgnoredPath("keep.log", ["*.log", "!keep.log"])).toBe(false);
		// Without the negation, it is ignored.
		expect(isIgnoredPath("keep.log", ["*.log"])).toBe(true);
	});

	it("ignores blank lines and comments in gitignore patterns", () => {
		expect(isIgnoredPath("foo.log", ["", "# this is a comment", "*.log"])).toBe(true);
		expect(isIgnoredPath("foo.md", ["", "# comment", "*.log"])).toBe(false);
	});

	it("returns false when no patterns match and no built-in dir is hit", () => {
		expect(isIgnoredPath("src/index.ts")).toBe(false);
		expect(isIgnoredPath("src/index.ts", [])).toBe(false);
	});
});

describe("buildManifest with generated + ignored content", () => {
	let tempRoot: string;

	beforeEach(async () => {
		resetPackageCacheForTests();
		tempRoot = await mkdtemp(join(tmpdir(), "theta-file-manifest-ignore-"));
		// Lay out a fixture:
		//   src/keep.ts           — regular file
		//   src/foo.generated.ts  — generated
		//   dist/bundle.js        — generated
		//   coverage/lcov.info    — generated
		//   .git/HEAD             — ignored (built-in)
		//   node_modules/x/index.js — ignored (built-in)
		//   ignored.log           — ignored by gitignore
		await mkdir(join(tempRoot, "src"), { recursive: true });
		await mkdir(join(tempRoot, "dist"), { recursive: true });
		await mkdir(join(tempRoot, "coverage"), { recursive: true });
		await mkdir(join(tempRoot, ".git"), { recursive: true });
		await mkdir(join(tempRoot, "node_modules", "x"), { recursive: true });
		await writeFile(join(tempRoot, "src", "keep.ts"), "export const x = 1;\n");
		await writeFile(join(tempRoot, "src", "foo.generated.ts"), "export const y = 2;\n");
		await writeFile(join(tempRoot, "dist", "bundle.js"), "console.log('hi');\n");
		await writeFile(join(tempRoot, "coverage", "lcov.info"), "TN:\n");
		await writeFile(join(tempRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
		await writeFile(join(tempRoot, "node_modules", "x", "index.js"), "module.exports = {};\n");
		await writeFile(join(tempRoot, "ignored.log"), "noise\n");
	});

	afterEach(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("flags ignored and generated entries, and includes them with includeIgnored:true", async () => {
		const manifest = await buildManifest({
			root: tempRoot,
			includeIgnored: true,
			gitignorePatterns: ["*.log"],
		});
		const byPath = new Map(manifest.map((e) => [e.path, e]));

		// Regular source file: present, not generated, not ignored.
		const keep = byPath.get("src/keep.ts");
		expect(keep).toBeDefined();
		expect(keep?.generated).toBe(false);
		expect(keep?.ignored).toBe(false);

		// `*.generated.*` flag.
		const generated = byPath.get("src/foo.generated.ts");
		expect(generated).toBeDefined();
		expect(generated?.generated).toBe(true);

		// Build output directories.
		const dist = byPath.get("dist/bundle.js");
		expect(dist).toBeDefined();
		expect(dist?.generated).toBe(true);

		const coverage = byPath.get("coverage/lcov.info");
		expect(coverage).toBeDefined();
		expect(coverage?.generated).toBe(true);

		// Hard-coded ignore directories.
		const git = byPath.get(".git/HEAD");
		expect(git).toBeDefined();
		expect(git?.ignored).toBe(true);

		const nm = byPath.get("node_modules/x/index.js");
		expect(nm).toBeDefined();
		expect(nm?.ignored).toBe(true);

		// Gitignore-driven ignore.
		const log = byPath.get("ignored.log");
		expect(log).toBeDefined();
		expect(log?.ignored).toBe(true);
	});

	it("drops ignored entries when includeIgnored is false (default)", async () => {
		const manifest = await buildManifest({
			root: tempRoot,
			gitignorePatterns: ["*.log"],
		});
		const paths = manifest.map((e) => e.path);
		expect(paths).toContain("src/keep.ts");
		expect(paths).toContain("src/foo.generated.ts");
		expect(paths).toContain("dist/bundle.js");
		expect(paths).toContain("coverage/lcov.info");
		expect(paths).not.toContain(".git/HEAD");
		expect(paths).not.toContain("node_modules/x/index.js");
		expect(paths).not.toContain("ignored.log");
	});

	it("getByLanguage filters only by language (ignoring generated/ignored flags)", async () => {
		const manifest = await buildManifest({
			root: tempRoot,
			includeIgnored: true,
			gitignorePatterns: ["*.log"],
		});
		const ts = getByLanguage(manifest, "typescript");
		const tsPaths = ts.map((e) => e.path).sort();
		expect(tsPaths).toEqual(["src/foo.generated.ts", "src/keep.ts"]);
		const js = getByLanguage(manifest, "javascript");
		const jsPaths = js.map((e) => e.path).sort();
		expect(jsPaths).toEqual(["dist/bundle.js", "node_modules/x/index.js"]);
	});
});

