/**
 * F1 semantic queries — getCallers variant.
 *
 * The audit requires `caller` (and `callee`) to separate statically
 * known direct callers from candidate dispatch targets. This test
 * verifies both arrays survive injection and that the adapter accepts
 * the distinction.
 */

import { describe, expect, it } from "vitest";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";

describe("MockSemanticQueryAdapter — getCallers", () => {
	it("returns injected direct and candidates as separate arrays", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockResult("caller", "createUser", {
			relation: "caller",
			symbol: "createUser",
			direct: [
				{ path: "src/api/users.ts", startLine: 24, endLine: 24 },
				{ path: "src/api/admin.ts", startLine: 91, endLine: 91 },
			],
			candidates: [
				// Possibly invokes createUser via a dependency-injected
				// `userService` reference. Static analysis cannot prove it.
				{ path: "src/jobs/sync.ts", startLine: 17, endLine: 17 },
			],
			certainty: "candidate",
			note: "candidates inferred from constructor types; verify before relying on them.",
		});

		const result = await adapter.getCallers("createUser");
		if (result.relation !== "caller") throw new Error("expected caller");
		expect(result.symbol).toBe("createUser");
		expect(result.direct).toHaveLength(2);
		expect(result.candidates).toHaveLength(1);
		expect(result.direct[0]?.path).toBe("src/api/users.ts");
		expect(result.candidates[0]?.path).toBe("src/jobs/sync.ts");
		expect(result.certainty).toBe("candidate");
		expect(result.note).toMatch(/verify/);
	});

	it("accepts an empty direct array and populated candidates array", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockResult("caller", "EventEmitter", {
			relation: "caller",
			symbol: "EventEmitter",
			direct: [],
			candidates: [
				{ path: "src/legacy.js", startLine: 5, endLine: 5 },
				{ path: "src/legacy2.js", startLine: 9, endLine: 9 },
			],
			certainty: "candidate",
		});

		const result = await adapter.getCallers("EventEmitter");
		if (result.relation !== "caller") throw new Error("narrow");
		expect(result.direct).toEqual([]);
		expect(result.candidates).toHaveLength(2);
	});
});

