/**
 * F1 semantic queries — getReferences variant.
 *
 * The reference result carries an explicit `coverage` label. This test
 * exercises `coverage: "partial"` to make sure the field is preserved
 * through the injection path.
 */

import { describe, expect, it } from "vitest";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";

describe("MockSemanticQueryAdapter — getReferences", () => {
	it("returns the injected references with coverage: 'partial'", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockResult("reference", "createUser", {
			relation: "reference",
			symbol: "createUser",
			locations: [
				{ path: "src/api/users.ts", startLine: 12, endLine: 12 },
				{ path: "src/jobs/cleanup.ts", startLine: 88, endLine: 88 },
			],
			certainty: "exact",
			coverage: "partial",
			note: "node_modules/ not indexed; results may be incomplete.",
		});

		const result = await adapter.getReferences("createUser");
		if (result.relation !== "reference") throw new Error("expected reference");
		expect(result.certainty).toBe("exact");
		expect(result.coverage).toBe("partial");
		expect(result.locations).toHaveLength(2);
		expect(result.locations[0]?.path).toBe("src/api/users.ts");
		expect(result.locations[1]?.path).toBe("src/jobs/cleanup.ts");
		expect(result.note).toMatch(/node_modules/);
	});

	it("accepts a 'complete' coverage label", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockResult("reference", "Foo", {
			relation: "reference",
			symbol: "Foo",
			locations: [],
			certainty: "exact",
			coverage: "complete",
		});

		const result = await adapter.getReferences("Foo");
		if (result.relation !== "reference") throw new Error("narrow");
		expect(result.coverage).toBe("complete");
		expect(result.locations).toEqual([]);
	});
});

