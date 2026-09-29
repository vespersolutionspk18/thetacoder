/**
 * F16 completion gate tests.
 *
 * Cover the four statuses the audit calls out:
 *   - satisfied — every blocking requirement has matching evidence
 *   - blocked   — at least one required check has no/failing evidence
 *   - unknown   — coverage is too thin to decide
 *   - open      — no requirements attached to the state
 *
 * Plus the snapshot-binding guarantee: a passing test from a
 * previous snapshot does NOT certify the current state.
 */

import { describe, expect, it } from "vitest";
import {
	recordChange as addChange,
	addRequirement,
	recordVerification as addVerification,
	createInitialTaskState,
	type TaskState,
} from "../src/core/task-state.ts";
import { evaluateGate } from "../src/core/verification/gate.ts";
import type { VerificationPolicy } from "../src/core/verification/types.ts";

function makePolicy(overrides: Partial<VerificationPolicy> = {}): VerificationPolicy {
	return {
		version: 1,
		concurrency: 1,
		timeoutMs: 5_000,
		logDir: ".theta/verification",
		enabled: true,
		runOnEveryTurn: false,
		checks: [
			{ id: "tsc-noEmit", kind: "typecheck", command: "tsc --noEmit", parser: "tsc" },
			{ id: "vitest-run", kind: "test", command: "vitest run", parser: "vitest" },
		],
		source: { kind: "default", reason: "test" },
		...overrides,
	};
}

function makeState(): TaskState {
	return addChange(createInitialTaskState("s"), { path: "src/a.ts", contentHash: "h1" });
}

const SNAPSHOT_A = "aaaa1111";
const SNAPSHOT_B = "bbbb2222";

