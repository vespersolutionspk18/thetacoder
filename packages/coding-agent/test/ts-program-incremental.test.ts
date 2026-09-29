/**
 * F1 — incremental `ts.Program` reuse in the live query layer.
 *
 * `buildProgramForManifest` passes the previous program as
 * `oldProgram` so `ts.createProgram` reuses unchanged
 * `SourceFile`s. This test pins the observable semantics through the
 * public `LiveQueryToolData` surface: after an edit + `refresh()`,
 * the new snapshot's semantic adapter must answer from the NEW file
 * content (not the pre-edit parse), while still resolving real
 * definitions.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveQueryToolData } from "../src/core/repository/query-data.ts";

describe("LiveQueryToolData — incremental ts.Program reuse", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "theta-ts-inc-"));
		// A minimal TypeScript project: root tsconfig + one source file
		// with a symbol the adapter can resolve.
		writeFileSync(join(tempDir, "tsconfig.json"), "{}\n");
		writeFileSync(join(tempDir, "src.ts"), "export function alpha(): number {\n\treturn 1;\n}\n");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("sees edited content after refresh without a full rebuild", async () => {
		// Force the typescript-ls backend explicitly so the test does
		// not depend on LSP auto-detection (a typescript-language-server
		// on PATH would route to the LSP adapter instead).
		const live = createLiveQueryToolData({ root: tempDir, semanticBackend: "typescript-ls" });

		const first = await live.getToolData();
		expect(first.manifest.length).toBeGreaterThan(0);

		// Resolve a definition against the initial content.
		const before = await first.semanticAdapter.getDefinition("alpha");
		expect(before.relation).toBe("definition");
		if (before.relation !== "definition") throw new Error("narrow");
		expect(before.locations.length).toBeGreaterThan(0);
		expect(before.certainty).toBe("exact");

		// External edit: rename the symbol and add a second one. The
		// refresh must pick up the new content via the reused program.
		writeFileSync(
			join(tempDir, "src.ts"),
			'export function alpha(): number {\n\treturn 2;\n}\n\nexport function beta(): string {\n\treturn "b";\n}\n',
		);
		await live.refresh();

		const second = await live.getToolData();
		// The old symbol still resolves (same file, edited content)…
		const afterAlpha = await second.semanticAdapter.getDefinition("alpha");
		expect(afterAlpha.relation).toBe("definition");
		if (afterAlpha.relation !== "definition") throw new Error("narrow");
		expect(afterAlpha.locations.length).toBeGreaterThan(0);
		// …and the newly added symbol resolves too — proving the
		// refresh answered from the post-edit parse, not a stale
		// `SourceFile` reused from `oldProgram`.
		const afterBeta = await second.semanticAdapter.getDefinition("beta");
		expect(afterBeta.relation).toBe("definition");
		if (afterBeta.relation !== "definition") throw new Error("narrow");
		expect(afterBeta.locations.length).toBeGreaterThan(0);
		expect(afterBeta.certainty).toBe("exact");

		await live.dispose();
	});

	it("sees a newly added root file after refresh", async () => {
		const live = createLiveQueryToolData({ root: tempDir, semanticBackend: "typescript-ls" });
		await live.getToolData();

		mkdirSync(join(tempDir, "extra"), { recursive: true });
		writeFileSync(join(tempDir, "extra", "more.ts"), "export function gamma(): void {}\n");
		await live.refresh();

		const second = await live.getToolData();
		const gamma = await second.semanticAdapter.getDefinition("gamma");
		expect(gamma.relation).toBe("definition");
		if (gamma.relation !== "definition") throw new Error("narrow");
		expect(gamma.locations.length).toBeGreaterThan(0);
		expect(gamma.certainty).toBe("exact");

		await live.dispose();
	});
});

