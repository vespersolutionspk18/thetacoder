/**
 * F1 read-only tool — registration via `createReadOnlyToolDefinitions` /
 * `createReadOnlyTools`.
 *
 * Asserts that supplying `options.f1ReadOnly` appends the three
 * F1-backed tools to the readonly tool list, and that omitting the
 * option leaves the list unchanged.
 */

import { describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";
import { createReadOnlyToolDefinitions, createReadOnlyTools } from "../src/core/tools/index.ts";

function makeManifest(): FileManifestEntry[] {
	return [
		{
			path: "src/a.ts",
			absolutePath: "/abs/src/a.ts",
			byteLength: 1,
			language: "typescript",
			generated: false,
			ignored: false,
		},
	];
}

function makeIndex(): SymbolEntry[] {
	return [{ kind: "function", name: "foo", path: "src/a.ts", startLine: 1, endLine: 1, language: "typescript" }];
}

describe("F1 read-only — registration in the readonly tool list", () => {
	it("appends the three F1 tools to createReadOnlyToolDefinitions when f1ReadOnly is supplied", () => {
		const tools = createReadOnlyToolDefinitions("/tmp", {
			f1ReadOnly: { manifest: makeManifest(), symbolIndex: makeIndex(), cwd: "/abs" },
		});
		const names = tools.map((t) => t.name);
		expect(names).toContain("read");
		expect(names).toContain("grep");
		expect(names).toContain("find");
		expect(names).toContain("ls");
		expect(names).toContain("grep-f1");
		expect(names).toContain("find-f1");
		expect(names).toContain("ls-f1");
	});

	it("omits the F1 tools from createReadOnlyToolDefinitions when f1ReadOnly is absent", () => {
		const tools = createReadOnlyToolDefinitions("/tmp");
		const names = tools.map((t) => t.name);
		expect(names).not.toContain("grep-f1");
		expect(names).not.toContain("find-f1");
		expect(names).not.toContain("ls-f1");
	});

	it("appends the three F1 tools to createReadOnlyTools when f1ReadOnly is supplied", () => {
		const tools = createReadOnlyTools("/tmp", {
			f1ReadOnly: { manifest: makeManifest(), symbolIndex: makeIndex(), cwd: "/abs" },
		});
		const names = tools.map((t) => t.name);
		expect(names).toContain("grep-f1");
		expect(names).toContain("find-f1");
		expect(names).toContain("ls-f1");
	});

	it("the appended F1 tools are the same factory output (by name)", () => {
		const tools = createReadOnlyToolDefinitions("/tmp", {
			f1ReadOnly: { manifest: makeManifest(), symbolIndex: makeIndex(), cwd: "/abs" },
		});
		const grepF1 = tools.find((t) => t.name === "grep-f1");
		const findF1 = tools.find((t) => t.name === "find-f1");
		const lsF1 = tools.find((t) => t.name === "ls-f1");
		expect(grepF1).toBeDefined();
		expect(findF1).toBeDefined();
		expect(lsF1).toBeDefined();
	});

	it("appended F1 tools have descriptions and parameters", () => {
		const tools = createReadOnlyToolDefinitions("/tmp", {
			f1ReadOnly: { manifest: makeManifest(), symbolIndex: makeIndex(), cwd: "/abs" },
		});
		for (const t of tools) {
			if (t.name === "grep-f1" || t.name === "find-f1" || t.name === "ls-f1") {
				expect(typeof t.description).toBe("string");
				expect(t.description.length).toBeGreaterThan(0);
				expect(t.parameters).toBeDefined();
				expect(typeof t.execute).toBe("function");
			}
		}
	});
});

