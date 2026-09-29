/**
 * TaskState — durable, audit-friendly state for the agent task.
 *
 * This is the F2 minimum-viable layer: the data types, JSONL persistence
 * via the existing SessionManager, and pure functions to query/mutate the
 * state. No context compiler integration. No agent-loop hook.
 *
 * The shape mirrors the "Context Architecture" ownership table from the
 * hyper-efficiency audit: objective, constraints, decisions, hypotheses,
 * changed files, verifications, and evidence. The "active context"
 * projection is intentionally out of scope here.
 */

import { randomUUID } from "crypto";
import type { SessionEntry } from "./session-manager.ts";

// =========================================================================
// Element types
// =========================================================================

/** The task's objective — the durable statement of what is being accomplished. */
export interface TaskStateObjective {
	text: string;
	/** Stable id of the user message that introduced the objective, if known. */
	sourceRequestId?: string;
	createdAt: number;
}

/** A constraint the agent must respect while working. */
export interface TaskStateConstraint {
	id: string;
	text: string;
	source: "user" | "model" | "extension";
	createdAt: number;
	evidenceRefs?: string[];
}

/** A decision the model has made. Can be superseded by a later decision. */
export interface TaskStateDecision {
	id: string;
	text: string;
	rationale?: string;
	madeAt: number;
	/** id of the decision that supersedes this one, if any. */
	supersededBy?: string;
	evidenceRefs?: string[];
}

/** A testable claim the model is operating under. */
export interface TaskStateHypothesis {
	id: string;
	text: string;
	status: "open" | "confirmed" | "refuted";
	madeAt: number;
	resolvedAt?: number;
	evidenceRefs?: string[];
}

/** A file that has been modified, with the content hash that was observed. */
export interface TaskStateChangedFile {
	path: string;
	contentHash: string;
	changedAt: number;
	/** Tool call that produced the change, if known. */
	toolCallId?: string;
}

/** The result of a verification run (test, lint, etc.) against a known snapshot. */
export interface TaskStateVerification {
	id: string;
	kind: "test" | "lint" | "typecheck" | "snapshot" | "manual" | "user-accepted";
	command?: string;
	passed: boolean;
	observedAt: number;
	/** Hash of the source/config/environment at observation time, for bound verifications. */
	snapshotHash?: string;
	/** True if this verification appeared to pass but is suspected to be a false success. */
	falseSuccess?: boolean;
}

/** Immutable evidence captured during the task. */
export interface TaskStateEvidence {
	id: string;
	kind: "source" | "log" | "diff" | "external";
	/** Content hash of the evidence (e.g. sha256). */
	hash: string;
	byteLength: number;
	capturedAt: number;
	/** Where this evidence came from (path, URL, tool name, etc.). */
	provenance?: string;
}

/**
 * A "what does done mean" record produced by the requirement extractor.
 *
 * The audit calls for a deterministic binding between "the user said X"
 * and "the system verified X". A `Requirement` is the named half of
 * that binding: the text the requirement claims plus a `kind` that
 * downstream code (the gate, the policy) uses to map it onto a
 * concrete check.
 *
 * - `kind: "user-constraint"` — a constraint explicitly added to
 *   `TaskState.constraints` (mirror, not a copy).
 * - `kind: "objective-derived"` — extracted from the objective text
 *   by the deterministic sentence patterns ("must", "should", …).
 * - `kind: "inferred"` — added because a changed file matches a
 *   known profile (e.g. `.ts` ⇒ `tsc --noEmit`).
 *
 * `blocking: true` means the gate refuses to mark the turn complete
 * until evidence satisfies this requirement. The policy can downgrade
 * a blocking requirement to advisory by reading `requirement.blocking`
 * before evaluation.
 */
export interface TaskStateRequirement {
	id: string;
	text: string;
	kind: "user-constraint" | "objective-derived" | "inferred";
	blocking: boolean;
	createdAt: number;
	/** Check id (e.g. `tsc-noEmit`, `vitest-run`) this requirement maps onto. */
	boundCheckId?: string;
}

