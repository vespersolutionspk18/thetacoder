/**
 * F1 semantic queries — factory dispatch.
 *
 * The factory's contract:
 *   - `"mock"`          → `MockSemanticQueryAdapter` with the standard note.
 *   - `"typescript-ls"` → `TypeScriptLanguageServiceAdapter` when a
 *                         `config.program` is supplied, otherwise a
 *                         `MockSemanticQueryAdapter` with the
 *                         "not implemented in MVP" note.
 *   - `"lsp"`           → `LspAdapter` when a `config.manager` is
 *                         supplied, otherwise a `MockSemanticQueryAdapter`
 *                         with the "no manager supplied" note. The
 *                         `LspAdapter` itself degrades to a
 *                         `certainty: "unknown"` result when the
 *                         manager has no server for the worktree —
 *                         a "no language server found" note is
 *                         attached.
 */

import { describe, expect, it } from "vitest";
import { createSemanticQueryAdapter, MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";

describe("createSemanticQueryAdapter", () => {
	it("returns a MockSemanticQueryAdapter when backend is omitted (default)", () => {
		const adapter = createSemanticQueryAdapter();
		expect(adapter).toBeInstanceOf(MockSemanticQueryAdapter);
	});

	it("returns a MockSemanticQueryAdapter when backend is 'mock'", () => {
		const adapter = createSemanticQueryAdapter({ backend: "mock" });
		expect(adapter).toBeInstanceOf(MockSemanticQueryAdapter);
	});

	it("returns a MockSemanticQueryAdapter when backend is 'lsp' and no manager is supplied", () => {
		const adapter = createSemanticQueryAdapter({ backend: "lsp" });
		expect(adapter).toBeInstanceOf(MockSemanticQueryAdapter);
	});

	it("returns a MockSemanticQueryAdapter when backend is 'typescript-ls' and no program is supplied", () => {
		const adapter = createSemanticQueryAdapter({ backend: "typescript-ls" });
		expect(adapter).toBeInstanceOf(MockSemanticQueryAdapter);
	});

	it("mock backend returns the standard default note", async () => {
		const adapter = createSemanticQueryAdapter({ backend: "mock" });
		const result = await adapter.getDefinition("Foo");
		expect(result.note).toMatch(/Mock adapter/);
	});

	it("lsp backend (no manager) results carry a 'no manager' note", async () => {
		const adapter = createSemanticQueryAdapter({ backend: "lsp" });
		const def = await adapter.getDefinition("Foo");
		expect(def.relation).toBe("definition");
		expect(def.certainty).toBe("unknown");
		expect(def.note).toMatch(/manager/i);
	});

	it("typescript-ls backend results carry the 'not implemented in MVP' note", async () => {
		const adapter = createSemanticQueryAdapter({ backend: "typescript-ls" });
		const result = await adapter.getDefinition("Foo");
		expect(result.note).toBe("Backend typescript-ls not implemented in MVP.");
	});

	it("factory accepts and ignores the `config` option for the mock backend", () => {
		const adapter = createSemanticQueryAdapter({
			backend: "mock",
			config: { root: "/abs/project", tsconfig: "tsconfig.json" },
		});
		expect(adapter).toBeInstanceOf(MockSemanticQueryAdapter);
	});
});

