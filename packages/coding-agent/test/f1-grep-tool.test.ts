/**
 * F1 read-only tool — `grep-f1`.
 *
 * Builds a manifest + symbol index with a few known symbols and asserts
 * the tool finds the expected matches with the documented output shape
 * (`file:line:kind:symbol` per line).
 */

import { describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";
import { createF1ReadOnlyToolDefinitions } from "../src/core/tools/f1-readonly.ts";

function makeManifest(): FileManifestEntry[] {
	return [
		{
			path: "src/auth.ts",
			absolutePath: "/abs/src/auth.ts",
			byteLength: 1024,
			language: "typescript",
			package: "@theta/test",
			generated: false,
			ignored: false,
		},
		{
			path: "src/user.ts",
			absolutePath: "/abs/src/user.ts",
			byteLength: 512,
			language: "typescript",
			package: "@theta/test",
			generated: false,
			ignored: false,
		},
		{
			path: "src/auth.py",
			absolutePath: "/abs/src/auth.py",
			byteLength: 256,
			language: "python",
			package: "@theta/test",
			generated: false,
			ignored: false,
		},
	];
}

function makeIndex(): SymbolEntry[] {
	return [
		{
			kind: "function",
			name: "myFunction",
			path: "src/auth.ts",
			startLine: 10,
			endLine: 20,
			language: "typescript",
		},
		{
			kind: "class",
			name: "AuthService",
			path: "src/auth.ts",
			startLine: 30,
			endLine: 50,
			language: "typescript",
		},
		{
			kind: "function",
			name: "otherHelper",
			path: "src/user.ts",
			startLine: 5,
			endLine: 12,
			language: "typescript",
		},
		{
			kind: "function",
			name: "my_function",
			path: "src/auth.py",
			startLine: 7,
			endLine: 9,
			language: "python",
		},
	];
}

function pickGrep(tools: ReturnType<typeof createF1ReadOnlyToolDefinitions>) {
	const tool = tools.find((t) => t.name === "grep-f1");
	if (!tool) throw new Error("grep-f1 not registered");
	return tool;
}

describe("F1 read-only — grep-f1", () => {
	it("description mentions F1 and the worktree caveat", () => {
		const tool = pickGrep(
			createF1ReadOnlyToolDefinitions({
				manifest: makeManifest(),
				symbolIndex: makeIndex(),
				cwd: "/abs",
			}),
		);
		expect(tool.description).toMatch(/F1-backed/);
		expect(tool.description).toMatch(/worktree/);
	});

	it("returns a single match for a unique symbol name", async () => {
		const tool = pickGrep(
			createF1ReadOnlyToolDefinitions({
				manifest: makeManifest(),
				symbolIndex: makeIndex(),
				cwd: "/abs",
			}),
		);
		const result = await tool.execute("call-1", { pattern: "AuthService" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		const lines = text.split("\n");
		expect(lines).toEqual(["src/auth.ts:30:class:AuthService"]);
	});

	it("matches the substring in any symbol name (case-insensitive by default)", async () => {
		const tool = pickGrep(
			createF1ReadOnlyToolDefinitions({
				manifest: makeManifest(),
				symbolIndex: makeIndex(),
				cwd: "/abs",
			}),
		);
		const result = await tool.execute("call-2", { pattern: "function" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		const lines = text.split("\n").sort();
		// `myFunction` and `my_function` both contain the substring
		// "function" (case-insensitive). `otherHelper` does not. The point
		// of the test is to confirm substring matching against the name.
		expect(lines).toEqual(["src/auth.py:7:function:my_function", "src/auth.ts:10:function:myFunction"]);
	});

	it("matches names that contain the substring (e.g. 'my' matches myFunction + my_function)", async () => {
		const tool = pickGrep(
			createF1ReadOnlyToolDefinitions({
				manifest: makeManifest(),
				symbolIndex: makeIndex(),
				cwd: "/abs",
			}),
		);
		const result = await tool.execute("call-3", { pattern: "my" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		const lines = text.split("\n").sort();
		expect(lines).toEqual(["src/auth.py:7:function:my_function", "src/auth.ts:10:function:myFunction"]);
	});

	it("filters by kind", async () => {
		const tool = pickGrep(
			createF1ReadOnlyToolDefinitions({
				manifest: makeManifest(),
				symbolIndex: makeIndex(),
				cwd: "/abs",
			}),
		);
		const result = await tool.execute("call-4", { pattern: "Auth", kind: "class" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		const lines = text.split("\n");
		expect(lines).toEqual(["src/auth.ts:30:class:AuthService"]);
	});

	it("filters by language", async () => {
		const tool = pickGrep(
			createF1ReadOnlyToolDefinitions({
				manifest: makeManifest(),
				symbolIndex: makeIndex(),
				cwd: "/abs",
			}),
		);
		const result = await tool.execute("call-5", { pattern: "my", language: "python" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		const lines = text.split("\n");
		expect(lines).toEqual(["src/auth.py:7:function:my_function"]);
	});

	it("respects the path prefix filter", async () => {
		const tool = pickGrep(
			createF1ReadOnlyToolDefinitions({
				manifest: makeManifest(),
				symbolIndex: makeIndex(),
				cwd: "/abs",
			}),
		);
		const result = await tool.execute("call-6", { pattern: "my", path: "src/auth.ts" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		const lines = text.split("\n");
		expect(lines).toEqual(["src/auth.ts:10:function:myFunction"]);
	});

	it("returns the empty result message when nothing matches", async () => {
		const tool = pickGrep(
			createF1ReadOnlyToolDefinitions({
				manifest: makeManifest(),
				symbolIndex: makeIndex(),
				cwd: "/abs",
			}),
		);
		const result = await tool.execute("call-7", { pattern: "nonexistentSymbol" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toBe("No matches found");
	});
});

