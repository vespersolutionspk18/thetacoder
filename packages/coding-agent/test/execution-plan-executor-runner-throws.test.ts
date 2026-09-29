import { describe, expect, it } from "vitest";
import { type ExecutionPlan, executePlan, type StepRunner } from "../src/core/execution-plan/index.ts";

function linearTwoStep(): ExecutionPlan {
	return {
		id: "runner-throws",
		intent: "runner throws on one step",
		steps: [
			{ id: "A", kind: "read", operation: "read", dependsOn: [] },
			{ id: "B", kind: "edit", operation: "edit", dependsOn: ["A"] },
		],
		stopConditions: [],
		createdAt: 0,
	};
}

describe("executePlan (runner throws)", () => {
	it("captures a thrown Error as status 'failed' for that step and lets other steps succeed", async () => {
		const visited: string[] = [];
		const thrown = new Error("boom from runner");
		const runner: StepRunner = async (step) => {
			visited.push(step.id);
			if (step.id === "A") throw thrown;
			return {
				stepId: step.id,
				status: "succeeded",
				startedAt: 0,
				endedAt: 0,
				wallTimeMs: 0,
			};
		};

		const result = await executePlan({ plan: linearTwoStep(), runner });

		// Both steps ran because the plan has no stop conditions.
		expect(visited).toEqual(["A", "B"]);
		expect(result.status).toBe("completed");
		const byId = new Map(result.stepResults.map((r) => [r.stepId, r]));
		expect(byId.get("A")?.status).toBe("failed");
		expect(byId.get("A")?.error).toBe(thrown);
		expect(byId.get("B")?.status).toBe("succeeded");
	});

	it("wraps a non-Error throw value into an Error and reports it as 'failed'", async () => {
		const plan: ExecutionPlan = {
			id: "throw-string",
			intent: "non-Error throw",
			steps: [{ id: "A", kind: "read", operation: "read", dependsOn: [] }],
			stopConditions: [],
			createdAt: 0,
		};
		const runner: StepRunner = async () => {
			// eslint-disable-next-line @typescript-eslint/no-throw-literal
			throw "string error";
		};
		const result = await executePlan({ plan, runner });
		expect(result.status).toBe("completed");
		const only = result.stepResults[0]!;
		expect(only.status).toBe("failed");
		expect(only.error).toBeInstanceOf(Error);
		expect(only.error?.message).toBe("string error");
	});

	it("does not propagate the runner throw to the caller; executePlan resolves", async () => {
		const runner: StepRunner = async () => {
			throw new Error("never escapes");
		};
		const plan: ExecutionPlan = {
			id: "no-escape",
			intent: "throw containment",
			steps: [{ id: "A", kind: "read", operation: "read", dependsOn: [] }],
			stopConditions: [],
			createdAt: 0,
		};
		await expect(executePlan({ plan, runner })).resolves.toBeDefined();
	});
});