/** The deterministic verdict the `CompletionGate` returns. */
export interface GateResult {
	/**
	 * - `open`        — the gate has not been evaluated yet (no
	 *                   requirements attached to the state).
	 * - `satisfied`   — every blocking requirement has at least one
	 *                   passing `TaskStateVerification` bound to the
	 *                   current `snapshotHash`.
	 * - `blocked`     — at least one blocking requirement has a recent
	 *                   failing verification, OR a required check has
	 *                   no verification at all.
	 * - `unknown`     — coverage is too thin to decide (e.g. changed
	 *                   files are not covered by any check the policy
	 *                   knows about).
	 */
	status: "open" | "satisfied" | "blocked" | "unknown";
	passedChecks: TaskStateVerification[];
	failedChecks: TaskStateVerification[];
	unmetRequirements: { requirement: string; reason: string }[];
	coverage: "complete" | "partial" | "unknown";
	note?: string;
}

// =========================================================================
// Aggregate
// =========================================================================

export interface TaskState {
	/** Stable per session. */
	id: string;
	objective?: TaskStateObjective;
	constraints: TaskStateConstraint[];
	decisions: TaskStateDecision[];
	hypotheses: TaskStateHypothesis[];
	changedFiles: TaskStateChangedFile[];
	verifications: TaskStateVerification[];
	evidence: TaskStateEvidence[];
	/**
	 * Extracted "what does done mean" records. Optional for
	 * backwards compatibility with older persisted sessions; the
	 * requirement extractor populates this when the gate first runs.
	 */
	requirements?: TaskStateRequirement[];
	/**
	 * Recent gate verdicts, capped at 10 most recent. Append-only
	 * from the gate's perspective; old entries drop off the front.
	 */
	gateHistory?: GateResult[];
	createdAt: number;
	updatedAt: number;
}

// =========================================================================
// Construction
// =========================================================================

/** Build an empty TaskState. All collections start empty. */
export function createInitialTaskState(id: string): TaskState {
	const now = Date.now();
	return {
		id,
		constraints: [],
		decisions: [],
		hypotheses: [],
		changedFiles: [],
		verifications: [],
		evidence: [],
		createdAt: now,
		updatedAt: now,
	};
}

// =========================================================================
// Internal helpers
// =========================================================================

/** Produce a new ID. Random UUIDs are globally unique, so no collision
 *  check against `state` is needed. */
function newId(_state: TaskState): string {
	return randomUUID();
}

/** Shallow-clone the state with `updatedAt` bumped to now. */
function withUpdatedAt(state: TaskState): TaskState {
	return { ...state, updatedAt: Date.now() };
}

// =========================================================================
// Mutations (pure: always return a new state, never mutate input)
// =========================================================================

/** Set the objective. Replaces any prior objective. */
export function setObjective(state: TaskState, objective: TaskStateObjective): TaskState {
	return withUpdatedAt({ ...state, objective });
}

export function addConstraint(state: TaskState, constraint: Omit<TaskStateConstraint, "id" | "createdAt">): TaskState {
	const entry: TaskStateConstraint = {
		...constraint,
		id: newId(state),
		createdAt: Date.now(),
	};
	return withUpdatedAt({ ...state, constraints: [...state.constraints, entry] });
}

export function recordDecision(state: TaskState, decision: Omit<TaskStateDecision, "id" | "madeAt">): TaskState {
	const entry: TaskStateDecision = {
		...decision,
		id: newId(state),
		madeAt: Date.now(),
	};
	return withUpdatedAt({ ...state, decisions: [...state.decisions, entry] });
}

export function markHypothesisResolved(state: TaskState, id: string, status: "confirmed" | "refuted"): TaskState {
	const hypotheses = state.hypotheses.map((h) =>
		h.id === id && h.status === "open" ? { ...h, status, resolvedAt: Date.now() } : h,
	);
	return withUpdatedAt({ ...state, hypotheses });
}

