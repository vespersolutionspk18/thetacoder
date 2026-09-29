/**
 * F1 read-only tool — `ls-f1`.
 *
 * Calls the tool with a directory prefix and asserts the manifest
 * entries are returned with byteLength and language per file.
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
			generated: false,
			ignored: false,
		},
		{
			path: "src/b.ts",
			absolutePath: "/abs/src/b.ts",
			byteLength: 250,
			language: "typescript",
			generated: false,
			ignored: false,
		},
		{
			path: "src/nested/c.py",
			absolutePath: "/abs/src/nested/c.py",
			byteLength: 300,
			language: "python",
			generated: false,
			ignored: false,
		},
		{
			path: "docs/README.md",
			absolutePath: "/abs/docs/README.md",
			byteLength: 400,
			language: "markdown",
			generated: false,
			ignored: false,
		},
		{
			path: "dist/bundle.js",
			absolutePath: "/abs/dist/bundle.js",
			byteLength: 99999,
			language: "javascript",
			generated: true,
			ignored: false,
		},
	];
}

function pickLs(tools: ReturnType<typeof createF1ReadOnlyToolDefinitions>) {
	const tool = tools.find((t) => t.name === "ls-f1");
	if (!tool) throw new Error("ls-f1 not registered");
	return tool;
}

describe("F1 read-only — ls-f1", () => {
	it("description mentions F1 and the worktree caveat", () => {
		const tool = pickLs(createF1ReadOnlyToolDefinitions({ manifest: makeManifest(), symbolIndex: [], cwd: "/abs" }));
		expect(tool.description).toMatch(/F1-backed/);
		expect(tool.description).toMatch(/worktree/);
	});

	it("returns every non-generated entry when no path is given, with byteLength and language", async () => {
		const tool = pickLs(createF1ReadOnlyToolDefinitions({ manifest: makeManifest(), symbolIndex: [], cwd: "/abs" }));
		const result = await tool.execute("call-1", {});
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		const lines = text.split("\n").sort();
		// `dist/bundle.js` is generated, so it is excluded by default.
		expect(lines).toEqual([
			"docs/README.md\t400\tmarkdown",
			"src/a.ts\t100\ttypescript",
			"src/b.ts\t250\ttypescript",
			"src/nested/c.py\t300\tpython",
		]);
	});

	it("returns nested entries when a directory prefix is given", async () => {
		const tool = pickLs(createF1ReadOnlyToolDefinitions({ manifest: makeManifest(), symbolIndex: [], cwd: "/abs" }));
		const result = await tool.execute("call-2", { path: "src/" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		const lines = text.split("\n").sort();
		expect(lines).toEqual(["src/a.ts\t100\ttypescript", "src/b.ts\t250\ttypescript", "src/nested/c.py\t300\tpython"]);
	});

	it("matches a single file when the prefix is an exact file path", async () => {
		const tool = pickLs(createF1ReadOnlyToolDefinitions({ manifest: makeManifest(), symbolIndex: [], cwd: "/abs" }));
		const result = await tool.execute("call-3", { path: "src/a.ts" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text.split("\n")).toEqual(["src/a.ts\t100\ttypescript"]);
	});

	it("normalizes backslash separators in the path argument", async () => {
		const tool = pickLs(createF1ReadOnlyToolDefinitions({ manifest: makeManifest(), symbolIndex: [], cwd: "/abs" }));
		const result = await tool.execute("call-4", { path: "src\\" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		const lines = text.split("\n").sort();
		expect(lines).toEqual(["src/a.ts\t100\ttypescript", "src/b.ts\t250\ttypescript", "src/nested/c.py\t300\tpython"]);
	});

	it("strips a leading './' from the path argument", async () => {
		const tool = pickLs(createF1ReadOnlyToolDefinitions({ manifest: makeManifest(), symbolIndex: [], cwd: "/abs" }));
		const result = await tool.execute("call-5", { path: "./docs" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text.split("\n")).toEqual(["docs/README.md\t400\tmarkdown"]);
	});

	it("returns '(empty directory)' when no entries match the prefix", async () => {
		const tool = pickLs(createF1ReadOnlyToolDefinitions({ manifest: makeManifest(), symbolIndex: [], cwd: "/abs" }));
		const result = await tool.execute("call-6", { path: "nope/" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toBe("(empty directory)");
	});

	it("respects the limit cap", async () => {
		const tool = pickLs(createF1ReadOnlyToolDefinitions({ manifest: makeManifest(), symbolIndex: [], cwd: "/abs" }));
		const result = await tool.execute("call-7", { limit: 2 });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		const lines = text.split("\n");
		expect(lines.length).toBe(2);
	});

	it("uses empty string for unknown language", async () => {
		const manifest: FileManifestEntry[] = [
			{
				path: "weird.xyz",
				absolutePath: "/abs/weird.xyz",
				byteLength: 7,
				language: null,
				generated: false,
				ignored: false,
			},
		];
		const tool = pickLs(createF1ReadOnlyToolDefinitions({ manifest, symbolIndex: [], cwd: "/abs" }));
		const result = await tool.execute("call-8", {});
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text.split("\n")).toEqual(["weird.xyz\t7\t"]);
	});
});

