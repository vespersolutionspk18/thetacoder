/**
 * F1 typescript-ls adapter — factory wiring.
 *
 * When `createSemanticQueryAdapter({ backend: "typescript-ls", config: { program } })`
 * is called with a real program, the factory must return the actual
 * `TypeScriptLanguageServiceAdapter` (not a mock). Without a
 * program, the factory still returns a mock that advertises the
 * missing-config limitation.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";
import { TypeScriptLanguageServiceAdapter } from "../src/core/repository/typescript-semantic-adapter.ts";
import { createTestProject, removeProject, type TsTestProject } from "./typescript-ls-test-helpers.ts";

describe("createSemanticQueryAdapter — typescript-ls backend", () => {
	const projects: TsTestProject[] = [];

	afterEach(() => {
		while (projects.length > 0) {
			const p = projects.pop();
			if (p) removeProject(p.rootDir);
		}
	});

	async function makeProject(): Promise<TsTestProject> {
		const p = await createTestProject({
			files: [
				{
					path: "src/foo.ts",
					content: ["export function foo(): number { return 1; }", ""].join("\n"),
				},
				{
					path: "src/index.ts",
					content: ['import { foo } from "./foo.ts";', "console.log(foo());", ""].join("\n"),
				},
			],
		});
		projects.push(p);
		return p;
	}

	it("returns a TypeScriptLanguageServiceAdapter when config.program is provided", async () => {
		const project = await makeProject();
		const adapter = createSemanticQueryAdapter({
			backend: "typescript-ls",
			config: { program: project.program },
		});
		expect(adapter).toBeInstanceOf(TypeScriptLanguageServiceAdapter);
	});

	it("the real adapter resolves symbols from the supplied program", async () => {
		const project = await makeProject();
		const adapter = createSemanticQueryAdapter({
			backend: "typescript-ls",
			config: { program: project.program, worktree: project.rootDir },
		}) as TypeScriptLanguageServiceAdapter;
		const result = await adapter.getDefinition("foo");
		expect(result.relation).toBe("definition");
		if (result.relation !== "definition") throw new Error("narrow");
		expect(result.certainty).toBe("exact");
		expect(result.locations[0]?.path.replace(/\\/g, "/")).toBe("src/foo.ts");
	});

	it("returns a mock with the 'not implemented in MVP' note when no program is supplied", async () => {
		const adapter = createSemanticQueryAdapter({ backend: "typescript-ls" });
		expect(adapter).not.toBeInstanceOf(TypeScriptLanguageServiceAdapter);
		const result = await adapter.getDefinition("foo");
		expect(result.certainty).toBe("unknown");
		expect(result.note).toBe("Backend typescript-ls not implemented in MVP.");
	});
});

