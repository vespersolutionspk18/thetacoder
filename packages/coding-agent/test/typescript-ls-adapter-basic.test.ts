/**
 * F1 typescript-ls adapter — basic getDefinition.
 *
 * Sets up a small project on disk, builds a real `ts.Program`, and
 * asserts that `getDefinition` resolves the symbol to its declaration
 * site. The test verifies path, line, certainty, and the resolved
 * location.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TypeScriptLanguageServiceAdapter } from "../src/core/repository/typescript-semantic-adapter.ts";
import { createTestProject, removeProject, type TsTestProject } from "./typescript-ls-test-helpers.ts";

describe("TypeScriptLanguageServiceAdapter — getDefinition", () => {
	let project: TsTestProject;
	let adapter: TypeScriptLanguageServiceAdapter;

	beforeEach(async () => {
		project = await createTestProject({
			files: [
				{
					path: "src/math.ts",
					content: ["export function add(a: number, b: number): number {", "    return a + b;", "}", ""].join(
						"\n",
					),
				},
				{
					path: "src/main.ts",
					content: ['import { add } from "./math.ts";', "", "console.log(add(1, 2));", ""].join("\n"),
				},
			],
		});
		adapter = new TypeScriptLanguageServiceAdapter({ program: project.program, worktree: project.rootDir });
	});

	afterEach(() => {
		removeProject(project.rootDir);
	});

	it("resolves a top-level function declaration to its defining file and line", async () => {
		const result = await adapter.getDefinition("add");
		expect(result.relation).toBe("definition");
		if (result.relation !== "definition") throw new Error("narrow");
		expect(result.certainty).toBe("exact");
		expect(result.locations).toHaveLength(1);
		const loc = result.locations[0];
		expect(loc).toBeDefined();
		expect(loc!.path.replace(/\\/g, "/")).toBe("src/math.ts");
		expect(loc!.startLine).toBe(1);
		expect(loc!.endLine).toBe(3);
	});

	it("resolves a class declaration to its class block", async () => {
		const project2 = await createTestProject({
			files: [
				{
					path: "src/animal.ts",
					content: [
						"export class Animal {",
						"    speak(): string {",
						"        return 'noise';",
						"    }",
						"}",
						"",
					].join("\n"),
				},
				{
					path: "src/index.ts",
					content: ['import "./animal.ts";', ""].join("\n"),
				},
			],
		});
		try {
			const a2 = new TypeScriptLanguageServiceAdapter({ program: project2.program, worktree: project2.rootDir });
			const result = await a2.getDefinition("Animal");
			expect(result.relation).toBe("definition");
			if (result.relation !== "definition") throw new Error("narrow");
			expect(result.certainty).toBe("exact");
			expect(result.locations[0]?.path.replace(/\\/g, "/")).toBe("src/animal.ts");
			expect(result.locations[0]?.startLine).toBe(1);
		} finally {
			removeProject(project2.rootDir);
		}
	});

	it("returns certainty 'unknown' with a note when the symbol is not in the program", async () => {
		const result = await adapter.getDefinition("NotInProgram");
		expect(result.relation).toBe("definition");
		if (result.relation !== "definition") throw new Error("narrow");
		expect(result.certainty).toBe("unknown");
		expect(result.locations).toEqual([]);
		expect(result.note).toMatch(/NotInProgram/);
	});
});