export function recordVerification(
	state: TaskState,
	verification: Omit<TaskStateVerification, "id" | "observedAt">,
): TaskState {
	const entry: TaskStateVerification = {
		...verification,
		id: newId(state),
		observedAt: Date.now(),
	};
	return withUpdatedAt({ ...state, verifications: [...state.verifications, entry] });
}

export function recordChange(state: TaskState, file: Omit<TaskStateChangedFile, "changedAt">): TaskState {
	const entry: TaskStateChangedFile = {
		...file,
		changedAt: Date.now(),
	};
	return withUpdatedAt({ ...state, changedFiles: [...state.changedFiles, entry] });
}

export function recordEvidence(state: TaskState, evidence: Omit<TaskStateEvidence, "id" | "capturedAt">): TaskState {
	const entry: TaskStateEvidence = {
		...evidence,
		id: newId(state),
		capturedAt: Date.now(),
	};
	return withUpdatedAt({ ...state, evidence: [...state.evidence, entry] });
}

/**
 * Append a single `Requirement` to the state's `requirements` array.
 * Returns the new state with `updatedAt` bumped. When `state.requirements`
 * is `undefined` (older persisted shape), the array is initialized as a
 * side effect of this call — the requirement list is created lazily so
 * pre-F16 sessions continue to deserialize cleanly.
 */
export function addRequirement(
	state: TaskState,
	requirement: Omit<TaskStateRequirement, "id" | "createdAt">,
): TaskState {
	const existing = state.requirements ?? [];
	const entry: TaskStateRequirement = {
		...requirement,
		id: newId(state),
		createdAt: Date.now(),
	};
	return withUpdatedAt({ ...state, requirements: [...existing, entry] });
}

/** Hard cap on the `gateHistory` length. The audit keeps the most
 *  recent N so the persisted state stays bounded even in long sessions. */
export const GATE_HISTORY_MAX = 10;

/**
 * Append a `GateResult` to `state.gateHistory`, dropping the oldest
 * entries past `GATE_HISTORY_MAX`. Initializes the array if absent.
 * Pure: returns a new state object, never mutates the input.
 */
export function addGateResult(state: TaskState, result: GateResult): TaskState {
	const existing = state.gateHistory ?? [];
	let next: GateResult[];
	if (existing.length >= GATE_HISTORY_MAX) {
		const dropCount = existing.length - GATE_HISTORY_MAX + 1;
		next = [...existing.slice(dropCount), result];
	} else {
		next = [...existing, result];
	}
	return withUpdatedAt({ ...state, gateHistory: next });
}

// =========================================================================
// Queries
// =========================================================================

/** Constraints that have not been superseded. (The constraint type has no
 *  supersededBy field today; this is a placeholder for forward-compat and
 *  filters out anything explicitly marked. Currently it returns all.) */
export function getActiveConstraints(state: TaskState): TaskStateConstraint[] {
	return state.constraints.filter((c) => {
		// No supersededBy field on TaskStateConstraint today; reserved for the
		// future. Keep the function honest about its current contract.
		const maybeSuperseded = (c as TaskStateConstraint & { supersededBy?: string }).supersededBy;
		return maybeSuperseded === undefined;
	});
}

/** Hypotheses still open (not confirmed or refuted). */
export function getOpenHypotheses(state: TaskState): TaskStateHypothesis[] {
	return state.hypotheses.filter((h) => h.status === "open");
}

/** Verifications that did not pass. Excludes known false-successes only if
 *  the caller wants to surface them — for the audit table, we surface every
 *  non-passing row. */
export function getFailedVerifications(state: TaskState): TaskStateVerification[] {
	return state.verifications.filter((v) => !v.passed);
}

// =========================================================================
// Persistence read
// =========================================================================

/** Walk a branch (typically SessionManager.getBranch()) from the tip and
 *  return the most recent TaskState, if any. */
export function getLatestTaskState(branch: SessionEntry[]): TaskState | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "task_state") {
			return entry.taskState;
		}
	}
	return undefined;
}

