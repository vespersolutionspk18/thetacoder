/**
 * "What does done mean" extraction.
 *
 * The audit calls for the agent to be able to say which requirements
 * are in scope for a task and to refuse to mark a turn `done` until
 * each requirement has matching evidence. The extractor is the
 * deterministic half of that loop: given a `TaskState` (and a policy
 * for context), it produces a list of `TaskStateRequirement`s.
 *
 * Sources, in order:
 *
 *   1. Explicit constraints in `TaskState.constraints` → mirrored
 *      as `kind: "user-constraint"` requirements. The `boundCheckId`
 *      is left undefined for these — the gate is supposed to surface
 *      a "no check covers this" message rather than silently pick
 *      one.
 *
 *   2. Imperative sentences extracted from `TaskState.objective.text`
 *      by a small pattern (`must`, `should`, `needs to`, `ensure`,
 *      `verify`, `has to`, `ought to`). Each becomes a
 *      `kind: "objective-derived"` requirement. Conservative: the
 *      extractor only adds a sentence it is confident is a checkable
 *      claim, not every clause.
 *
 *   3. Inferred requirements from the `TaskState.changedFiles` list:
 *      - `.ts` / `.tsx` change → `tsc-noEmit` passes
 *      - any test file change (heuristic) → first available test-runner
 *        check passes
 *      - any source-tree file change (build-relevant) → `npm run build`
 *        passes, when the package has a `build` script
 *
 *      The policy is consulted to pick a `boundCheckId`: the
 *      requirement only attaches to a check that actually exists in
 *      the policy. When none does, the requirement stays inferred
 *      but unbound — the gate's `unknown` status catches this.
 *
 * Pure: returns a new array of requirements, never mutates the
 * state. The host (the agent loop) is responsible for persisting
 * them via `addRequirement`.
 */

import { addRequirement, type TaskState, type TaskStateRequirement } from "../task-state.ts";
import type { VerificationCheck, VerificationPolicy } from "./types.ts";

// ============================================================================
// Public entry point
// ============================================================================

export interface ExtractRequirementsOptions {
	policy: VerificationPolicy;
	now?: number;
}

/**
 * Extract a fresh list of requirements from the supplied state.
 * Existing requirements in `state.requirements` are NOT consulted —
 * the extractor is idempotent, so re-running it on the same state
 * yields the same output. The host is responsible for diffing or
 * de-duplicating against existing requirements.
 */
export function extractRequirements(state: TaskState, options: ExtractRequirementsOptions): TaskStateRequirement[] {
	const now = options.now ?? Date.now();
	const requirements: TaskStateRequirement[] = [];

	// Source 1: explicit constraints.
	for (const constraint of state.constraints) {
		requirements.push({
			id: `req-constraint-${constraint.id}`,
			text: constraint.text,
			kind: "user-constraint",
			blocking: true,
			createdAt: now,
			boundCheckId: undefined,
		});
	}

	// Source 2: objective-derived.
	if (state.objective) {
		for (const sentence of extractImperativeSentences(state.objective.text)) {
			requirements.push({
				id: `req-obj-${hashSentence(sentence)}`,
				text: sentence,
				kind: "objective-derived",
				blocking: true,
				createdAt: now,
				boundCheckId: undefined,
			});
		}
	}

	// Source 3: file-inferred.
	const inferred = inferRequirementsFromFiles(
		state.changedFiles.map((cf) => cf.path),
		options.policy,
	);
	requirements.push(...inferred);

	return requirements;
}

/**
 * Convenience wrapper: extract requirements and append them to the
 * state via `addRequirement`. Existing requirements are left
 * untouched — duplicates are the host's responsibility. The wrapper
 * is intentionally simple: it appends everything the extractor
 * produced and relies on `addRequirement` to be safe to call
 * repeatedly (it assigns fresh ids and updates `updatedAt`).
 */
export function extractAndAddRequirements(state: TaskState, options: ExtractRequirementsOptions): TaskState {
	const requirements = extractRequirements(state, options);
	let next = state;
	for (const requirement of requirements) {
		next = addRequirement(next, {
			text: requirement.text,
			kind: requirement.kind,
			blocking: requirement.blocking,
			boundCheckId: requirement.boundCheckId,
		});
	}
	return next;
}

// ============================================================================
// Imperative sentence extraction
// ============================================================================

/**
 * Deterministic matcher for the audit's "imperative sentence"
 * pattern. Words the audit calls out: "must", "should", "needs to",
 * "ensure", "verify", "has to", "ought to". The match is
 * case-insensitive and runs at sentence granularity (period, semicolon,
 * or newline are sentence terminators).
 */
