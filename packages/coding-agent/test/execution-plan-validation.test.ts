import { describe, expect, it } from "vitest";
import { createPlan, type ExecutionPlan, validatePlan } from "../src/core/execution-plan/index.ts";

function buildValidBasePlan(): ExecutionPlan {
	return createPlan("audit")
		.step({ id: "a", kind: "read", operation: "read foo.ts" })
		.reads(["src/foo.ts"])
		.step({ id: "b", kind: "edit", operation: "edit foo.ts" })
		.dependsOn("a")
		.reads(["src/foo.ts"])
		.writes(["src/foo.ts"])
		.build();
}

describe("validatePlan", () => {
	it("returns { ok: true } for a structurally valid plan", () => {
		const plan = buildValidBasePlan();
		expect(validatePlan(plan)).toEqual({ ok: true });
	});

	it("returns a duplicate-id error when two steps share an id", () => {
		const plan: ExecutionPlan = {
			id: "plan-test",
			intent: "audit",
			steps: [
				{ id: "dup", kind: "read", operation: "read", dependsOn: [] },
				{ id: "dup", kind: "edit", operation: "edit", dependsOn: [] },
			],
			stopConditions: [],
			createdAt: 0,
		};
		const result = validatePlan(plan);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const dup = result.errors.find((e) => e.kind === "duplicate-id");
		expect(dup).toBeDefined();
		expect(dup?.stepIds).toEqual(["dup"]);
	});

	it("returns an unknown-dependency error for a step that references a missing id", () => {
		const plan: ExecutionPlan = {
			id: "plan-test",
			intent: "audit",
			steps: [{ id: "a", kind: "read", operation: "read", dependsOn: ["ghost"] }],
			stopConditions: [],
			createdAt: 0,
		};
		const result = validatePlan(plan);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const unknown = result.errors.find((e) => e.kind === "unknown-dependency");
		expect(unknown).toBeDefined();
		expect(unknown?.stepIds).toEqual(["a"]);
		expect(unknown?.details).toContain("ghost");
	});

	it("returns a cycle error for A -> B -> C -> A", () => {
		const plan: ExecutionPlan = {
			id: "plan-test",
			intent: "audit",
			steps: [
				{ id: "A", kind: "edit", operation: "edit A", dependsOn: ["C"] },
				{ id: "B", kind: "edit", operation: "edit B", dependsOn: ["A"] },
				{ id: "C", kind: "edit", operation: "edit C", dependsOn: ["B"] },
			],
			stopConditions: [],
			createdAt: 0,
		};
		const result = validatePlan(plan);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const cycle = result.errors.find((e) => e.kind === "cycle");
		expect(cycle).toBeDefined();
		// The offending cycle should be reported as a non-empty array of step ids.
		expect(Array.isArray(cycle?.stepIds)).toBe(true);
		expect(cycle?.stepIds?.length).toBeGreaterThan(0);
	});

	it("returns a cycle error for a self-loop A -> A", () => {
		const plan: ExecutionPlan = {
			id: "plan-test",
			intent: "audit",
			steps: [{ id: "A", kind: "edit", operation: "edit A", dependsOn: ["A"] }],
			stopConditions: [],
			createdAt: 0,
		};
		const result = validatePlan(plan);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const cycle = result.errors.find((e) => e.kind === "cycle");
		expect(cycle).toBeDefined();
		expect(cycle?.stepIds?.[0]).toBe("A");
	});

	it("returns an invalid-resource-hint error for negative gpu", () => {
		const plan: ExecutionPlan = {
			...buildValidBasePlan(),
			resourceHints: { gpu: -1 },
		};
		const result = validatePlan(plan);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const bad = result.errors.find((e) => e.kind === "invalid-resource-hint");
		expect(bad).toBeDefined();
		expect(bad?.details).toContain("gpu");
	});

	it("returns an invalid-resource-hint error for non-finite cpu", () => {
		const plan: ExecutionPlan = {
			...buildValidBasePlan(),
			resourceHints: { cpu: Number.POSITIVE_INFINITY },
		};
		const result = validatePlan(plan);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const bad = result.errors.find((e) => e.kind === "invalid-resource-hint");
		expect(bad).toBeDefined();
		expect(bad?.details).toContain("cpu");
	});

	it("returns an invalid-resource-hint error for invalid io value", () => {
		const plan: ExecutionPlan = {
			...buildValidBasePlan(),
			// Force the io field past the type checker; the validator should
			// still treat it as invalid at runtime.
			resourceHints: { io: "extreme" as unknown as "high" },
		};
		const result = validatePlan(plan);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const bad = result.errors.find((e) => e.kind === "invalid-resource-hint");
		expect(bad).toBeDefined();
		expect(bad?.details).toContain("io");
	});

	it("accepts valid resource hints", () => {
		const plan: ExecutionPlan = {
			...buildValidBasePlan(),
			resourceHints: { gpu: 1, cpu: 4, io: "medium" },
		};
		expect(validatePlan(plan)).toEqual({ ok: true });
	});

	it("accepts a plan with no resourceHints set", () => {
		const plan: ExecutionPlan = {
			...buildValidBasePlan(),
			resourceHints: undefined,
		};
		expect(validatePlan(plan)).toEqual({ ok: true });
	});

	it("accumulates multiple errors at once", () => {
		const plan: ExecutionPlan = {
			id: "plan-test",
			intent: "audit",
			steps: [
				{ id: "A", kind: "edit", operation: "edit A", dependsOn: ["C"] },
				{ id: "B", kind: "edit", operation: "edit B", dependsOn: ["A", "ghost"] },
				{ id: "C", kind: "edit", operation: "edit C", dependsOn: ["B"] },
			],
			stopConditions: [],
			createdAt: 0,
			resourceHints: { gpu: -5 },
		};
		const result = validatePlan(plan);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const kinds = result.errors.map((e) => e.kind);
		expect(kinds).toContain("unknown-dependency");
		expect(kinds).toContain("cycle");
		expect(kinds).toContain("invalid-resource-hint");
	});

	it("allows writing a brand-new file that no other step wrote or read", () => {
		const plan = createPlan("audit")
			.step({ id: "create", kind: "write", operation: "create new file" })
			.writes(["src/new-file.ts"])
			.build();
		expect(validatePlan(plan)).toEqual({ ok: true });
	});
});

