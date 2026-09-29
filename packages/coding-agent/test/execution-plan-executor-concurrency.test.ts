import { describe, expect, it } from "vitest";
import {
	type ExecutionPlan,
	type ExecutionStepResult,
	executePlan,
	type StepRunner,
} from "../src/core/execution-plan/index.ts";

function independentFive(): ExecutionPlan {
	return {
		id: "concurrent-5",
		intent: "five independent steps",
		steps: [
			{ id: "1", kind: "test", operation: "t1", dependsOn: [] },
			{ id: "2", kind: "lint", operation: "l1", dependsOn: [] },
			{ id: "3", kind: "typecheck", operation: "tc1", dependsOn: [] },
			{ id: "4", kind: "build", operation: "b1", dependsOn: [] },
			{ id: "5", kind: "test", operation: "t2", dependsOn: [] },
		],
		stopConditions: [],
		createdAt: 0,
	};
}

describe("executePlan (concurrency)", () => {
	it("never runs more than 3 steps in flight at once when concurrency=3", async () => {
		const maxConcurrency = 3;
		let inFlight = 0;
		let observedMax = 0;
		const observedSamples: number[] = [];
		const completionOrder: string[] = [];

		const runner: StepRunner = async (step) => {
			inFlight += 1;
			observedMax = Math.max(observedMax, inFlight);
			observedSamples.push(inFlight);
			// Hold the step for long enough that all 5 try to start.
			await new Promise((resolve) => setTimeout(resolve, 30));
			inFlight -= 1;
			completionOrder.push(step.id);
			return {
				stepId: step.id,
				status: "succeeded",
				startedAt: 0,
				endedAt: 0,
				wallTimeMs: 30,
			};
		};

		const result = await executePlan({
			plan: independentFive(),
			runner,
			concurrency: maxConcurrency,
		});

		expect(result.status).toBe("completed");
		expect(result.stepResults).toHaveLength(5);
		expect(observedMax).toBeLessThanOrEqual(maxConcurrency);
		// We should observe > 1 concurrent step at some point; otherwise
		// concurrency was effectively 1 and the test is not exercising
		// the worker pool.
		expect(observedMax).toBeGreaterThan(1);
		// Every sample must be <= the configured cap.
		for (const sample of observedSamples) {
			expect(sample).toBeLessThanOrEqual(maxConcurrency);
			expect(sample).toBeGreaterThan(0);
		}
		// All 5 steps were started exactly once.
		expect(completionOrder.sort()).toEqual(["1", "2", "3", "4", "5"]);
	});

	it("with concurrency=1 all steps complete sequentially", async () => {
		const order: string[] = [];
		const runner: StepRunner = async (step) => {
			order.push(step.id);
			return {
				stepId: step.id,
				status: "succeeded",
				startedAt: 0,
				endedAt: 0,
				wallTimeMs: 0,
			};
		};
		const result = await executePlan({
			plan: independentFive(),
			runner,
			concurrency: 1,
		});
		expect(result.status).toBe("completed");
		expect(order).toEqual(["1", "2", "3", "4", "5"]);
	});

	it("with concurrency > steps.length, behavior matches concurrency=1 in terms of completion", async () => {
		const runner: StepRunner = async (step) => ({
			stepId: step.id,
			status: "succeeded",
			startedAt: 0,
			endedAt: 0,
			wallTimeMs: 0,
		});
		const result = await executePlan({
			plan: independentFive(),
			runner,
			concurrency: 100,
		});
		expect(result.status).toBe("completed");
		expect(result.stepResults).toHaveLength(5);
		const ids = result.stepResults.map((r: ExecutionStepResult) => r.stepId);
		expect(ids.sort()).toEqual(["1", "2", "3", "4", "5"]);
	});
});

