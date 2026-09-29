/**
 * The F16 completion gate.
 *
 * The gate is intentionally NOT a model. It is a deterministic
 * function over `TaskState` and `VerificationPolicy` that returns a
 * `GateResult`. The audit calls out four statuses:
 *
 *   - `satisfied`  — every blocking requirement has at least one
 *                    passing `TaskStateVerification` bound to the
 *                    current `snapshotHash`. A passing test from
 *                    before a code change does NOT certify the new
 *                    state, which is why the snapshot binding is
 *                    the gate's defining check.
 *   - `blocked`    — at least one blocking requirement has a recent
 *                    failing verification, OR a required check has
 *                    no verification at all (the audit calls this
 *                    "evidence gap" — the agent never ran the
 *                    check that would have produced the proof).
 *   - `unknown`    — coverage is too thin to decide. The audit
 *                    calls this out explicitly: the changed files
 *                    are not covered by any check the policy knows
 *                    about, so the gate cannot certify OR deny.
 *   - `open`       — the gate has not been evaluated yet (no
 *                    requirements attached to the state).
 *
 * The gate does not consult the model and does not call any tools.
 * It reads the `state.requirements` array produced by the
 * requirement extractor, walks the `state.verifications` array,
 * and decides.
 */

import type { GateResult, TaskState, TaskStateRequirement, TaskStateVerification } from "../task-state.ts";
import type { VerificationCheck, VerificationPolicy } from "./types.ts";

// ============================================================================
// Public surface
// ============================================================================

export interface EvaluateGateOptions {
	policy: VerificationPolicy;
	/** The current snapshot hash (matches `computeSnapshotHash`). */
	snapshotHash: string;
	/** Optional override for `Date.now()`. */
	now?: number;
}

/**
 * Evaluate the gate. Returns a `GateResult` describing the verdict
 * and the supporting evidence. Pure: no I/O, no model, no side
 * effects.
 */
