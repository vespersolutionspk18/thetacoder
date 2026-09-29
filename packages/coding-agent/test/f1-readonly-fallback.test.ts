/**
 * F1 read-only tool — empty manifest behaviour.
 *
 * The spec is explicit: an empty manifest must yield empty results, not
 * a fallback to the original filesystem-backed tools. The caller (the
 * agent loop / tool router) is responsible for falling back when the
 * manifest has no coverage.
 */

import { describe, expect, it } from "vitest";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";
import { createF1ReadOnlyToolDefinitions } from "../src/core/tools/f1-readonly.ts";

function pick(tools: ReturnType<typeof createF1ReadOnlyToolDefinitions>, name: string) {
	const tool = tools.find((t) => t.name === name);
	if (!tool) throw new Error(`${name} not registered`);
	return tool;
}

describe("F1 read-only — empty manifest fallback", () => {
	it("grep-f1 returns the empty result message with no matches", async () => {
		const tools = createF1ReadOnlyToolDefinitions({ manifest: [], symbolIndex: [], cwd: "/abs" });
		const tool = pick(tools, "grep-f1");
		const result = await tool.execute("call-1", { pattern: "anything" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toBe("No matches found");
	});

	it("find-f1 returns the empty result message with no matches", async () => {
		const tools = createF1ReadOnlyToolDefinitions({ manifest: [], symbolIndex: [], cwd: "/abs" });
		const tool = pick(tools, "find-f1");
		const result = await tool.execute("call-2", { pattern: "**/*" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toBe("No files found matching pattern");
	});

	it("ls-f1 returns the empty-directory message with no entries", async () => {
		const tools = createF1ReadOnlyToolDefinitions({ manifest: [], symbolIndex: [], cwd: "/abs" });
		const tool = pick(tools, "ls-f1");
		const result = await tool.execute("call-3", {});
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toBe("(empty directory)");
	});

	it("all three tools are still registered with empty manifest", () => {
		const tools = createF1ReadOnlyToolDefinitions({ manifest: [], symbolIndex: [], cwd: "/abs" });
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual(["find-f1", "grep-f1", "ls-f1"]);
	});

	it("grep-f1 with manifest but empty symbol index returns empty", async () => {
		const tools = createF1ReadOnlyToolDefinitions({
			manifest: [
				{
					path: "src/a.ts",
					absolutePath: "/abs/src/a.ts",
					byteLength: 1,
					language: "typescript",
					generated: false,
					ignored: false,
				},
			],
			symbolIndex: [] as SymbolEntry[],
			cwd: "/abs",
		});
		const tool = pick(tools, "grep-f1");
		const result = await tool.execute("call-4", { pattern: "foo" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toBe("No matches found");
	});

	it("find-f1 with manifest but every entry filtered out returns empty", async () => {
		const tools = createF1ReadOnlyToolDefinitions({
			manifest: [
				{
					path: "src/a.ts",
					absolutePath: "/abs/src/a.ts",
					byteLength: 1,
					language: "rust", // no other entries in any other language
					generated: false,
					ignored: false,
				},
			],
			symbolIndex: [],
			cwd: "/abs",
		});
		const tool = pick(tools, "find-f1");
		const result = await tool.execute("call-5", { pattern: "**/*", language: "typescript" });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toBe("No files found matching pattern");
	});
});

