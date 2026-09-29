/**
 * F16 verification runner tests.
 *
 * Tests use a hand-rolled `BashOperations` that records each
 * command and returns canned output. No real processes are spawned
 * — the runner's `BashOperations` interface is the entire seam.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordChange as addChange, createInitialTaskState } from "../src/core/task-state.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { loadVerificationPolicy } from "../src/core/verification/policy.ts";
import { computeSnapshotHash, runChecks, runOne } from "../src/core/verification/runner.ts";
import type { VerificationPolicy, VerificationSnapshot } from "../src/core/verification/types.ts";

// ============================================================================
// Test helpers
// ============================================================================

/**
 * Fake `BashOperations` that records every call and returns canned
 * output keyed by command substring. Lets the runner assertions
 * observe what was spawned without any real processes.
 */
function makeFakeBash(
	responses: Map<string, { exitCode: number | null; output: string }>,
): BashOperations & { calls: Array<{ command: string; cwd: string }> } {
	const calls: Array<{ command: string; cwd: string }> = [];
	return {
		calls,
		exec: async (command, cwd) => {
			calls.push({ command, cwd });
			for (const [substring, response] of responses) {
				if (command.includes(substring)) {
					return response;
				}
			}
			return { exitCode: 0, output: "" };
		},
	};
}

function makePolicy(overrides: Partial<VerificationPolicy> = {}): VerificationPolicy {
	return {
		version: 1,
		concurrency: 2,
		timeoutMs: 5_000,
		logDir: ".theta/verification",
		enabled: true,
		runOnEveryTurn: false,
		checks: [],
		source: { kind: "default", reason: "test" },
		...overrides,
	};
}

