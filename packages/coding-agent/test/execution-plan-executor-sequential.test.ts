import { describe, expect, it } from "vitest";
import {
	type ExecutionPlan,
	type ExecutionStep,
	type ExecutionStepResult,
	executePlan,
	type StepRunner,
} from "../src/core/execution-plan/index.ts";

function linearThreeStep(): ExecutionPlan {
	return {
		id: "linear-3",
		intent: "sequential smoke test",
		steps: [
			{ id: "A", kind: "read", operation: "read input", dependsOn: [] },
			{ id: "B", kind: "edit", operation: "edit", dependsOn: ["A"] },
			{ id: "C", kind: "test", operation: "run test", dependsOn: ["B"] },
		],
		stopConditions: [],
		createdAt: 0,
	};
}

describe("executePlan (sequential)", () => {
	it("runs a 3-step linear plan to completion with status 'completed'", async () => {
		const order: string[] = [];
		const runner: StepRunner = async (step) => {
			order.push(step.id);
			return {
				stepId: step.id,
				status: "succeeded",
				startedAt: Date.now(),
				endedAt: Date.now(),
				wallTimeMs: 0,
			};
		};

		const result = await executePlan({ plan: linearThreeStep(), runner });

		expect(result.status).toBe("completed");
		expect(result.planId).toBe("linear-3");
		expect(result.stepResults).toHaveLength(3);
		// Steps were invoked in topological (and therefore declaration) order.
		expect(order).toEqual(["A", "B", "C"]);
		// Final result stepResults are reordered to topological order
		// so callers can pair them with plan.steps by index.
		expect(result.stepResults.map((r) => r.stepId)).toEqual(["A", "B", "C"]);
		for (const r of result.stepResults) {
			expect(r.status).toBe("succeeded");
		}
	});

	it("captures per-step output, error, and timing fields when the runner provides them", async () => {
		const plan: ExecutionPlan = {
			id: "capture",
			intent: "capture runner-provided fields",
			steps: [{ id: "A", kind: "read", operation: "read", dependsOn: [] }],
			stopConditions: [],
			createdAt: 0,
		};
		const runner: StepRunner = async (step) => {
			return {
				stepId: step.id,
				status: "succeeded",
				output: { lines: 42 },
				startedAt: 100,
				endedAt: 250,
				wallTimeMs: 150,
			};
		};

		const result = await executePlan({ plan, runner });
		expect(result.status).toBe("completed");
		const only: ExecutionStepResult = result.stepResults[0]!;
		expect(only.output).toEqual({ lines: 42 });
		expect(only.startedAt).toBe(100);
		expect(only.endedAt).toBe(250);
		expect(only.wallTimeMs).toBe(150);
	});

	it("clamps concurrency < 1 to 1 without changing behavior", async () => {
		const seen: ExecutionStep[] = [];
		const runner: StepRunner = async (step) => {
			seen.push(step);
			return {
				stepId: step.id,
				status: "succeeded",
				startedAt: Date.now(),
				endedAt: Date.now(),
				wallTimeMs: 0,
			};
		};
		const result = await executePlan({ plan: linearThreeStep(), runner, concurrency: 0 });
		expect(result.status).toBe("completed");
		expect(seen.map((s) => s.id)).toEqual(["A", "B", "C"]);
	});
});

