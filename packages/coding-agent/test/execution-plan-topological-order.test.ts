import { describe, expect, it } from "vitest";
import { type ExecutionPlan, topologicalOrder } from "../src/core/execution-plan/index.ts";

function linearChain(): ExecutionPlan {
	return {
		id: "linear",
		intent: "test",
		steps: [
			{ id: "A", kind: "read", operation: "A", dependsOn: [] },
			{ id: "B", kind: "read", operation: "B", dependsOn: ["A"] },
			{ id: "C", kind: "read", operation: "C", dependsOn: ["B"] },
		],
		stopConditions: [],
		createdAt: 0,
	};
}

function diamond(): ExecutionPlan {
	// A -> B, A -> C, B -> D, C -> D
	return {
		id: "diamond",
		intent: "test",
		steps: [
			{ id: "A", kind: "read", operation: "A", dependsOn: [] },
			{ id: "B", kind: "read", operation: "B", dependsOn: ["A"] },
			{ id: "C", kind: "read", operation: "C", dependsOn: ["A"] },
			{ id: "D", kind: "read", operation: "D", dependsOn: ["B", "C"] },
		],
		stopConditions: [],
		createdAt: 0,
	};
}

describe("topologicalOrder", () => {
	it("returns A, B, C for a linear A -> B -> C chain", () => {
		expect(topologicalOrder(linearChain())).toEqual(["A", "B", "C"]);
	});

	it("returns a valid topological order for a diamond (A -> B, A -> C, B -> D, C -> D)", () => {
		const order = topologicalOrder(diamond());
		// A is the unique source; D is the unique sink.
		expect(order[0]).toBe("A");
		expect(order[order.length - 1]).toBe("D");
		expect(order).toHaveLength(4);
		// B and C must come after A and before D; either order is valid.
		const idxA = order.indexOf("A");
		const idxB = order.indexOf("B");
		const idxC = order.indexOf("C");
		const idxD = order.indexOf("D");
		expect(idxB).toBeGreaterThan(idxA);
		expect(idxC).toBeGreaterThan(idxA);
		expect(idxB).toBeLessThan(idxD);
		expect(idxC).toBeLessThan(idxD);
		// The builder preserves step input order, so B precedes C.
		expect(order).toEqual(["A", "B", "C", "D"]);
	});

	it("throws an Error including the offending cycle for A -> B -> A", () => {
		const plan: ExecutionPlan = {
			id: "cycle",
			intent: "test",
			steps: [
				{ id: "A", kind: "edit", operation: "A", dependsOn: ["B"] },
				{ id: "B", kind: "edit", operation: "B", dependsOn: ["A"] },
			],
			stopConditions: [],
			createdAt: 0,
		};
		expect(() => topologicalOrder(plan)).toThrowError(/cycle/i);
	});

	it("throws an Error that names at least one of the cycle members for a 3-step cycle", () => {
		const plan: ExecutionPlan = {
			id: "cycle",
			intent: "test",
			steps: [
				{ id: "A", kind: "edit", operation: "A", dependsOn: ["C"] },
				{ id: "B", kind: "edit", operation: "B", dependsOn: ["A"] },
				{ id: "C", kind: "edit", operation: "C", dependsOn: ["B"] },
			],
			stopConditions: [],
			createdAt: 0,
		};
		try {
			topologicalOrder(plan);
			throw new Error("expected topologicalOrder to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(Error);
			const message = (err as Error).message;
			expect(message).toMatch(/cycle/i);
			// All three cycle members should appear in the error message.
			expect(message).toContain("A");
			expect(message).toContain("B");
			expect(message).toContain("C");
		}
	});

	it("returns the input step order when no dependencies are declared", () => {
		const plan: ExecutionPlan = {
			id: "independent",
			intent: "test",
			steps: [
				{ id: "x", kind: "read", operation: "x", dependsOn: [] },
				{ id: "y", kind: "read", operation: "y", dependsOn: [] },
				{ id: "z", kind: "read", operation: "z", dependsOn: [] },
			],
			stopConditions: [],
			createdAt: 0,
		};
		expect(topologicalOrder(plan)).toEqual(["x", "y", "z"]);
	});
});

