/**
 * F1 semantic queries — getDefinition variant.
 *
 * Specifically exercises the definition branch: a non-empty `locations`
 * array with a real `certainty: "exact"` value is returned after
 * injection.
 */

import { describe, expect, it } from "vitest";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";

describe("MockSemanticQueryAdapter — getDefinition", () => {
	it("returns the injected definition with non-empty locations", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockResult("definition", "createUser", {
			relation: "definition",
			symbol: "createUser",
			locations: [
				{
					path: "src/services/user-service.ts",
					startLine: 42,
					endLine: 58,
					startByte: 1024,
					endByte: 1530,
				},
			],
			certainty: "exact",
			note: "Resolved via TypeScript Language Service.",
		});

		const result = await adapter.getDefinition("createUser");
		if (result.relation !== "definition") throw new Error("expected definition");
		expect(result.certainty).toBe("exact");
		expect(result.locations).toHaveLength(1);
		expect(result.locations[0]).toEqual({
			path: "src/services/user-service.ts",
			startLine: 42,
			endLine: 58,
			startByte: 1024,
			endByte: 1530,
		});
		expect(result.note).toBe("Resolved via TypeScript Language Service.");
	});

	it("accepts multiple locations for an overloaded symbol", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockResult("definition", "process", {
			relation: "definition",
			symbol: "process",
			locations: [
				{ path: "src/a.ts", startLine: 10, endLine: 20 },
				{ path: "src/b.ts", startLine: 30, endLine: 40 },
			],
			certainty: "candidate",
		});

		const result = await adapter.getDefinition("process");
		if (result.relation !== "definition") throw new Error("narrow");
		expect(result.locations).toHaveLength(2);
		expect(result.locations.map((l) => l.path)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(result.certainty).toBe("candidate");
	});
});