export function evaluateGate(state: TaskState, options: EvaluateGateOptions): GateResult {
	const { policy, snapshotHash } = options;
	const now = options.now ?? Date.now();

	// Disabled short-circuit. Matches `loadVerificationPolicy` so the
	// gate is a no-op when the audit's master switch is off.
	if (!policy.enabled) {
		return {
			status: "satisfied",
			passedChecks: [],
			failedChecks: [],
			unmetRequirements: [],
			coverage: "complete",
			note: "verification.enabled = false",
		};
	}

	const requirements = state.requirements ?? [];
	if (requirements.length === 0) {
		return {
			status: "open",
			passedChecks: [],
			failedChecks: [],
			unmetRequirements: [],
			coverage: "unknown",
		};
	}

	const blocking = requirements.filter((r) => r.blocking);
	if (blocking.length === 0) {
		// Every requirement is advisory. By the audit's contract, a
		// gate with no blocking requirements is satisfied.
		return {
			status: "satisfied",
			passedChecks: [],
			failedChecks: [],
			unmetRequirements: [],
			coverage: "complete",
			note: "no blocking requirements",
		};
	}

	// Group verifications by check id (matched via `command` first,
	// then by `kind`). The runner is the canonical producer; the
	// after-tool-call hook on bash also lands here.
	const verificationsByCommand = groupByCommand(state.verifications);
	const verificationsByKind = groupByKind(state.verifications);

	const passedChecks: TaskStateVerification[] = [];
	const failedChecks: TaskStateVerification[] = [];
	const unmetRequirements: { requirement: string; reason: string }[] = [];
	let coveredRequirements = 0;
	let unboundBlockingRequirements = 0;
	let unknownFlagged = false;
	let hasFailed = false;
	let hasNoEvidence = false;

	for (const req of blocking) {
		const evaluation = evaluateRequirement(req, policy, snapshotHash, verificationsByCommand, verificationsByKind);
		switch (evaluation.kind) {
			case "satisfied":
				coveredRequirements++;
				for (const v of evaluation.passing) passedChecks.push(v);
				break;
			case "failed":
				coveredRequirements++;
				for (const v of evaluation.failing) failedChecks.push(v);
				unmetRequirements.push({
					requirement: req.text,
					reason: evaluation.reason,
				});
				hasFailed = true;
				break;
			case "no-evidence":
				// The check exists but no verification has been recorded.
				unmetRequirements.push({
					requirement: req.text,
					reason: evaluation.reason,
				});
				hasNoEvidence = true;
				break;
			case "unbound":
				unboundBlockingRequirements++;
				unmetRequirements.push({
					requirement: req.text,
					reason: evaluation.reason,
				});
				break;
		}
	}

	// Decide overall status. The audit is explicit:
	//   * any failed → blocked
	//   * any no-evidence (required check ran nothing) → blocked
	//   * any unbound (required check does not exist) → unknown
	//   * else → satisfied
	const hasUnbound = unboundBlockingRequirements > 0;

	if (hasFailed) {
		return {
			status: "blocked",
			passedChecks,
			failedChecks,
			unmetRequirements,
			coverage: coverageFor(coveredRequirements, blocking.length),
			note: "at least one check failed",
		};
	}
	if (hasNoEvidence) {
		return {
			status: "blocked",
			passedChecks,
			failedChecks,
			unmetRequirements,
			coverage: coverageFor(coveredRequirements, blocking.length),
			note: "at least one required check has no evidence",
		};
	}
	if (hasUnbound) {
		unknownFlagged = true;
	}

	// Conservative: if NO blocking requirement has any evidence at
	// all (no failed, no passed, no unbound), the gate has nothing
	// to certify — surface that as `unknown` rather than
	// `satisfied`. The audit's "evidence gap" clause.
	if (coveredRequirements === 0 && unboundBlockingRequirements === 0) {
		return {
			status: "unknown",
			passedChecks,
			failedChecks,
			unmetRequirements,
			coverage: "unknown",
			note: "no blocking requirement has matching evidence",
		};
	}

	if (unknownFlagged) {
		return {
			status: "unknown",
			passedChecks,
			failedChecks,
			unmetRequirements,
			coverage: coverageFor(coveredRequirements, blocking.length),
			note: "at least one blocking requirement is unbound",
		};
	}

	void now; // Reserved for future staleness thresholds.
	return {
		status: "satisfied",
		passedChecks,
		failedChecks,
		unmetRequirements: [],
		coverage: coverageFor(coveredRequirements, blocking.length),
	};
}

// ============================================================================
// Class wrapper
// ============================================================================

/**
 * Object-oriented wrapper around `evaluateGate`. Use the static
 * form when you do not need a long-lived instance; this class is
 * here for symmetry with the audit's "CompletionGate" naming.
 */
export const CompletionGate = {
	evaluate: evaluateGate,
} as const;

// ============================================================================
// Internal helpers
// ============================================================================

type RequirementEvaluation =
	| { kind: "satisfied"; passing: TaskStateVerification[] }
	| { kind: "failed"; failing: TaskStateVerification[]; reason: string }
	| { kind: "no-evidence"; reason: string }
	| { kind: "unbound"; reason: string };

