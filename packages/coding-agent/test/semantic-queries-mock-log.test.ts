/**
 * F1 semantic queries — mock adapter query log.
 *
 * Every method on the mock adapter must record `(relation, symbol,
 * timestamp)` so tests can assert on call order and content.
 */

import { describe, expect, it } from "vitest";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";

describe("MockSemanticQueryAdapter — query log", () => {
	it("starts with an empty log", () => {
		const adapter = new MockSemanticQueryAdapter();
		expect(adapter.getQueryLog()).toEqual([]);
	});

	it("logs every query with its relation and symbol", async () => {
		const adapter = new MockSemanticQueryAdapter();
		await adapter.getDefinition("Foo");
		await adapter.getReferences("Bar");
		await adapter.getCallers("Baz");
		await adapter.getCallees("Qux");
		await adapter.getImplementations("Impl");
		await adapter.getRelevantTests("Test");

		const log = adapter.getQueryLog();
		expect(log).toHaveLength(6);
		expect(log[0]).toMatchObject({ relation: "definition", symbol: "Foo" });
		expect(log[1]).toMatchObject({ relation: "reference", symbol: "Bar" });
		expect(log[2]).toMatchObject({ relation: "caller", symbol: "Baz" });
		expect(log[3]).toMatchObject({ relation: "callee", symbol: "Qux" });
		expect(log[4]).toMatchObject({ relation: "implementation", symbol: "Impl" });
		expect(log[5]).toMatchObject({ relation: "test-relation", symbol: "Test" });
	});

	it("every log entry has a positive timestamp", async () => {
		const adapter = new MockSemanticQueryAdapter();
		const before = Date.now();
		await adapter.getDefinition("Foo");
		const after = Date.now();
		const log = adapter.getQueryLog();
		expect(log).toHaveLength(1);
		const ts = log[0]?.timestamp ?? 0;
		expect(ts).toBeGreaterThanOrEqual(before);
		expect(ts).toBeLessThanOrEqual(after);
	});

	it("getQueryLog returns a copy — mutating it does not affect the adapter", async () => {
		const adapter = new MockSemanticQueryAdapter();
		await adapter.getDefinition("Foo");
		const log = adapter.getQueryLog();
		log.length = 0;
		expect(adapter.getQueryLog()).toHaveLength(1);
	});

	it("resetForTests clears both the injection map and the query log", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockResult("definition", "Foo", {
			relation: "definition",
			symbol: "Foo",
			locations: [{ path: "src/foo.ts", startLine: 1, endLine: 1 }],
			certainty: "exact",
		});
		await adapter.getDefinition("Foo");
		expect(adapter.getQueryLog()).toHaveLength(1);

		adapter.resetForTests();
		expect(adapter.getQueryLog()).toEqual([]);

		// After reset, the injection is gone — default mock returns.
		const result = await adapter.getDefinition("Foo");
		expect(result.certainty).toBe("unknown");
	});
});

