/**
 * F1 read-only tool — `find-f1`.
 *
 * Builds a manifest and asserts the tool filters by language, package,
 * and glob, returning one path per line.
 */

import { describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { createF1ReadOnlyToolDefinitions } from "../src/core/tools/f1-readonly.ts";

function makeManifest(): FileManifestEntry[] {
	return [
		{
			path: "src/a.ts",
			absolutePath: "/abs/src/a.ts",
			byteLength: 100,
			language: "typescript",
			package: "@theta/agent",
			generated: false,
			ignored: false,
		},
		{
			path: "src/b.ts",
			absolutePath: "/abs/src/b.ts",
			byteLength: 200,
			language: "typescript",
			package: "@theta/ai",
			generated: false,
			ignored: false,
		},
		{
			path: "src/c.py",
			absolutePath: "/abs/src/c.py",
			byteLength: 300,
			language: "python",
			package: "@theta/agent",
			generated: false,
			ignored: false,
		},
		{
			path: "docs/README.md",
			absolutePath: "/abs/docs/README.md",
			byteLength: 400,
			language: "markdown",
			package: "@theta/agent",
			generated: false,
			ignored: false,
		},
		{
			path: "dist/bundle.js",
			absolutePath: "/abs/dist/bundle.js",
			byteLength: 99999,
			language: "javascript",
			package: "@theta/agent",
			generated: true,
			ignored: false,
		},
	];
}

function pickFind(tools: ReturnType<typeof createF1ReadOnlyToolDefinitions>) {
	const tool = tools.find((t) => t.name === "find-f1");
	if (!tool) throw new Error("find-f1 not registered");
	return tool;
}

describe("F1 read-only — find-f1", () => {
	it("description mentions F1 and the worktree caveat", () => {
		const tool = pickFind(
			createF1ReadOnlyToolDefinitions({ manifest: makeManifest(), symbolIndex: [], cwd: "/abs" }),
		);
		expect(tool.description).toMatch(/F1-backed/);
		expect(tool.description).toMatch(/worktree/);
	});

	it("filters by language only", async () => {
		const tool = pickFind(
			createF1ReadOnlyToolDefinitions({ manifest: makeManifest(), symbolIndex: [], cwd: "/abs" }),
		);
		const result = await tool.execute("call-1", { pattern: "**/*", language: "typescript" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		const paths = text.split("\n").sort();
		expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("filters by language AND package", async () => {
		const tool = pickFind(
			createF1ReadOnlyToolDefinitions({ manifest: makeManifest(), symbolIndex: [], cwd: "/abs" }),
		);
		const result = await tool.execute("call-2", {
			pattern: "**/*",
			language: "typescript",
			package: "@theta/agent",
		});
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text.split("\n")).toEqual(["src/a.ts"]);
	});

	it("filters by glob (no language filter)", async () => {
		const tool = pickFind(
			createF1ReadOnlyToolDefinitions({ manifest: makeManifest(), symbolIndex: [], cwd: "/abs" }),
		);
		const result = await tool.execute("call-3", { pattern: "src/**" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		const paths = text.split("\n").sort();
		expect(paths).toEqual(["src/a.ts", "src/b.ts", "src/c.py"]);
	});

	it("excludes generated files by default", async () => {
		const tool = pickFind(
			createF1ReadOnlyToolDefinitions({ manifest: makeManifest(), symbolIndex: [], cwd: "/abs" }),
		);
		const result = await tool.execute("call-4", { pattern: "**/*" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		const paths = text.split("\n");
		// The generated `dist/bundle.js` entry is filtered out.
		expect(paths).not.toContain("dist/bundle.js");
	});

	it("includes generated files when includeGenerated is set", async () => {
		const tool = pickFind(
			createF1ReadOnlyToolDefinitions({
				manifest: makeManifest(),
				symbolIndex: [],
				cwd: "/abs",
				includeGenerated: true,
			}),
		);
		const result = await tool.execute("call-5", { pattern: "dist/**" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text.split("\n")).toEqual(["dist/bundle.js"]);
	});

	it("returns the empty result message when nothing matches", async () => {
		const tool = pickFind(
			createF1ReadOnlyToolDefinitions({ manifest: makeManifest(), symbolIndex: [], cwd: "/abs" }),
		);
		const result = await tool.execute("call-6", { pattern: "**/*.rs" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toBe("No files found matching pattern");
	});

	it("uses '**/*' as the default pattern when pattern is omitted", async () => {
		const tool = pickFind(
			createF1ReadOnlyToolDefinitions({ manifest: makeManifest(), symbolIndex: [], cwd: "/abs" }),
		);
		const result = await tool.execute("call-7", {});
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		const paths = text.split("\n").sort();
		// All non-generated files.
		expect(paths).toEqual(["docs/README.md", "src/a.ts", "src/b.ts", "src/c.py"]);
	});
});

