import { describe, expect, it } from "vitest";
import { type ExecutionPlan, executePlan, type StepRunner } from "../src/core/execution-plan/index.ts";

function planWithCancelStop(): ExecutionPlan {
	return {
		id: "abort-signal",
		intent: "abort between B and C",
		steps: [
			{ id: "A", kind: "read", operation: "read", dependsOn: [] },
			{ id: "B", kind: "edit", operation: "edit", dependsOn: ["A"] },
			{ id: "C", kind: "test", operation: "test", dependsOn: ["B"] },
			{ id: "D", kind: "test", operation: "test (independent of B)", dependsOn: ["A"] },
		],
		stopConditions: [{ kind: "on-user-cancel" }],
		createdAt: 0,
	};
}

describe("executePlan (abort signal)", () => {
	it("aborts the plan between B and C and reports C, D as cancelled with status 'halted-on-user-cancel'", async () => {
		const controller = new AbortController();
		let abortedDuring: string | null = null;

		const runner: StepRunner = async (step, signal) => {
			if (step.id === "B") {
				// Wait for the signal to fire, then complete normally
				// (so the executor observes the abort at the start of C).
				await new Promise<void>((resolve) => {
					if (signal.aborted) {
						resolve();
						return;
					}
					signal.addEventListener(
						"abort",
						() => {
							abortedDuring = step.id;
							resolve();
						},
						{ once: true },
					);
				});
			}
			return {
				stepId: step.id,
				status: "succeeded",
				startedAt: 0,
				endedAt: 0,
				wallTimeMs: 0,
			};
		};

		// Trigger abort from the runner while B is still in flight.
		const promise = executePlan({
			plan: planWithCancelStop(),
			runner,
			signal: controller.signal,
		});
		// Give the executor a tick to enter B, then abort.
		setTimeout(() => controller.abort(), 5);
		const result = await promise;

		expect(abortedDuring).toBe("B");
		expect(result.status).toBe("halted-on-user-cancel");
		const byId = new Map(result.stepResults.map((r) => [r.stepId, r]));
		expect(byId.get("A")?.status).toBe("succeeded");
		expect(byId.get("B")?.status).toBe("succeeded");
		// C, D never start after the abort, so they are cancelled.
		expect(byId.get("C")?.status).toBe("cancelled");
		expect(byId.get("D")?.status).toBe("cancelled");
	});

	it("treats an AbortError thrown by the runner as a 'cancelled' step result", async () => {
		const plan: ExecutionPlan = {
			id: "abort-throw",
			intent: "runner throws AbortError",
			steps: [
				{ id: "A", kind: "read", operation: "read", dependsOn: [] },
				{ id: "B", kind: "read", operation: "read", dependsOn: ["A"] },
			],
			stopConditions: [{ kind: "on-user-cancel" }],
			createdAt: 0,
		};
		const runner: StepRunner = async (step) => {
			if (step.id === "B") {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
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
		expect(result.status).toBe("halted-on-user-cancel");
		const byId = new Map(result.stepResults.map((r) => [r.stepId, r]));
		expect(byId.get("A")?.status).toBe("succeeded");
		expect(byId.get("B")?.status).toBe("cancelled");
		expect(byId.get("B")?.error?.name).toBe("AbortError");
	});
});

