import { describe, expect, it } from "vitest";
import { type ExecutionPlan, executePlan, type StepRunner } from "../src/core/execution-plan/index.ts";

function planWithFailureStop(): ExecutionPlan {
	// A -> B -> C, A -> D (D is independent of B and C).
	return {
		id: "stop-on-failure",
		intent: "halt plan on first failure",
		steps: [
			{ id: "A", kind: "read", operation: "read", dependsOn: [] },
			{ id: "B", kind: "edit", operation: "edit", dependsOn: ["A"] },
			{ id: "C", kind: "test", operation: "test", dependsOn: ["B"] },
			{ id: "D", kind: "test", operation: "test (independent)", dependsOn: ["A"] },
		],
		stopConditions: [{ kind: "on-failure", haltAll: true }],
		createdAt: 0,
	};
}

describe("executePlan (stop on failure)", () => {
	it("halts the plan as 'halted-on-failure' when a step fails and marks remaining steps cancelled", async () => {
		const visited: string[] = [];
		const runner: StepRunner = async (step) => {
			visited.push(step.id);
			if (step.id === "B") {
				return {
					stepId: step.id,
					status: "failed",
					startedAt: 0,
					endedAt: 0,
					wallTimeMs: 0,
					error: new Error("B blew up"),
				};
			}
			return {
				stepId: step.id,
				status: "succeeded",
				startedAt: 0,
				endedAt: 0,
				wallTimeMs: 0,
			};
		};

		const result = await executePlan({ plan: planWithFailureStop(), runner });

		expect(result.status).toBe("halted-on-failure");
		// B is the failure; A, B were visited. With sequential default
		// the executor may or may not have started C or D before the
		// halt flag is set; what matters is the final stepResults.
		expect(visited).toContain("B");
		const byId = new Map(result.stepResults.map((r) => [r.stepId, r]));
		expect(byId.get("A")?.status).toBe("succeeded");
		expect(byId.get("B")?.status).toBe("failed");
		// C depends on B so it must be cancelled (B failed -> C never ran).
		expect(byId.get("C")?.status).toBe("cancelled");
		// D depends only on A; with sequential execution, the halt
		// happens before D's runStep is reached, so D is also
		// cancelled. With concurrency > 1 it could have started
		// (we run sequentially here so the assertion is safe).
		expect(byId.get("D")?.status).toBe("cancelled");
		// C and D must have no error set (they were never run).
		expect(byId.get("C")?.error).toBeUndefined();
		expect(byId.get("D")?.error).toBeUndefined();
	});

	it("does not halt when the plan has no on-failure stop condition even if a step fails", async () => {
		const plan: ExecutionPlan = {
			id: "no-stop",
			intent: "no stop condition",
			steps: [
				{ id: "A", kind: "read", operation: "read", dependsOn: [] },
				{ id: "B", kind: "read", operation: "read", dependsOn: ["A"] },
			],
			stopConditions: [],
			createdAt: 0,
		};
		const runner: StepRunner = async (step) => {
			if (step.id === "A") {
				return {
					stepId: step.id,
					status: "failed",
					startedAt: 0,
					endedAt: 0,
					wallTimeMs: 0,
					error: new Error("A failed"),
				};
			}
			return {
				stepId: step.id,
				status: "succeeded",
				startedAt: 0,
				endedAt: 0,
				wallTimeMs: 0,
			};
		};
		const result = await executePlan({ plan, runner });
		// Without an on-failure condition the executor should not
		// upgrade a failed step into a halted plan; it just keeps
		// running the remaining steps.
		expect(result.status).toBe("completed");
		const byId = new Map(result.stepResults.map((r) => [r.stepId, r]));
		expect(byId.get("A")?.status).toBe("failed");
		expect(byId.get("B")?.status).toBe("succeeded");
	});
});

