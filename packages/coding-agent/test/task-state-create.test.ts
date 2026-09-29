import { describe, expect, it } from "vitest";
import { createInitialTaskState, type TaskState } from "../src/core/task-state.ts";

describe("createInitialTaskState", () => {
	it("returns a state with empty collections and matching timestamps", () => {
		const before = Date.now();
		const state = createInitialTaskState("session-abc");
		const after = Date.now();

		expect(state.id).toBe("session-abc");
		expect(state.objective).toBeUndefined();
		expect(state.constraints).toEqual([]);
		expect(state.decisions).toEqual([]);
		expect(state.hypotheses).toEqual([]);
		expect(state.changedFiles).toEqual([]);
		expect(state.verifications).toEqual([]);
		expect(state.evidence).toEqual([]);

		// createdAt and updatedAt must be set within the surrounding window
		expect(state.createdAt).toBeGreaterThanOrEqual(before);
		expect(state.createdAt).toBeLessThanOrEqual(after);
		expect(state.updatedAt).toBe(state.createdAt);
	});

	it("returns a new array instance per call (no shared references)", () => {
		const a = createInitialTaskState("s1");
		const b = createInitialTaskState("s1");

		// Distinct top-level objects
		expect(a).not.toBe(b);

		// Distinct array instances — mutating one must not affect the other
		a.constraints.push({
			id: "c1",
			text: "x",
			source: "user",
			createdAt: 0,
		});
		expect(b.constraints).toEqual([]);

		a.decisions.push({ id: "d1", text: "y", madeAt: 0 });
		expect(b.decisions).toEqual([]);

		a.hypotheses.push({ id: "h1", text: "z", status: "open", madeAt: 0 });
		expect(b.hypotheses).toEqual([]);

		a.changedFiles.push({ path: "x.ts", contentHash: "h", changedAt: 0 });
		expect(b.changedFiles).toEqual([]);

		a.verifications.push({ id: "v1", kind: "test", passed: true, observedAt: 0 });
		expect(b.verifications).toEqual([]);

		a.evidence.push({ id: "e1", kind: "source", hash: "h", byteLength: 1, capturedAt: 0 });
		expect(b.evidence).toEqual([]);
	});

	it("preserves the supplied id", () => {
		const state: TaskState = createInitialTaskState("some-stable-id-123");
		expect(state.id).toBe("some-stable-id-123");
	});
});

