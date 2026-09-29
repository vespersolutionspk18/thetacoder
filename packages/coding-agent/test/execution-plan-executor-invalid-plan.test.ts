import { describe, expect, it } from "vitest";
import { type ExecutionPlan, executePlan, type StepRunner } from "../src/core/execution-plan/index.ts";

function cyclicPlan(): ExecutionPlan {
	// A -> B -> A is a cycle.
	return {
		id: "cyclic",
		intent: "cycle test",
		steps: [
			{ id: "A", kind: "edit", operation: "A", dependsOn: ["B"] },
			{ id: "B", kind: "edit", operation: "B", dependsOn: ["A"] },
		],
		stopConditions: [],
		createdAt: 0,
	};
}

const noopRunner: StepRunner = async (step) => ({
	stepId: step.id,
	status: "succeeded",
	startedAt: 0,
	endedAt: 0,
	wallTimeMs: 0,
});

describe("executePlan (invalid plan)", () => {
	it("throws an Error when the plan has a dependency cycle", async () => {
		await expect(executePlan({ plan: cyclicPlan(), runner: noopRunner })).rejects.toBeInstanceOf(Error);
	});

	it("throws when the plan has a duplicate step id", async () => {
		const plan: ExecutionPlan = {
			id: "dup",
			intent: "duplicate id test",
			steps: [
				{ id: "dup", kind: "read", operation: "read", dependsOn: [] },
				{ id: "dup", kind: "edit", operation: "edit", dependsOn: [] },
			],
			stopConditions: [],
			createdAt: 0,
		};
		await expect(executePlan({ plan, runner: noopRunner })).rejects.toThrow(/duplicate-id/);
	});

	it("throws when a step depends on an unknown id", async () => {
		const plan: ExecutionPlan = {
			id: "unknown",
			intent: "unknown dependency",
			steps: [{ id: "A", kind: "read", operation: "read", dependsOn: ["ghost"] }],
			stopConditions: [],
			createdAt: 0,
		};
		await expect(executePlan({ plan, runner: noopRunner })).rejects.toThrow(/unknown-dependency/);
	});

	it("error message includes the failing validation kinds for cycles", async () => {
		try {
			await executePlan({ plan: cyclicPlan(), runner: noopRunner });
			throw new Error("expected executePlan to reject the cyclic plan");
		} catch (err) {
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toMatch(/cycle/);
		}
	});
});

