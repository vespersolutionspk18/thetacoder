import { describe, expect, it } from "vitest";
import {
	type ExecutionPlan,
	type ExecutionStepResult,
	executePlan,
	type StepRunner,
} from "../src/core/execution-plan/index.ts";

function diamond(): ExecutionPlan {
	// A -> B, A -> C, B -> D, C -> D
	return {
		id: "diamond",
		intent: "diamond dependency test",
		steps: [
			{ id: "A", kind: "read", operation: "read", dependsOn: [] },
			{ id: "B", kind: "edit", operation: "edit B", dependsOn: ["A"] },
			{ id: "C", kind: "edit", operation: "edit C", dependsOn: ["A"] },
			{ id: "D", kind: "test", operation: "verify", dependsOn: ["B", "C"] },
		],
		stopConditions: [],
		createdAt: 0,
	};
}

describe("executePlan (dependencies)", () => {
	it("runs a diamond plan with concurrency=2 and ensures D starts only after B and C complete", async () => {
		const startedAt: Record<string, number> = {};
		const endedAt: Record<string, number> = {};
		const order: string[] = [];

		const runner: StepRunner = async (step) => {
			startedAt[step.id] = Date.now();
			order.push(`start:${step.id}`);
			// B and C each take 25ms; A takes 5ms; D takes 5ms.
			// We give B and C asymmetric delays so the executor must
			// not let D start until BOTH are done.
			const delay = step.id === "B" ? 25 : step.id === "C" ? 40 : 5;
			await new Promise((resolve) => setTimeout(resolve, delay));
			endedAt[step.id] = Date.now();
			order.push(`end:${step.id}`);
			return {
				stepId: step.id,
				status: "succeeded",
				startedAt: startedAt[step.id]!,
				endedAt: endedAt[step.id]!,
				wallTimeMs: delay,
			};
		};

		const result = await executePlan({ plan: diamond(), runner, concurrency: 2 });

		expect(result.status).toBe("completed");
		expect(result.stepResults.map((r) => r.stepId)).toEqual(["A", "B", "C", "D"]);
		for (const r of result.stepResults) expect(r.status).toBe("succeeded");

		// A must end before B and C start.
		expect(startedAt.A).toBeLessThanOrEqual(startedAt.B);
		expect(startedAt.A).toBeLessThanOrEqual(startedAt.C);
		// D must start AFTER both B and C ended.
		expect(startedAt.D).toBeGreaterThanOrEqual(endedAt.B);
		expect(startedAt.D).toBeGreaterThanOrEqual(endedAt.C);
		// D must also end after B and C.
		expect(endedAt.D).toBeGreaterThanOrEqual(endedAt.B);
		expect(endedAt.D).toBeGreaterThanOrEqual(endedAt.C);
		// A must be the first step; D must be the last.
		expect(order[0]).toBe("start:A");
		expect(order[order.length - 1]).toBe("end:D");
	});

	it("reports one step result per declared step in topological order", async () => {
		const runner: StepRunner = async (step) => ({
			stepId: step.id,
			status: "succeeded",
			startedAt: 0,
			endedAt: 0,
			wallTimeMs: 0,
		});
		const result = await executePlan({ plan: diamond(), runner, concurrency: 2 });
		expect(result.stepResults).toHaveLength(4);
		expect(result.stepResults.map((r: ExecutionStepResult) => r.stepId)).toEqual(["A", "B", "C", "D"]);
	});
});

