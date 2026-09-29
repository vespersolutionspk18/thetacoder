/**
 * F1 `query` tool — end-to-end with the typescript-ls backend.
 *
 * Wires the real TypeScript LS adapter through `LiveQueryToolData`
 * into `createQueryTool`, then runs the `get-definition` intent
 * against a real symbol. The tool must return a single
 * `context-item` for the declaration site, with `certainty:
 * "exact"`, mirroring the behaviour when a real `SemanticResult`
 * comes back from a real adapter.
 *
 * This is the integration test that proves the wiring chain works:
 * worktree -> `LiveQueryToolData` -> `ts.Program` ->
 * `TypeScriptLanguageServiceAdapter` -> `createQueryTool` ->
 * `get-definition` dispatch.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveQueryToolData } from "../src/core/repository/query-data.ts";
import { createQueryTool } from "../src/core/tools/query.ts";

describe("query tool — typescript-ls integration via LiveQueryToolData", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "theta-query-data-ts-ls-tool-"));
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(
			join(root, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2022",
					module: "ESNext",
					moduleResolution: "Bundler",
					strict: true,
					skipLibCheck: true,
					noEmit: true,
				},
				include: ["src/**/*"],
			}),
			"utf-8",
		);
		// `package.json` so the TS adapter's worktree-walk heuristic
		// resolves the test root (otherwise it falls back to
		// `process.cwd()` and paths are reported as absolute).
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({ name: "ts-ls-tool-test", version: "0.0.0", private: true }),
			"utf-8",
		);
		await writeFile(
			join(root, "src", "calculator.ts"),
			["export function multiply(a: number, b: number): number {", "    return a * b;", "}", ""].join("\n"),
			"utf-8",
		);
		await writeFile(
			join(root, "src", "main.ts"),
			['import { multiply } from "./calculator.ts";', "", "multiply(2, 3);", ""].join("\n"),
			"utf-8",
		);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("get-definition returns a single context-item for the real declaration site", async () => {
		const live = createLiveQueryToolData({ root });
		const data = await live.getToolData();
		const tool = createQueryTool(data.manifest, data.symbolIndex, data.semanticAdapter);

		const result = await tool.execute("call-1", { intent: "get-definition", query: "multiply" });

		const output = result.details as {
			output: {
				results: Array<{
					kind: string;
					path: string;
					startLine?: number;
					endLine?: number;
					score: number;
					certainty: string;
				}>;
				uncertainty: string;
			};
		};
		expect(output.output.results).toHaveLength(1);
		const item = output.output.results[0];
		expect(item.kind).toBe("context-item");
		expect(item.path.replace(/\\/g, "/")).toBe(`src${sep}calculator.ts`.replace(/\\/g, "/"));
		expect(item.startLine).toBe(1);
		expect(item.endLine).toBe(3);
		expect(item.score).toBe(1.0);
		expect(item.certainty).toBe("exact");
		expect(output.output.uncertainty).toBe("low");
	});

	it("get-definition for an unknown symbol returns an empty result with high uncertainty", async () => {
		const live = createLiveQueryToolData({ root });
		const data = await live.getToolData();
		const tool = createQueryTool(data.manifest, data.symbolIndex, data.semanticAdapter);

		const result = await tool.execute("call-2", { intent: "get-definition", query: "NotInProgram" });
		const output = result.details as {
			output: { results: unknown[]; uncertainty: string };
		};
		expect(output.output.results).toEqual([]);
		// Real adapter's "symbol not in program" path returns
		// `certainty: "unknown"` which the tool classifies as
		// "high" uncertainty.
		expect(output.output.uncertainty).toBe("high");
	});
});

