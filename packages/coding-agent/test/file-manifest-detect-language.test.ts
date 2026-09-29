/**
 * F1 manifest — detectLanguage() coverage.
 *
 * One assertion per extension listed in the F1 spec, plus a few extras
 * (e.g. `.mdx`) and negative cases.
 */

import { describe, expect, it } from "vitest";
import { detectLanguage } from "../src/core/repository/manifest.ts";

describe("detectLanguage", () => {
	const cases: Array<{ path: string; expected: string }> = [
		{ path: "src/index.ts", expected: "typescript" },
		{ path: "src/component.tsx", expected: "typescript" },
		{ path: "src/util.js", expected: "javascript" },
		{ path: "src/component.jsx", expected: "javascript" },
		{ path: "src/module.mjs", expected: "javascript" },
		{ path: "src/legacy.cjs", expected: "javascript" },
		{ path: "package.json", expected: "json" },
		{ path: "README.md", expected: "markdown" },
		{ path: "scripts/build.py", expected: "python" },
		{ path: "src/main.rs", expected: "rust" },
		{ path: "cmd/foo/main.go", expected: "go" },
		{ path: "src/com/example/Main.java", expected: "java" },
		{ path: "src/native.c", expected: "c" },
		{ path: "src/native.cpp", expected: "cpp" },
		{ path: "include/widget.h", expected: "c" },
		{ path: "include/widget.hpp", expected: "cpp" },
		{ path: "scripts/install.sh", expected: "shell" },
		{ path: ".github/workflows/ci.yml", expected: "yaml" },
		{ path: "config.yaml", expected: "yaml" },
		{ path: "pyproject.toml", expected: "toml" },
		{ path: "public/index.html", expected: "html" },
		{ path: "src/styles.css", expected: "css" },
		{ path: "src/styles.scss", expected: "scss" },
		{ path: "src/App.vue", expected: "vue" },
		{ path: "src/App.svelte", expected: "svelte" },
	];

	for (const { path, expected } of cases) {
		it(`maps ${path} → ${expected}`, () => {
			expect(detectLanguage(path)).toBe(expected);
		});
	}

	it("is case-insensitive on the extension", () => {
		expect(detectLanguage("FOO.TS")).toBe("typescript");
		expect(detectLanguage("Bar.MD")).toBe("markdown");
	});

	it("returns null for unknown extensions and dotfiles without an extension", () => {
		expect(detectLanguage("image.png")).toBeNull();
		expect(detectLanguage("archive.tar")).toBeNull();
		// `.gitignore` has a leading dot but no `name.ext` shape.
		expect(detectLanguage(".gitignore")).toBeNull();
	});

	it("does not confuse a directory named with a dot", () => {
		// `src` has no extension → null.
		expect(detectLanguage("src")).toBeNull();
	});
});