describe("evaluateGate", () => {
	it("returns `satisfied` when the state has no requirements (open gate)", () => {
		const state = makeState();
		const result = evaluateGate(state, { policy: makePolicy(), snapshotHash: SNAPSHOT_A });
		expect(result.status).toBe("open");
	});

	it("returns `satisfied` when every blocking requirement has a matching passing verification", () => {
		let state = makeState();
		state = addRequirement(state, {
			text: "Typecheck passes",
			kind: "inferred",
			blocking: true,
			boundCheckId: "tsc-noEmit",
		});
		state = addVerification(state, {
			kind: "typecheck",
			command: "tsc --noEmit",
			passed: true,
			snapshotHash: SNAPSHOT_A,
		});

		const result = evaluateGate(state, { policy: makePolicy(), snapshotHash: SNAPSHOT_A });
		expect(result.status).toBe("satisfied");
		expect(result.passedChecks).toHaveLength(1);
	});

	it("returns `blocked` when a verification recorded for a required check failed", () => {
		let state = makeState();
		state = addRequirement(state, {
			text: "Typecheck passes",
			kind: "inferred",
			blocking: true,
			boundCheckId: "tsc-noEmit",
		});
		state = addVerification(state, {
			kind: "typecheck",
			command: "tsc --noEmit",
			passed: false,
			snapshotHash: SNAPSHOT_A,
		});

		const result = evaluateGate(state, { policy: makePolicy(), snapshotHash: SNAPSHOT_A });
		expect(result.status).toBe("blocked");
		expect(result.failedChecks).toHaveLength(1);
		expect(result.unmetRequirements[0]?.reason).toMatch(/failed/);
	});

	it("returns `blocked` when a required check has no verification at all", () => {
		let state = makeState();
		state = addRequirement(state, {
			text: "Typecheck passes",
			kind: "inferred",
			blocking: true,
			boundCheckId: "tsc-noEmit",
		});

		const result = evaluateGate(state, { policy: makePolicy(), snapshotHash: SNAPSHOT_A });
		expect(result.status).toBe("blocked");
		expect(result.unmetRequirements[0]?.reason).toMatch(/no verification/);
	});

	it("returns `unknown` when a passing verification is bound to a stale snapshot", () => {
		// Audit guarantee: a passing test from a previous state does
		// not certify the current state. Flipping the snapshot
		// hash must demote the prior passing verification to stale.
		let state = makeState();
		state = addRequirement(state, {
			text: "Typecheck passes",
			kind: "inferred",
			blocking: true,
			boundCheckId: "tsc-noEmit",
		});
		state = addVerification(state, {
			kind: "typecheck",
			command: "tsc --noEmit",
			passed: true,
			snapshotHash: SNAPSHOT_A,
		});

		const result = evaluateGate(state, { policy: makePolicy(), snapshotHash: SNAPSHOT_B });
		// The only matching evidence is stale, so the gate cannot
		// certify. It also cannot deny (no failing verification
		// exists at SNAPSHOT_B), so the verdict is `unknown`.
		expect(result.status).toBe("unknown");
	});

	it("returns `unknown` when a user-constraint has no bound check", () => {
		let state = makeState();
		state = addRequirement(state, {
			text: "User said: do X",
			kind: "user-constraint",
			blocking: true,
		});

		const result = evaluateGate(state, { policy: makePolicy(), snapshotHash: SNAPSHOT_A });
		expect(result.status).toBe("unknown");
		expect(result.unmetRequirements[0]?.reason).toMatch(/no check bound/);
	});

	it("returns `satisfied` when only advisory (non-blocking) requirements exist", () => {
		let state = makeState();
		state = addRequirement(state, {
			text: "Optional lint passes",
			kind: "inferred",
			blocking: false,
			boundCheckId: "vitest-run",
		});

		const result = evaluateGate(state, { policy: makePolicy(), snapshotHash: SNAPSHOT_A });
		expect(result.status).toBe("satisfied");
		expect(result.note).toMatch(/no blocking requirements/);
	});

	it("returns `satisfied` when verification.enabled is false", () => {
		const policy = makePolicy({ enabled: false });
		const state = makeState();
		const result = evaluateGate(state, { policy, snapshotHash: SNAPSHOT_A });
		expect(result.status).toBe("satisfied");
		expect(result.note).toMatch(/verification.enabled = false/);
	});

	it("snapshot-binding: changing the snapshot hash flips a passing verdict to unknown", () => {
		let state = makeState();
		state = addRequirement(state, {
			text: "Typecheck passes",
			kind: "inferred",
			blocking: true,
			boundCheckId: "tsc-noEmit",
		});
		state = addVerification(state, {
			kind: "typecheck",
			command: "tsc --noEmit",
			passed: true,
			snapshotHash: SNAPSHOT_A,
		});

		const beforeChange = evaluateGate(state, { policy: makePolicy(), snapshotHash: SNAPSHOT_A });
		expect(beforeChange.status).toBe("satisfied");

		// Simulate a file change: the same state, but the caller
		// now supplies the new snapshot hash.
		const afterChange = evaluateGate(state, { policy: makePolicy(), snapshotHash: SNAPSHOT_B });
		expect(afterChange.status).toBe("unknown");
	});

	it("aggregates multiple requirements and returns the strongest status", () => {
		let state = makeState();
		state = addRequirement(state, {
			text: "Typecheck passes",
			kind: "inferred",
			blocking: true,
			boundCheckId: "tsc-noEmit",
		});
		state = addRequirement(state, {
			text: "Test suite passes",
			kind: "inferred",
			blocking: true,
			boundCheckId: "vitest-run",
		});
		// Only one of the two has a passing verification.
		state = addVerification(state, {
			kind: "typecheck",
			command: "tsc --noEmit",
			passed: true,
			snapshotHash: SNAPSHOT_A,
		});

		const result = evaluateGate(state, { policy: makePolicy(), snapshotHash: SNAPSHOT_A });
		expect(result.status).toBe("blocked");
		expect(result.coverage).toBe("partial");
	});

	it("marks a verification as `falseSuccess` when the parser flagged it", () => {
		let state = makeState();
		state = addRequirement(state, {
			text: "Typecheck passes",
			kind: "inferred",
			blocking: true,
			boundCheckId: "tsc-noEmit",
		});
		state = addVerification(state, {
			kind: "typecheck",
			command: "tsc --noEmit",
			passed: true,
			falseSuccess: true,
			snapshotHash: SNAPSHOT_A,
		});

		const result = evaluateGate(state, { policy: makePolicy(), snapshotHash: SNAPSHOT_A });
		expect(result.status).toBe("blocked");
		expect(result.unmetRequirements[0]?.reason).toMatch(/suspect/);
	});

	it("flags a missing bound check as `unbound` rather than denying", () => {
		let state = makeState();
		state = addRequirement(state, {
			text: "Inferred from a ts file",
			kind: "inferred",
			blocking: true,
			boundCheckId: "tsc-noEmit",
		});

		// Remove the bound check from the policy.
		const policy = makePolicy({
			checks: [{ id: "vitest-run", kind: "test", command: "vitest run", parser: "vitest" }],
		});
		const result = evaluateGate(state, { policy, snapshotHash: SNAPSHOT_A });
		expect(result.status).toBe("unknown");
		expect(result.unmetRequirements[0]?.reason).toMatch(/not in the active policy/);
	});
});