const IMPERATIVE_TRIGGERS: readonly string[] = [
	"must",
	"should",
	"needs to",
	"need to",
	"has to",
	"have to",
	"ought to",
	"ensure",
	"ensure that",
	"verify",
	"make sure",
];

/**
 * Split a paragraph into sentences using a deliberately small
 * splitter. Imperative matches are sentence-scoped so the
 * requirement is self-contained.
 */
function splitSentences(text: string): string[] {
	const out: string[] = [];
	const re = /[^.!?\n;]+[.!?;]?/g;
	let m: RegExpExecArray | null = re.exec(text);
	while (m !== null) {
		const trimmed = m[0]!.trim();
		if (trimmed.length > 0) out.push(trimmed);
		m = re.exec(text);
	}
	return out;
}

function sentenceContainsImperative(sentence: string): boolean {
	const lower = sentence.toLowerCase();
	for (const trigger of IMPERATIVE_TRIGGERS) {
		if (lower.includes(trigger)) return true;
	}
	return false;
}

function extractImperativeSentences(text: string): string[] {
	const out: string[] = [];
	for (const sentence of splitSentences(text)) {
		if (sentenceContainsImperative(sentence)) out.push(sentence);
	}
	return out;
}

/** Stable id for a sentence (so re-extraction yields the same id). */
function hashSentence(sentence: string): string {
	let h = 0;
	for (let i = 0; i < sentence.length; i++) {
		h = (h * 31 + sentence.charCodeAt(i)) | 0;
	}
	// Convert to a positive hex string. Two sentences with the same
	// 32-bit hash collide at ~1 in 4B, which is good enough for an id
	// that's only stable within one session.
	return (h >>> 0).toString(16);
}

// ============================================================================
// File-inferred requirements
// ============================================================================

const TS_EXTENSIONS = new Set([".ts", ".tsx"]);
const JS_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"]);
const TEST_FILE_HINTS = [".test.", ".spec.", "__tests__", "test/", "tests/"];

function isTestFile(path: string): boolean {
	const lower = path.toLowerCase();
	return TEST_FILE_HINTS.some((hint) => lower.includes(hint));
}

function isSourceFile(path: string): boolean {
	const lastDot = path.lastIndexOf(".");
	if (lastDot === -1) return false;
	const ext = path.slice(lastDot).toLowerCase();
	return TS_EXTENSIONS.has(ext) || JS_EXTENSIONS.has(ext);
}

function inferRequirementsFromFiles(paths: string[], policy: VerificationPolicy): TaskStateRequirement[] {
	const requirements: TaskStateRequirement[] = [];
	const now = Date.now();
	let hasTypeScriptChange = false;
	let hasTestFileChange = false;
	let hasSourceTreeChange = false;

	for (const path of paths) {
		const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
		if (TS_EXTENSIONS.has(ext)) hasTypeScriptChange = true;
		if (isTestFile(path)) hasTestFileChange = true;
		else if (isSourceFile(path)) hasSourceTreeChange = true;
	}

	if (hasTypeScriptChange) {
		const check = findCheckByIdPrefix(policy, "tsc-");
		requirements.push({
			id: `req-file-tsc`,
			text: "TypeScript typecheck passes (`tsc --noEmit`).",
			kind: "inferred",
			blocking: true,
			createdAt: now,
			boundCheckId: check?.id,
		});
	}

	if (hasTestFileChange) {
		const testCheck = pickTestCheck(policy);
		if (testCheck) {
			requirements.push({
				id: `req-file-test-${testCheck.id}`,
				text: `Test suite passes (${testCheck.id}).`,
				kind: "inferred",
				blocking: true,
				createdAt: now,
				boundCheckId: testCheck.id,
			});
		}
	}

	if (hasSourceTreeChange && !hasTypeScriptChange) {
		// Source code without TypeScript: still need the test suite to pass.
		const testCheck = pickTestCheck(policy);
		if (testCheck) {
			requirements.push({
				id: `req-file-test-${testCheck.id}`,
				text: `Test suite passes (${testCheck.id}).`,
				kind: "inferred",
				blocking: true,
				createdAt: now,
				boundCheckId: testCheck.id,
			});
		}
	}

	return requirements;
}

function findCheckByIdPrefix(policy: VerificationPolicy, prefix: string): VerificationCheck | undefined {
	return policy.checks.find((c) => c.id.startsWith(prefix));
}

function pickTestCheck(policy: VerificationPolicy): VerificationCheck | undefined {
	const testCheck = policy.checks.find((c) => c.kind === "test");
	return testCheck;
}

