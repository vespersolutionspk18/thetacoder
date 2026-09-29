/**
 * F1 semantic queries — mock adapter default behaviour.
 *
 * Without any injection, every method on `MockSemanticQueryAdapter`
 * must return `certainty: "unknown"` plus the "Mock adapter — no real
 * language service attached..." note. This is the audit's explicit
 * requirement: the harness must know what it has indexed.
 */

import { describe, expect, it } from "vitest";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";

const EXPECTED_NOTE =
	"Mock adapter — no real language service attached. Run a real LSP/TypeScript LS adapter to get results.";

describe("MockSemanticQueryAdapter — default behaviour", () => {
	it("getDefinition returns certainty: 'unknown' with the default note", async () => {
		const adapter = new MockSemanticQueryAdapter();
		const result = await adapter.getDefinition("Foo");
		expect(result.relation).toBe("definition");
		if (result.relation !== "definition") throw new Error("narrow");
		expect(result.symbol).toBe("Foo");
		expect(result.certainty).toBe("unknown");
		expect(result.note).toBe(EXPECTED_NOTE);
		expect(result.locations).toEqual([]);
	});

	it("getReferences returns certainty: 'unknown' and coverage: 'unknown'", async () => {
		const adapter = new MockSemanticQueryAdapter();
		const result = await adapter.getReferences("Foo");
		expect(result.relation).toBe("reference");
		if (result.relation !== "reference") throw new Error("narrow");
		expect(result.symbol).toBe("Foo");
		expect(result.certainty).toBe("unknown");
		expect(result.coverage).toBe("unknown");
		expect(result.note).toBe(EXPECTED_NOTE);
		expect(result.locations).toEqual([]);
	});

	it("getCallers returns certainty: 'unknown' with empty direct and candidates", async () => {
		const adapter = new MockSemanticQueryAdapter();
		const result = await adapter.getCallers("Foo");
		expect(result.relation).toBe("caller");
		if (result.relation !== "caller") throw new Error("narrow");
		expect(result.symbol).toBe("Foo");
		expect(result.certainty).toBe("unknown");
		expect(result.direct).toEqual([]);
		expect(result.candidates).toEqual([]);
		expect(result.note).toBe(EXPECTED_NOTE);
	});

	it("getCallees returns certainty: 'unknown' with empty direct and candidates", async () => {
		const adapter = new MockSemanticQueryAdapter();
		const result = await adapter.getCallees("Foo");
		expect(result.relation).toBe("callee");
		if (result.relation !== "callee") throw new Error("narrow");
		expect(result.symbol).toBe("Foo");
		expect(result.certainty).toBe("unknown");
		expect(result.direct).toEqual([]);
		expect(result.candidates).toEqual([]);
		expect(result.note).toBe(EXPECTED_NOTE);
	});

	it("getImplementations returns certainty: 'unknown' with the default note", async () => {
		const adapter = new MockSemanticQueryAdapter();
		const result = await adapter.getImplementations("Foo");
		expect(result.relation).toBe("implementation");
		if (result.relation !== "implementation") throw new Error("narrow");
		expect(result.symbol).toBe("Foo");
		expect(result.certainty).toBe("unknown");
		expect(result.note).toBe(EXPECTED_NOTE);
		expect(result.locations).toEqual([]);
	});

	it("getRelevantTests returns certainty: 'unknown' with an empty tests list", async () => {
		const adapter = new MockSemanticQueryAdapter();
		const result = await adapter.getRelevantTests("Foo");
		expect(result.relation).toBe("test-relation");
		if (result.relation !== "test-relation") throw new Error("narrow");
		expect(result.symbol).toBe("Foo");
		expect(result.certainty).toBe("unknown");
		expect(result.tests).toEqual([]);
		expect(result.note).toBe(EXPECTED_NOTE);
	});
});

