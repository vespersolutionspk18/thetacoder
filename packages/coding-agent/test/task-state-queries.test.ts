import { describe, expect, it } from "vitest";
import {
	addConstraint,
	createInitialTaskState,
	getActiveConstraints,
	getFailedVerifications,
	getOpenHypotheses,
	markHypothesisResolved,
	recordVerification,
	type TaskState,
} from "../src/core/task-state.ts";

function makeConstraint(source: "user" | "model" | "extension", text: string) {
	return { text, source } as const;
}

describe("TaskState queries", () => {
	it("getActiveConstraints returns all constraints (none superseded today)", () => {
		const s0 = createInitialTaskState("s");
		const s1 = addConstraint(s0, makeConstraint("user", "u1"));
		const s2 = addConstraint(s1, makeConstraint("model", "m1"));
		const s3 = addConstraint(s2, makeConstraint("extension", "e1"));

		const active = getActiveConstraints(s3);
		expect(active).toHaveLength(3);
		expect(active.map((c) => c.text).sort()).toEqual(["e1", "m1", "u1"]);
	});

	it("getActiveConstraints excludes entries explicitly marked superseded", () => {
		const s0 = createInitialTaskState("s");
		const s1 = addConstraint(s0, makeConstraint("user", "u1"));
		// Inject a supersededBy field via a second mutation that the future
		// contract supports; the current filter reads it.
		const markedSuperseded = {
			...s1,
			constraints: s1.constraints.map((c, i) => (i === 0 ? { ...c, supersededBy: "later" } : c)),
		};

		const active = getActiveConstraints(markedSuperseded);
		expect(active).toHaveLength(0);
	});

	it("getOpenHypotheses excludes confirmed and refuted", () => {
		const s0 = createInitialTaskState("s");
		const withH: TaskState = {
			...s0,
			hypotheses: [
				{ id: "h1", text: "open one", status: "open", madeAt: 0 },
				{ id: "h2", text: "confirmed one", status: "confirmed", madeAt: 0, resolvedAt: 1 },
				{ id: "h3", text: "refuted one", status: "refuted", madeAt: 0, resolvedAt: 2 },
			],
		};

		const open = getOpenHypotheses(withH);
		expect(open).toHaveLength(1);
		expect(open[0]!.id).toBe("h1");
		expect(open[0]!.status).toBe("open");
	});

	it("getOpenHypotheses reflects markHypothesisResolved", () => {
		const s0 = createInitialTaskState("s");
		const seeded: TaskState = {
			...s0,
			hypotheses: [
				{ id: "h1", text: "t1", status: "open", madeAt: 0 },
				{ id: "h2", text: "t2", status: "open", madeAt: 0 },
			],
		};
		expect(getOpenHypotheses(seeded)).toHaveLength(2);

		const confirmed = markHypothesisResolved(seeded, "h1", "confirmed");
		const openAfter = getOpenHypotheses(confirmed);
		expect(openAfter).toHaveLength(1);
		expect(openAfter[0]!.id).toBe("h2");

		const refuted = markHypothesisResolved(confirmed, "h2", "refuted");
		expect(getOpenHypotheses(refuted)).toEqual([]);
	});

	it("getFailedVerifications returns only passed=false entries", () => {
		const s0 = createInitialTaskState("s");
		const s1 = recordVerification(s0, { kind: "test", passed: true });
		const s2 = recordVerification(s1, { kind: "lint", passed: false });
		const s3 = recordVerification(s2, { kind: "typecheck", passed: false });
		const s4 = recordVerification(s3, { kind: "test", passed: true });

		const failed = getFailedVerifications(s4);
		expect(failed).toHaveLength(2);
		expect(failed.every((v) => v.passed === false)).toBe(true);
		expect(failed.map((v) => v.kind).sort()).toEqual(["lint", "typecheck"]);
	});

	it("getFailedVerifications returns empty when all passed", () => {
		const s0 = createInitialTaskState("s");
		const s1 = recordVerification(s0, { kind: "test", passed: true });
		const s2 = recordVerification(s1, { kind: "lint", passed: true });
		expect(getFailedVerifications(s2)).toEqual([]);
	});
});

