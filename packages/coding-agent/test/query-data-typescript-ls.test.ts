/**
 * F1 `query` tool — live data layer, typescript-ls auto-detection.
 *
 * When the worktree root contains a `tsconfig.json` and the manifest
 * contains at least one `.ts` / `.tsx` / `.mts` / `.cts` file,
 * `createLiveQueryToolData` must select `"typescript-ls"` and return
 * a real `TypeScriptLanguageServiceAdapter` (not a mock) on the next
 * `getToolData()` call. `getDefinition` against that adapter must
 * resolve to the actual declaration site, with `certainty: "exact"`,
 * rather than the `MockSemanticQueryAdapter`'s `certainty: "unknown"`
 * placeholder.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveQueryToolData } from "../src/core/repository/query-data.ts";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";
import { TypeScriptLanguageServiceAdapter } from "../src/core/repository/typescript-semantic-adapter.ts";

describe("createLiveQueryToolData — typescript-ls auto-detection", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "theta-query-data-ts-ls-"));
		await mkdir(join(root, "src"), { recursive: true });
		// `tsconfig.json` at the worktree root is one of the two
		// auto-detect pre-conditions.
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
			JSON.stringify({ name: "ts-ls-data-test", version: "0.0.0", private: true }),
			"utf-8",
		);
		// At least one `.ts` file in the manifest is the other.
		await writeFile(
			join(root, "src", "math.ts"),
			["export function add(a: number, b: number): number {", "    return a + b;", "}", ""].join("\n"),
			"utf-8",
		);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("uses a real TypeScriptLanguageServiceAdapter when the worktree has a tsconfig + .ts files", async () => {
		const live = createLiveQueryToolData({ root });
		const data = await live.getToolData();
		expect(data.semanticAdapter).toBeInstanceOf(TypeScriptLanguageServiceAdapter);
		expect(data.semanticAdapter).not.toBeInstanceOf(MockSemanticQueryAdapter);
	});

	it("getDefinition returns the real declaration site (certainty: exact)", async () => {
		const live = createLiveQueryToolData({ root });
		const data = await live.getToolData();
		const result = await data.semanticAdapter.getDefinition("add");
		expect(result.relation).toBe("definition");
		if (result.relation !== "definition") throw new Error("narrow");
		// Real TypeScript resolution, not the mock's "unknown" placeholder.
		expect(result.certainty).toBe("exact");
		expect(result.locations).toHaveLength(1);
		const loc = result.locations[0];
		expect(loc).toBeDefined();
		expect(loc!.path.replace(/\\/g, "/")).toBe(`src${sep}math.ts`.replace(/\\/g, "/"));
		expect(loc!.startLine).toBe(1);
		expect(loc!.endLine).toBe(3);
	});

	it("getDefinition for an unknown symbol returns certainty: unknown, not the mock's empty mock", async () => {
		const live = createLiveQueryToolData({ root });
		const data = await live.getToolData();
		const result = await data.semanticAdapter.getDefinition("NotInProgram");
		expect(result.relation).toBe("definition");
		if (result.relation !== "definition") throw new Error("narrow");
		// The real adapter's "symbol not in program" path uses
		// `certainty: "unknown"` with a note. That's a different shape
		// than the mock's `emptyMock`, which always carries the mock
		// default note.
		expect(result.certainty).toBe("unknown");
		expect(result.locations).toEqual([]);
		expect(result.note).toMatch(/NotInProgram/);
	});

	it("explicit semanticBackend: 'typescript-ls' forces the real adapter even with a tsconfig present", async () => {
		const live = createLiveQueryToolData({ root, semanticBackend: "typescript-ls" });
		const data = await live.getToolData();
		expect(data.semanticAdapter).toBeInstanceOf(TypeScriptLanguageServiceAdapter);
	});
});

