import { describe, expect, it } from "vitest";
import { createPlan, type ExecutionPlan, topologicalOrder, validatePlan } from "../src/core/execution-plan/index.ts";

/**
 * Realistic-shape test mirroring the F6 audit's "Known-function fix"
 * row from the call amplification table (Section 14). The five steps
 * are intentionally the same as the audit's example:
 *
 *   1. locate   — find the function definition
 *   2. read     — read the function source
 *   3. inspect  — enumerate callers (grep)
 *   4. edit     — apply the fix
 *   5. check    — run targeted tests
 *
 * Concurrency rules (from the audit):
 *   - Must be sequential: dependent edits, mutation then validation,
 *     conflicting extension transforms.
 *   - Can be concurrent: independent reads from one snapshot, unrelated
 *     repository queries.
 *
 * In this plan, step 3 is declared as an "inspect-only" call-grep that
 * does not write, so it is a pure read of the same snapshot read in
 * step 2 and could conceptually run concurrently with it. We model the
 * safer dependency: inspect depends on read, since real callers only
 * become visible after the read is consistent. Tests assert the strict
 * topological order produced by the validator.
 */
describe("ExecutionPlan realistic shape (Known-function fix)", () => {
	const buildKnownFunctionFixPlan = (): ExecutionPlan =>
		createPlan("audit-known-function-fix")
			.step({
				id: "locate",
				kind: "grep",
				operation: "locate function definition",
				target: "src/foo.ts",
			})
			.reads(["src/foo.ts"])
			.step({
				id: "read",
				kind: "read",
				operation: "read function source",
				target: "src/foo.ts",
			})
			.dependsOn("locate")
			.reads(["src/foo.ts"])
			.step({
				id: "inspect-callers",
				kind: "grep",
				operation: "enumerate callers",
				target: "src/foo.ts",
			})
			.dependsOn("read")
			.reads(["src/foo.ts"])
			.step({
				id: "edit",
				kind: "edit",
				operation: "apply the fix",
				target: "src/foo.ts",
				stopOnUnexpected: true,
			})
			.dependsOn("inspect-callers")
			.reads(["src/foo.ts"])
			.writes(["src/foo.ts"])
			.step({
				id: "check",
				kind: "test",
				operation: "run targeted tests",
				expectedOutcome: "passed",
			})
			.dependsOn("edit")
			.reads(["src/foo.ts"])
			.stopOn({ kind: "on-failure", haltAll: true })
			.stopOn({ kind: "on-context-overflow", skipRemaining: true })
			.build();

	it("produces a 5-step plan with the expected ids and kinds", () => {
		const plan = buildKnownFunctionFixPlan();
		expect(plan.steps).toHaveLength(5);
		const ids = plan.steps.map((s) => s.id);
		expect(ids).toEqual(["locate", "read", "inspect-callers", "edit", "check"]);
		expect(plan.steps[0]?.kind).toBe("grep");
		expect(plan.steps[1]?.kind).toBe("read");
		expect(plan.steps[2]?.kind).toBe("grep");
		expect(plan.steps[3]?.kind).toBe("edit");
		expect(plan.steps[4]?.kind).toBe("test");
	});

	it("validates cleanly with validatePlan returning { ok: true }", () => {
		const plan = buildKnownFunctionFixPlan();
		const result = validatePlan(plan);
		expect(result).toEqual({ ok: true });
	});

	it("topologicalOrder matches the intended sequence", () => {
		const plan = buildKnownFunctionFixPlan();
		expect(topologicalOrder(plan)).toEqual(["locate", "read", "inspect-callers", "edit", "check"]);
	});

	it("captures plan-level stop conditions", () => {
		const plan = buildKnownFunctionFixPlan();
		expect(plan.stopConditions).toHaveLength(2);
		expect(plan.stopConditions[0]?.kind).toBe("on-failure");
		expect(plan.stopConditions[0]?.haltAll).toBe(true);
		expect(plan.stopConditions[1]?.kind).toBe("on-context-overflow");
		expect(plan.stopConditions[1]?.skipRemaining).toBe(true);
	});

	it("attaches the per-step read/write sets and the edit step's writeSet", () => {
		const plan = buildKnownFunctionFixPlan();
		const edit = plan.steps.find((s) => s.id === "edit")!;
		expect(edit.readSet).toEqual(["src/foo.ts"]);
		expect(edit.writeSet).toEqual(["src/foo.ts"]);
		expect(edit.stopOnUnexpected).toBe(true);

		const check = plan.steps.find((s) => s.id === "check")!;
		expect(check.readSet).toEqual(["src/foo.ts"]);
		expect(check.expectedOutcome).toBe("passed");
	});

	it("each step except the first has exactly one dependsOn (linear pipeline)", () => {
		const plan = buildKnownFunctionFixPlan();
		for (const step of plan.steps) {
			if (step.id === "locate") {
				expect(step.dependsOn).toEqual([]);
			} else {
				expect(step.dependsOn).toHaveLength(1);
			}
		}
	});
});

