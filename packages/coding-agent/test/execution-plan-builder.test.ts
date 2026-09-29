import { describe, expect, it } from "vitest";
import {
	createPlan,
	type ExecutionPlan,
	type ExecutionStep,
	topologicalOrder,
	validatePlan,
} from "../src/core/execution-plan/index.ts";

describe("ExecutionPlan builder", () => {
	it("produces a plan with the expected top-level shape", () => {
		const plan: ExecutionPlan = createPlan("audit-known-function-fix")
			.step({ id: "locate", kind: "grep", operation: "locate known function definition" })
			.step({ id: "read", kind: "read", operation: "read function source" })
			.step({ id: "edit", kind: "edit", operation: "edit function body" })
			.step({ id: "check", kind: "test", operation: "run targeted tests" })
			.build();

		expect(plan.intent).toBe("audit-known-function-fix");
		expect(plan.steps).toHaveLength(4);
		expect(plan.stopConditions).toEqual([]);
		expect(plan.resourceHints).toBeUndefined();
		expect(typeof plan.id).toBe("string");
		expect(plan.id.length).toBeGreaterThan(0);
		expect(typeof plan.createdAt).toBe("number");
		expect(plan.createdAt).toBeGreaterThan(0);
	});

	it("preserves step ids, kinds, operations, and target", () => {
		const plan = createPlan("audit")
			.step({ id: "a", kind: "read", operation: "read foo.ts", target: "src/foo.ts" })
			.step({ id: "b", kind: "write", operation: "write bar.ts", target: "src/bar.ts" })
			.build();

		const a = plan.steps.find((s) => s.id === "a")!;
		const b = plan.steps.find((s) => s.id === "b")!;
		expect(a.kind).toBe("read");
		expect(a.target).toBe("src/foo.ts");
		expect(b.kind).toBe("write");
		expect(b.target).toBe("src/bar.ts");
	});

	it("attaches read/write sets to the most recently opened step", () => {
		const plan = createPlan("audit")
			.step({ id: "read-step", kind: "read", operation: "read input" })
			.reads(["src/a.ts", "src/b.ts"])
			.step({ id: "edit-step", kind: "edit", operation: "edit a.ts" })
			.reads(["src/a.ts"])
			.writes(["src/a.ts"])
			.build();

		const readStep = plan.steps.find((s) => s.id === "read-step")!;
		const editStep = plan.steps.find((s) => s.id === "edit-step")!;
		expect(readStep.readSet).toEqual(["src/a.ts", "src/b.ts"]);
		expect(readStep.writeSet).toBeUndefined();
		expect(editStep.readSet).toEqual(["src/a.ts"]);
		expect(editStep.writeSet).toEqual(["src/a.ts"]);
	});

	it("attaches dependsOn entries to the most recently opened step", () => {
		const plan = createPlan("audit")
			.step({ id: "a", kind: "read", operation: "read" })
			.step({ id: "b", kind: "read", operation: "read" })
			.step({ id: "c", kind: "edit", operation: "edit" })
			.dependsOn("a")
			.dependsOn("b")
			.build();

		const c = plan.steps.find((s) => s.id === "c")!;
		expect(c.dependsOn).toEqual(["a", "b"]);
	});

	it("does not duplicate dependsOn entries when called twice with the same id", () => {
		const plan = createPlan("audit")
			.step({ id: "a", kind: "read", operation: "read" })
			.step({ id: "b", kind: "edit", operation: "edit" })
			.dependsOn("a")
			.dependsOn("a")
			.build();

		const b = plan.steps.find((s) => s.id === "b")!;
		expect(b.dependsOn).toEqual(["a"]);
	});

	it("accumulates stop conditions at the plan level", () => {
		const plan = createPlan("audit")
			.step({ id: "a", kind: "bash", operation: "run" })
			.stopOn({ kind: "on-failure", haltAll: true })
			.stopOn({ kind: "on-context-overflow", skipRemaining: true })
			.build();

		expect(plan.stopConditions).toHaveLength(2);
		expect(plan.stopConditions[0]?.kind).toBe("on-failure");
		expect(plan.stopConditions[0]?.haltAll).toBe(true);
		expect(plan.stopConditions[1]?.kind).toBe("on-context-overflow");
		expect(plan.stopConditions[1]?.skipRemaining).toBe(true);
	});

	it("supports preconditions, timeoutMs, and expectedOutcome on a step", () => {
		const plan = createPlan("audit")
			.step({
				id: "edit-step",
				kind: "edit",
				operation: "edit foo.ts",
				preconditions: [
					{ kind: "file-exists", target: "src/foo.ts" },
					{ kind: "file-hash", target: "src/foo.ts", expected: "abc123" },
				],
				timeoutMs: 30_000,
				stopOnUnexpected: true,
				expectedOutcome: "succeeded",
			})
			.build();

		const step = plan.steps[0]!;
		expect(step.preconditions).toEqual([
			{ kind: "file-exists", target: "src/foo.ts" },
			{ kind: "file-hash", target: "src/foo.ts", expected: "abc123" },
		]);
		expect(step.timeoutMs).toBe(30_000);
		expect(step.stopOnUnexpected).toBe(true);
		expect(step.expectedOutcome).toBe("succeeded");
	});

	it("snapshots builder state: later .step calls do not mutate earlier steps", () => {
		const builder = createPlan("audit").step({ id: "a", kind: "read", operation: "read" }).reads(["src/a.ts"]);

		const plan1 = builder.build();
		builder.step({ id: "b", kind: "edit", operation: "edit" });
		const plan2 = builder.build();

		expect(plan1.steps).toHaveLength(1);
		expect(plan2.steps).toHaveLength(2);
		const aInPlan1 = plan1.steps[0]!;
		expect(aInPlan1.readSet).toEqual(["src/a.ts"]);
	});

	it("builds a plan that validates successfully", () => {
		const plan = createPlan("audit")
			.step({ id: "a", kind: "read", operation: "read foo.ts" })
			.reads(["src/foo.ts"])
			.step({ id: "b", kind: "edit", operation: "edit foo.ts" })
			.dependsOn("a")
			.reads(["src/foo.ts"])
			.writes(["src/foo.ts"])
			.build();

		expect(validatePlan(plan)).toEqual({ ok: true });
		expect(topologicalOrder(plan)).toEqual(["a", "b"]);
	});

	it("throws when helper methods are called before any step is opened", () => {
		const builder = createPlan("audit");
		expect(() => builder.dependsOn("a")).toThrow(/step/);
		expect(() => builder.reads(["src/a.ts"])).toThrow(/step/);
		expect(() => builder.writes(["src/b.ts"])).toThrow(/step/);
	});

	it("produces a fresh plan id on every build call", () => {
		const builder = createPlan("audit").step({ id: "a", kind: "read", operation: "read" });
		const p1 = builder.build();
		const p2 = builder.build();
		expect(p1.id).not.toBe(p2.id);
		// both should still validate
		expect(validatePlan(p1).ok).toBe(true);
		expect(validatePlan(p2).ok).toBe(true);
	});

	it("does not leak references to step arrays between builds", () => {
		const builder = createPlan("audit").step({ id: "a", kind: "read", operation: "read" }).reads(["src/a.ts"]);

		const plan1 = builder.build();
		const initialReadSet = plan1.steps[0]!.readSet;
		// Mutate the builder state; plan1 should be unaffected.
		builder.step({ id: "b", kind: "edit", operation: "edit" });
		builder.dependsOn("a");

		const re: ExecutionStep | undefined = plan1.steps[0];
		expect(re?.readSet).toBe(initialReadSet);
		expect(plan1.steps).toHaveLength(1);
	});
});