function evaluateRequirement(
	requirement: TaskStateRequirement,
	policy: VerificationPolicy,
	snapshotHash: string,
	byCommand: Map<string, TaskStateVerification[]>,
	byKind: Map<TaskStateVerification["kind"], TaskStateVerification[]>,
): RequirementEvaluation {
	// First, the direct path: requirement is bound to a specific check.
	if (requirement.boundCheckId) {
		const check = policy.checks.find((c) => c.id === requirement.boundCheckId);
		if (!check) {
			return {
				kind: "unbound",
				reason: `bound check "${requirement.boundCheckId}" is not in the active policy`,
			};
		}
		return evaluateAgainstCheck(check, snapshotHash, byCommand, byKind);
	}

	// Second, infer a check from the requirement's `kind` field.
	// `inferred` requirements already carry their bound check; the
	// path below only fires for `user-constraint` and
	// `objective-derived` requirements without a binding. The gate
	// is honest: those cannot be auto-bound to a check, so the
	// verdict is `unbound` with a clear reason.
	if (requirement.kind === "user-constraint" || requirement.kind === "objective-derived") {
		return {
			kind: "unbound",
			reason: `no check bound to ${requirement.kind} requirement; configure a policy check that covers "${requirement.text}"`,
		};
	}

	// Inferred but no bound check id (e.g. file-inferred requirement
	// for a file with no matching check in the policy).
	return {
		kind: "unbound",
		reason: "inferred requirement has no matching check in the active policy",
	};
}

function evaluateAgainstCheck(
	check: VerificationCheck,
	snapshotHash: string,
	byCommand: Map<string, TaskStateVerification[]>,
	byKind: Map<TaskStateVerification["kind"], TaskStateVerification[]>,
): RequirementEvaluation {
	// Prefer matching by command (the runner writes `check.command`
	// onto each verification). Fall back to matching by kind.
	const direct = byCommand.get(check.command) ?? [];
	const candidates = direct.length > 0 ? direct : (byKind.get(check.kind) ?? []);

	// Filter to "current" — same `snapshotHash`. A passing test from
	// before a code change is stale, by the audit's binding rule.
	const current = candidates.filter((v) => v.snapshotHash === snapshotHash);
	if (current.length === 0) {
		// No fresh evidence. The audit distinguishes "stale only"
		// (we have prior evidence, just not for the current state —
		// the gate cannot certify AND cannot deny) from "no
		// evidence at all" (the check has never run for this
		// session — the agent never produced the proof).
		if (candidates.length > 0) {
			return {
				kind: "unbound",
				reason: `no verification for check "${check.id}" is bound to snapshot ${shortHash(snapshotHash)}; only stale evidence exists`,
			};
		}
		return {
			kind: "no-evidence",
			reason: `no verification recorded for check "${check.id}"; run the check to produce evidence`,
		};
	}

	// Among current, did any pass (and are not flagged suspect)?
	const passing = current.filter((v) => v.passed && !v.falseSuccess);
	if (passing.length > 0) {
		return { kind: "satisfied", passing };
	}

	// All current are failures or suspect. Surface them.
	const failing = current.filter((v) => !v.passed);
	if (failing.length > 0) {
		const last = failing[failing.length - 1]!;
		return {
			kind: "failed",
			failing,
			reason: `check "${check.id}" failed: ${last.falseSuccess ? "false success suspected" : "exit non-zero"}`,
		};
	}

	// `current` was all `falseSuccess`. The audit calls this
	// "looks like a pass but the parser flagged it as suspect."
	return {
		kind: "failed",
		failing: current,
		reason: `check "${check.id}" only produced suspect-pass verifications`,
	};
}

function groupByCommand(verifications: TaskStateVerification[]): Map<string, TaskStateVerification[]> {
	const out = new Map<string, TaskStateVerification[]>();
	for (const v of verifications) {
		const key = v.command ?? "";
		if (!key) continue;
		const list = out.get(key);
		if (list) list.push(v);
		else out.set(key, [v]);
	}
	return out;
}

function groupByKind(
	verifications: TaskStateVerification[],
): Map<TaskStateVerification["kind"], TaskStateVerification[]> {
	const out = new Map<TaskStateVerification["kind"], TaskStateVerification[]>();
	for (const v of verifications) {
		const list = out.get(v.kind);
		if (list) list.push(v);
		else out.set(v.kind, [v]);
	}
	return out;
}

function coverageFor(covered: number, total: number): "complete" | "partial" | "unknown" {
	if (covered >= total) return "complete";
	if (covered > 0) return "partial";
	return "unknown";
}

function shortHash(hash: string): string {
	return hash.slice(0, 8);
}

