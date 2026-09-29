/**
 * F1 typescript-ls adapter — unknown symbol behaviour.
 *
 * The audit (Section 11.3) is explicit: when a backend cannot answer,
 * it must return `certainty: "unknown"` with a `note`, never a silent
 * empty result that looks like a real "no references found".
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TypeScriptLanguageServiceAdapter } from "../src/core/repository/typescript-semantic-adapter.ts";
import { createTestProject, removeProject, type TsTestProject } from "./typescript-ls-test-helpers.ts";

describe("TypeScriptLanguageServiceAdapter — unknown symbol fallbacks", () => {
	let project: TsTestProject;
	let adapter: TypeScriptLanguageServiceAdapter;

	beforeEach(async () => {
		project = await createTestProject({
			files: [
				{
					path: "src/known.ts",
					content: ["export function known(): number { return 42; }", ""].join("\n"),
				},
				{
					path: "src/index.ts",
					content: ['import { known } from "./known.ts";', "console.log(known());", ""].join("\n"),
				},
			],
		});
		adapter = new TypeScriptLanguageServiceAdapter({ program: project.program, worktree: project.rootDir });
	});

	afterEach(() => {
		removeProject(project.rootDir);
	});

	it("getDefinition returns certainty 'unknown' and a note", async () => {
		const result = await adapter.getDefinition("missing");
		expect(result.relation).toBe("definition");
		if (result.relation !== "definition") throw new Error("narrow");
		expect(result.certainty).toBe("unknown");
		expect(result.locations).toEqual([]);
		expect(typeof result.note).toBe("string");
		expect((result.note ?? "").length).toBeGreaterThan(0);
	});

	it("getReferences returns certainty 'unknown' with coverage 'unknown'", async () => {
		const result = await adapter.getReferences("missing");
		expect(result.relation).toBe("reference");
		if (result.relation !== "reference") throw new Error("narrow");
		expect(result.certainty).toBe("unknown");
		expect(result.coverage).toBe("unknown");
		expect(result.locations).toEqual([]);
		expect(typeof result.note).toBe("string");
	});

	it("getCallers returns certainty 'unknown' with empty direct and candidates", async () => {
		const result = await adapter.getCallers("missing");
		expect(result.relation).toBe("caller");
		if (result.relation !== "caller") throw new Error("narrow");
		expect(result.certainty).toBe("unknown");
		expect(result.direct).toEqual([]);
		expect(result.candidates).toEqual([]);
		expect(typeof result.note).toBe("string");
	});

	it("getCallees returns certainty 'unknown' for an unknown function", async () => {
		const result = await adapter.getCallees("missing");
		expect(result.relation).toBe("callee");
		if (result.relation !== "callee") throw new Error("narrow");
		expect(result.certainty).toBe("unknown");
		expect(result.direct).toEqual([]);
		expect(result.candidates).toEqual([]);
	});

	it("getImplementations returns certainty 'unknown' for an unknown interface", async () => {
		const result = await adapter.getImplementations("missing");
		expect(result.relation).toBe("implementation");
		if (result.relation !== "implementation") throw new Error("narrow");
		expect(result.certainty).toBe("unknown");
		expect(result.locations).toEqual([]);
	});

	it("getImplementations returns certainty 'unknown' for a non-interface symbol", async () => {
		// `known` is a function, not an interface.
		const result = await adapter.getImplementations("known");
		expect(result.relation).toBe("implementation");
		if (result.relation !== "implementation") throw new Error("narrow");
		expect(result.certainty).toBe("unknown");
		expect(result.locations).toEqual([]);
		expect(result.note).toMatch(/interface/);
	});

	it("getRelevantTests returns certainty 'unknown' with an empty list when no tests exist", async () => {
		const result = await adapter.getRelevantTests("known");
		expect(result.relation).toBe("test-relation");
		if (result.relation !== "test-relation") throw new Error("narrow");
		// No test files in the project, so the list is empty and
		// certainty reflects the lack of evidence.
		expect(result.tests).toEqual([]);
		expect(result.certainty).toBe("unknown");
	});
});

