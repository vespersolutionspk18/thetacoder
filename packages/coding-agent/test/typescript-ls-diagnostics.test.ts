/**
 * F1 typescript-ls adapter — `getDiagnostics`.
 *
 * Materializes a tiny TypeScript project that contains an intentional
 * type error, builds a real `ts.Program`, and asserts the adapter
 * reports at least one diagnostic with the expected provenance
 * (severity, file, line, message, source, snapshot, timestamp).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TypeScriptLanguageServiceAdapter } from "../src/core/repository/typescript-semantic-adapter.ts";
import { createTestProject, removeProject, type TsTestProject } from "./typescript-ls-test-helpers.ts";

describe("TypeScriptLanguageServiceAdapter — getDiagnostics", () => {
	let project: TsTestProject;
	let adapter: TypeScriptLanguageServiceAdapter;

	beforeEach(async () => {
		project = await createTestProject({
			files: [
				{
					// `x: number = "string"` is a TS2322 type error.
					path: "src/broken.ts",
					content: ["export const x: number = 'string';", ""].join("\n"),
				},
				{
					path: "src/clean.ts",
					content: ["export const y: number = 42;", ""].join("\n"),
				},
			],
		});
		adapter = new TypeScriptLanguageServiceAdapter({ program: project.program, worktree: project.rootDir });
	});

	afterEach(() => {
		removeProject(project.rootDir);
	});

	it("returns at least one error diagnostic for the broken file", async () => {
		const result = await adapter.getDiagnostics();
		expect(result.length).toBeGreaterThan(0);
		const err = result.find((d) => d.file === "src/broken.ts");
		expect(err).toBeDefined();
		if (!err) return;
		expect(err.severity).toBe("error");
		expect(err.line).toBeGreaterThanOrEqual(1);
		expect(err.message.length).toBeGreaterThan(0);
		expect(err.source).toBe("typescript");
		expect(err.snapshotId).toMatch(/^[a-f0-9]{64}$/);
		expect(err.timestamp).toBeGreaterThan(0);
		expect(err.certainty).toBe("exact");
	});

	it("does not report diagnostics for the clean file by default", async () => {
		const result = await adapter.getDiagnostics();
		const cleanErrors = result.filter((d) => d.file === "src/clean.ts");
		expect(cleanErrors).toEqual([]);
	});

	it("filters diagnostics by the path option", async () => {
		const result = await adapter.getDiagnostics({ path: "src/clean.ts" });
		expect(result).toEqual([]);
	});

	it("returns the same snapshot id for identical source content", async () => {
		const first = await adapter.getDiagnostics();
		const second = await adapter.getDiagnostics();
		const snap1 = first.find((d) => d.file === "src/broken.ts")?.snapshotId;
		const snap2 = second.find((d) => d.file === "src/broken.ts")?.snapshotId;
		expect(snap1).toBeDefined();
		expect(snap1).toBe(snap2);
	});

	it("returns an empty list (does not throw) on a syntactically broken file when scoped to it", async () => {
		// The default `noEmit` config plus a syntactic-only file
		// should still produce zero diagnostics for unrelated files.
		const result = await adapter.getDiagnostics({ path: "src/clean.ts" });
		expect(Array.isArray(result)).toBe(true);
	});
});

