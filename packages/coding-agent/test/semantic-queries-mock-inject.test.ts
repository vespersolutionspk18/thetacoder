/**
 * F1 semantic queries — mock adapter result injection.
 *
 * `setMockResult(relation, symbol, result)` lets tests pin a specific
 * result. The subsequent query must return that exact result and not
 * the default placeholder.
 */

import { describe, expect, it } from "vitest";
import type { SemanticResult } from "../src/core/repository/semantic-queries.ts";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";

describe("MockSemanticQueryAdapter — result injection", () => {
	it("an injected definition is returned verbatim on the next getDefinition call", async () => {
		const adapter = new MockSemanticQueryAdapter();
		const injected: SemanticResult = {
			relation: "definition",
			symbol: "Foo",
			locations: [{ path: "src/foo.ts", startLine: 10, endLine: 20 }],
			certainty: "exact",
		};
		adapter.setMockResult("definition", "Foo", injected);
		const result = await adapter.getDefinition("Foo");
		expect(result).toEqual(injected);
		// `note` is omitted in the injection, so result.note is undefined.
		expect(result.note).toBeUndefined();
	});

	it("an injection for one symbol does not affect a different symbol", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockResult("definition", "Foo", {
			relation: "definition",
			symbol: "Foo",
			locations: [{ path: "src/foo.ts", startLine: 1, endLine: 2 }],
			certainty: "exact",
		});
		// Unrelated symbol — still gets the default mock.
		const result = await adapter.getDefinition("Bar");
		expect(result.certainty).toBe("unknown");
	});

	it("an injection for one relation does not affect other relations on the same symbol", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockResult("definition", "Foo", {
			relation: "definition",
			symbol: "Foo",
			locations: [{ path: "src/foo.ts", startLine: 1, endLine: 1 }],
			certainty: "exact",
		});
		// `Foo` has a definition injection but no reference injection.
		const refs = await adapter.getReferences("Foo");
		expect(refs.relation).toBe("reference");
		expect(refs.certainty).toBe("unknown");
	});

	it("setMockResult overwrites a previous injection for the same key", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockResult("definition", "Foo", {
			relation: "definition",
			symbol: "Foo",
			locations: [{ path: "src/a.ts", startLine: 1, endLine: 1 }],
			certainty: "exact",
		});
		adapter.setMockResult("definition", "Foo", {
			relation: "definition",
			symbol: "Foo",
			locations: [{ path: "src/b.ts", startLine: 5, endLine: 5 }],
			certainty: "candidate",
		});
		const result = await adapter.getDefinition("Foo");
		if (result.relation !== "definition") throw new Error("narrow");
		expect(result.certainty).toBe("candidate");
		expect(result.locations[0]?.path).toBe("src/b.ts");
	});
});