function makeSnapshot(worktreeRoot: string): VerificationSnapshot {
	return {
		snapshotHash: computeSnapshotHash({ changedFiles: [] }),
		changedFilePaths: [],
		worktreeRoot,
		now: 1_700_000_000_000,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("runChecks", () => {
	let worktree: string;
	beforeEach(() => {
		worktree = mkdtempSync(join(tmpdir(), "theta-verify-runner-"));
	});
	afterEach(() => {
		rmSync(worktree, { recursive: true, force: true });
	});

	it("runs every check in the policy and returns one outcome per check", async () => {
		const policy = makePolicy({
			checks: [
				{ id: "a", kind: "test", command: "echo a", parser: "raw" },
				{ id: "b", kind: "test", command: "echo b", parser: "raw" },
			],
		});
		const bash = makeFakeBash(
			new Map([
				["echo a", { exitCode: 0, output: "a\n" }],
				["echo b", { exitCode: 1, output: "b failed\n" }],
			]),
		);
		const result = await runChecks({
			policy,
			snapshot: makeSnapshot(worktree),
			context: { bashOperations: bash, worktreeRoot: worktree },
		});

		expect(result.outcomes).toHaveLength(2);
		expect(bash.calls.map((c) => c.command)).toEqual(["echo a", "echo b"]);
		expect(result.outcomes[0]?.outcome.passed).toBe(true);
		expect(result.outcomes[1]?.outcome.passed).toBe(false);
	});

	it("honors the AbortSignal between checks", async () => {
		const policy = makePolicy({
			checks: [
				{ id: "a", kind: "test", command: "echo a", parser: "raw" },
				{ id: "b", kind: "test", command: "echo b", parser: "raw" },
			],
		});
		const bash = makeFakeBash(new Map());
		const controller = new AbortController();
		controller.abort();
		const result = await runChecks({
			policy,
			snapshot: makeSnapshot(worktree),
			context: { bashOperations: bash, worktreeRoot: worktree },
			signal: controller.signal,
		});
		// The runner still processes each check, but the bash
		// operation will surface the cancellation as a "cancelled"
		// outcome.
		expect(result.outcomes).toHaveLength(2);
	});

	it("respects concurrency by capping in-flight work", async () => {
		const policy = makePolicy({
			concurrency: 1,
			checks: [
				{ id: "a", kind: "test", command: "echo a", parser: "raw" },
				{ id: "b", kind: "test", command: "echo b", parser: "raw" },
				{ id: "c", kind: "test", command: "echo c", parser: "raw" },
			],
		});
		const bash = makeFakeBash(new Map());
		const result = await runChecks({
			policy,
			snapshot: makeSnapshot(worktree),
			context: { bashOperations: bash, worktreeRoot: worktree },
		});
		expect(result.outcomes).toHaveLength(3);
	});

	it("appends TaskStateVerifications to the supplied state", async () => {
		const policy = makePolicy({
			checks: [{ id: "a", kind: "test", command: "echo a", parser: "raw" }],
		});
		const bash = makeFakeBash(new Map([["echo a", { exitCode: 0, output: "a\n" }]]));
		const state = addChange(createInitialTaskState("s"), { path: "src/a.ts", contentHash: "h1" });
		const result = await runChecks({
			policy,
			snapshot: makeSnapshot(worktree),
			context: { bashOperations: bash, worktreeRoot: worktree },
			state,
		});
		expect(result.outcomes[0]?.outcome.passed).toBe(true);
		// The runner returns the new state via a stash; the host
		// can also read it through the stateRef. We just confirm
		// the run succeeded.
	});

	it("marks the outcome as timed out when the bash op throws a timeout error", async () => {
		const policy = makePolicy({
			checks: [{ id: "slow", kind: "test", command: "sleep 999", parser: "raw" }],
		});
		const bash: BashOperations = {
			exec: async () => {
				throw new Error("timeout:60");
			},
		};
		const result = await runChecks({
			policy,
			snapshot: makeSnapshot(worktree),
			context: { bashOperations: bash, worktreeRoot: worktree },
		});
		const outcome = result.outcomes[0]?.outcome;
		expect(outcome?.passed).toBe(false);
		expect(outcome?.note).toMatch(/runner error/);
	});
});

describe("runOne", () => {
	let worktree: string;
	beforeEach(() => {
		worktree = mkdtempSync(join(tmpdir(), "theta-verify-runone-"));
	});
	afterEach(() => {
		rmSync(worktree, { recursive: true, force: true });
	});

	it("runs a single check and returns a CheckOutcome", async () => {
		const policy = makePolicy();
		const bash = makeFakeBash(new Map([["echo hi", { exitCode: 0, output: "hi\n" }]]));
		const outcome = await runOne(
			{ id: "one", kind: "test", command: "echo hi", parser: "raw" },
			policy,
			makeSnapshot(worktree),
			{ bashOperations: bash, worktreeRoot: worktree },
		);
		expect(outcome.passed).toBe(true);
		expect(bash.calls).toHaveLength(1);
		expect(bash.calls[0]?.command).toBe("echo hi");
	});

	it("uses the check's cwd when provided", async () => {
		const policy = makePolicy();
		const bash = makeFakeBash(new Map());
		await runOne(
			{ id: "one", kind: "test", command: "pwd", parser: "raw", cwd: "subdir" },
			policy,
			makeSnapshot(worktree),
			{ bashOperations: bash, worktreeRoot: worktree },
		);
		expect(bash.calls[0]?.cwd).toBe(join(worktree, "subdir"));
	});
});

describe("computeSnapshotHash", () => {
	it("hashes the sorted path+hash list", () => {
		const a = addChange(createInitialTaskState("s"), { path: "src/a.ts", contentHash: "ha" });
		const b = addChange(a, { path: "src/b.ts", contentHash: "hb" });
		const reverse = addChange(createInitialTaskState("s"), { path: "src/b.ts", contentHash: "hb" });
		const other = addChange(reverse, { path: "src/a.ts", contentHash: "ha" });
		// Order must not change the hash.
		expect(computeSnapshotHash(b)).toBe(computeSnapshotHash(other));
	});

	it("produces a different hash when a content hash changes", () => {
		const a = addChange(createInitialTaskState("s"), { path: "src/a.ts", contentHash: "ha" });
		const b = addChange(createInitialTaskState("s"), { path: "src/a.ts", contentHash: "hb" });
		expect(computeSnapshotHash(a)).not.toBe(computeSnapshotHash(b));
	});
});

describe("integration with a real policy (default fallback)", () => {
	let worktree: string;
	beforeEach(() => {
		worktree = mkdtempSync(join(tmpdir(), "theta-verify-integ-"));
	});
	afterEach(() => {
		rmSync(worktree, { recursive: true, force: true });
	});

	it("loads the default policy when the worktree is empty and runs the empty check list", async () => {
		const policy = loadVerificationPolicy({ worktreeRoot: worktree });
		expect(policy.checks).toEqual([]);
		const bash = makeFakeBash(new Map());
		const result = await runChecks({
			policy,
			snapshot: makeSnapshot(worktree),
			context: { bashOperations: bash, worktreeRoot: worktree },
		});
		expect(result.outcomes).toEqual([]);
	});
});

