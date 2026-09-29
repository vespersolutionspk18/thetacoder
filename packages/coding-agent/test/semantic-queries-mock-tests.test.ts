/**
 * F1 semantic queries — getRelevantTests variant.
 *
 * The audit explicitly warns: "never imply exhaustive safety" — the
 * test result is a ranked list with per-test confidence, not a
 * guarantee. This test verifies the ranked shape survives injection.
 */

import { describe, expect, it } from "vitest";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";

describe("MockSemanticQueryAdapter — getRelevantTests", () => {
	it("returns injected ranked tests with confidence scores", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockResult("test-relation", "createUser", {
			relation: "test-relation",
			symbol: "createUser",
			tests: [
				{
					path: "test/services/user-service.test.ts",
					reason: "Direct import of createUser",
					confidence: 0.95,
				},
				{
					path: "test/api/users.test.ts",
					reason: "Calls API route backed by createUser",
					confidence: 0.7,
				},
				{
					path: "test/integration/signup.test.ts",
					reason: "Exercises the signup path that uses createUser",
					confidence: 0.4,
				},
			],
			certainty: "candidate",
			note: "Tests ranked by confidence; not exhaustive.",
		});

		const result = await adapter.getRelevantTests("createUser");
		if (result.relation !== "test-relation") throw new Error("expected test-relation");
		expect(result.tests).toHaveLength(3);
		expect(result.tests[0]?.confidence).toBe(0.95);
		expect(result.tests[0]?.path).toBe("test/services/user-service.test.ts");
		expect(result.tests[2]?.confidence).toBe(0.4);
		// Confidence scores are monotonically non-increasing.
		const confs = result.tests.map((t) => t.confidence);
		for (let i = 1; i < confs.length; i += 1) {
			const prev = confs[i - 1] ?? 0;
			const cur = confs[i] ?? 0;
			expect(prev).toBeGreaterThanOrEqual(cur);
		}
		expect(result.certainty).toBe("candidate");
	});

	it("accepts an empty tests list when the symbol has no known tests", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockResult("test-relation", "Internal", {
			relation: "test-relation",
			symbol: "Internal",
			tests: [],
			certainty: "unknown",
		});

		const result = await adapter.getRelevantTests("Internal");
		if (result.relation !== "test-relation") throw new Error("narrow");
		expect(result.tests).toEqual([]);
	});
});

