/**
 * F1 typescript-ls adapter — getCallers.
 *
 * Verifies that the adapter reports exactly the 3 call sites for a
 * function and that they are classified as `direct` callers (not
 * `candidates`), since the test project never passes the symbol
 * around indirectly.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TypeScriptLanguageServiceAdapter } from "../src/core/repository/typescript-semantic-adapter.ts";
import { createTestProject, removeProject, type TsTestProject } from "./typescript-ls-test-helpers.ts";

describe("TypeScriptLanguageServiceAdapter — getCallers", () => {
	let project: TsTestProject;
	let adapter: TypeScriptLanguageServiceAdapter;

	beforeEach(async () => {
		project = await createTestProject({
			files: [
				{
					path: "src/handler.ts",
					content: [
						"export function handle(input: string): string {",
						"    return input.toUpperCase();",
						"}",
						"",
					].join("\n"),
				},
				{
					path: "src/site1.ts",
					content: [
						'import { handle } from "./handler.ts";',
						"export function site1() {",
						"    return handle('one');",
						"}",
						"",
					].join("\n"),
				},
				{
					path: "src/site2.ts",
					content: [
						'import { handle } from "./handler.ts";',
						"export function site2() {",
						"    return handle('two');",
						"}",
						"",
					].join("\n"),
				},
				{
					path: "src/site3.ts",
					content: [
						'import { handle } from "./handler.ts";',
						"export function site3() {",
						"    return handle('three');",
						"}",
						"",
					].join("\n"),
				},
			],
		});
		adapter = new TypeScriptLanguageServiceAdapter({ program: project.program, worktree: project.rootDir });
	});

	afterEach(() => {
		removeProject(project.rootDir);
	});

	it("finds three direct callers, one per call site", async () => {
		const result = await adapter.getCallers("handle");
		expect(result.relation).toBe("caller");
		if (result.relation !== "caller") throw new Error("narrow");
		expect(result.certainty).toBe("exact");
		// 3 direct callers (one per call site). Imports and other references
		// end up in `candidates` because they aren't call expressions.
		expect(result.direct.length).toBe(3);
		const files = new Set(result.direct.map((l) => l.path.replace(/\\/g, "/")));
		expect(files).toEqual(new Set(["src/site1.ts", "src/site2.ts", "src/site3.ts"]));
	});

	it("returns certainty 'unknown' when the symbol is not in the program", async () => {
		const result = await adapter.getCallers("nope");
		expect(result.relation).toBe("caller");
		if (result.relation !== "caller") throw new Error("narrow");
		expect(result.certainty).toBe("unknown");
		expect(result.direct).toEqual([]);
		expect(result.candidates).toEqual([]);
	});
});

