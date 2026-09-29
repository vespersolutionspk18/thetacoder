/**
 * F1 typescript-ls adapter — getReferences.
 *
 * Verifies that the adapter reports every reference site for a
 * symbol across multiple files, dedupes them, and labels coverage
 * `complete` when nothing from `node_modules/` is included.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TypeScriptLanguageServiceAdapter } from "../src/core/repository/typescript-semantic-adapter.ts";
import { createTestProject, removeProject, type TsTestProject } from "./typescript-ls-test-helpers.ts";

describe("TypeScriptLanguageServiceAdapter — getReferences", () => {
	let project: TsTestProject;
	let adapter: TypeScriptLanguageServiceAdapter;

	beforeEach(async () => {
		project = await createTestProject({
			files: [
				{
					path: "src/util.ts",
					content: ["export function greet(name: string): string {", '    return "hello, " + name;', "}", ""].join(
						"\n",
					),
				},
				{
					path: "src/a.ts",
					content: [
						'import { greet } from "./util.ts";',
						"export function a() {",
						"    return greet('a');",
						"}",
						"",
					].join("\n"),
				},
				{
					path: "src/b.ts",
					content: [
						'import { greet } from "./util.ts";',
						"export function b() {",
						"    return greet('b');",
						"}",
						"",
					].join("\n"),
				},
				{
					path: "src/c.ts",
					content: ["import { greet } from './util.ts';", "const v = greet('c');", "export { v };", ""].join("\n"),
				},
			],
		});
		adapter = new TypeScriptLanguageServiceAdapter({ program: project.program, worktree: project.rootDir });
	});

	afterEach(() => {
		removeProject(project.rootDir);
	});

	it("reports every call-site reference across multiple files with coverage: 'complete'", async () => {
		const result = await adapter.getReferences("greet");
		expect(result.relation).toBe("reference");
		if (result.relation !== "reference") throw new Error("narrow");
		expect(result.certainty).toBe("exact");
		expect(result.coverage).toBe("complete");
		// Expect at least the 3 import sites + 3 call sites = 6 references.
		expect(result.locations.length).toBeGreaterThanOrEqual(6);
		// The 3 call-site files must all be present.
		const files = new Set(result.locations.map((l) => l.path.replace(/\\/g, "/")));
		expect(files.has("src/a.ts")).toBe(true);
		expect(files.has("src/b.ts")).toBe(true);
		expect(files.has("src/c.ts")).toBe(true);
	});

	it("honours maxResults by truncating the returned locations", async () => {
		const result = await adapter.getReferences("greet", { maxResults: 2 });
		expect(result.relation).toBe("reference");
		if (result.relation !== "reference") throw new Error("narrow");
		expect(result.locations.length).toBeLessThanOrEqual(2);
	});

	it("returns certainty 'unknown' when the symbol is not in the program", async () => {
		const result = await adapter.getReferences("missing");
		expect(result.relation).toBe("reference");
		if (result.relation !== "reference") throw new Error("narrow");
		expect(result.certainty).toBe("unknown");
		expect(result.coverage).toBe("unknown");
		expect(result.locations).toEqual([]);
		expect(result.note).toMatch(/missing/);
	});
});

