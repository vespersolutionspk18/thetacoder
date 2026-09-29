import { describe, expect, it } from "vitest";
import {
	addConstraint,
	createInitialTaskState,
	markHypothesisResolved,
	recordChange,
	recordDecision,
	recordEvidence,
	recordVerification,
	type TaskState,
} from "../src/core/task-state.ts";

/** Tiny sleep so updatedAt is observably different from createdAt. */
const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms));

describe("TaskState mutations", () => {
	it("addConstraint appends an entry with id+createdAt and bumps updatedAt", async () => {
		const initial = createInitialTaskState("s");
		await tick();
		const next = addConstraint(initial, { text: "no any", source: "user" });

		// New object, not mutated
		expect(next).not.toBe(initial);
		expect(initial.constraints).toEqual([]);

		expect(next.constraints).toHaveLength(1);
		const c = next.constraints[0]!;
		expect(c.id).toBeTruthy();
		expect(typeof c.id).toBe("string");
		expect(c.text).toBe("no any");
		expect(c.source).toBe("user");
		expect(typeof c.createdAt).toBe("number");
		expect(c.createdAt).toBeGreaterThanOrEqual(initial.createdAt);
		expect(next.updatedAt).toBeGreaterThan(initial.updatedAt);
	});

	it("recordDecision appends an entry with id+madeAt and bumps updatedAt", async () => {
		const initial = createInitialTaskState("s");
		await tick();
		const next = recordDecision(initial, { text: "use jsonl" });

		expect(next).not.toBe(initial);
		expect(initial.decisions).toEqual([]);
		expect(next.decisions).toHaveLength(1);
		const d = next.decisions[0]!;
		expect(d.id).toBeTruthy();
		expect(d.text).toBe("use jsonl");
		expect(typeof d.madeAt).toBe("number");
		expect(d.madeAt).toBeGreaterThanOrEqual(initial.createdAt);
		expect(next.updatedAt).toBeGreaterThan(initial.updatedAt);
	});

	it("markHypothesisResolved resolves an open hypothesis and bumps updatedAt", async () => {
		const initial = createInitialTaskState("s");
		const withHyp = recordDecision(initial, { text: "introduce hypothesis" });
		const open: TaskState = {
			...withHyp,
			hypotheses: [...withHyp.hypotheses, { id: "h1", text: "tests pass", status: "open", madeAt: Date.now() }],
		};
		const before = open.updatedAt;
		await tick();
		const resolved = markHypothesisResolved(open, "h1", "confirmed");

		expect(resolved).not.toBe(open);
		expect(resolved.hypotheses).toHaveLength(1);
		const h = resolved.hypotheses[0]!;
		expect(h.status).toBe("confirmed");
		expect(typeof h.resolvedAt).toBe("number");
		expect(h.resolvedAt!).toBeGreaterThanOrEqual(before);
		expect(resolved.updatedAt).toBeGreaterThan(before);

		// Confirming an already-resolved hypothesis should be a no-op on the
		// entry itself (its resolvedAt is preserved, status unchanged).
		await tick();
		const refuted = markHypothesisResolved(resolved, "h1", "refuted");
		expect(refuted.hypotheses[0]!.status).toBe("confirmed");
		expect(refuted.hypotheses[0]!.resolvedAt).toBe(h.resolvedAt);
	});

	it("recordVerification appends an entry with id+observedAt and bumps updatedAt", async () => {
		const initial = createInitialTaskState("s");
		await tick();
		const next = recordVerification(initial, {
			kind: "test",
			command: "npm test",
			passed: true,
		});

		expect(next).not.toBe(initial);
		expect(next.verifications).toHaveLength(1);
		const v = next.verifications[0]!;
		expect(v.id).toBeTruthy();
		expect(v.kind).toBe("test");
		expect(v.command).toBe("npm test");
		expect(v.passed).toBe(true);
		expect(typeof v.observedAt).toBe("number");
		expect(v.observedAt).toBeGreaterThanOrEqual(initial.createdAt);
		expect(next.updatedAt).toBeGreaterThan(initial.updatedAt);
	});

	it("recordChange appends an entry with changedAt and bumps updatedAt", async () => {
		const initial = createInitialTaskState("s");
		await tick();
		const next = recordChange(initial, {
			path: "src/foo.ts",
			contentHash: "sha256:abc",
		});

		expect(next).not.toBe(initial);
		expect(next.changedFiles).toHaveLength(1);
		const f = next.changedFiles[0]!;
		expect(f.path).toBe("src/foo.ts");
		expect(f.contentHash).toBe("sha256:abc");
		expect(typeof f.changedAt).toBe("number");
		expect(f.changedAt).toBeGreaterThanOrEqual(initial.createdAt);
		expect(next.updatedAt).toBeGreaterThan(initial.updatedAt);
	});

	it("recordEvidence appends an entry with id+capturedAt and bumps updatedAt", async () => {
		const initial = createInitialTaskState("s");
		await tick();
		const next = recordEvidence(initial, {
			kind: "log",
			hash: "sha256:def",
			byteLength: 1024,
		});

		expect(next).not.toBe(initial);
		expect(next.evidence).toHaveLength(1);
		const e = next.evidence[0]!;
		expect(e.id).toBeTruthy();
		expect(e.kind).toBe("log");
		expect(e.hash).toBe("sha256:def");
		expect(e.byteLength).toBe(1024);
		expect(typeof e.capturedAt).toBe("number");
		expect(e.capturedAt).toBeGreaterThanOrEqual(initial.createdAt);
		expect(next.updatedAt).toBeGreaterThan(initial.updatedAt);
	});

	it("each call returns a new state object (no in-place mutation)", async () => {
		const a = createInitialTaskState("s");
		const b = addConstraint(a, { text: "c1", source: "user" });
		const c = addConstraint(b, { text: "c2", source: "model" });

		expect(a).not.toBe(b);
		expect(b).not.toBe(c);
		expect(a.constraints).toEqual([]);
		expect(b.constraints).toHaveLength(1);
		expect(c.constraints).toHaveLength(2);
		// IDs must be unique across mutations
		const ids = new Set(c.constraints.map((x) => x.id));
		expect(ids.size).toBe(2);
	});
});

