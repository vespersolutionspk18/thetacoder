/**
 * F2 evidence freshness check.
 *
 * The audit's Caching Architecture (Section 17) calls for binding
 * diagnostics and test results to their complete relevant input
 * fingerprints, and the target architecture (Section 20, item 3 of
 * the 10 context compiler responsibilities) calls for evidence
 * freshness checks.
 *
 * This module is the minimum-viable surface for that responsibility:
 *
 *   - `checkEvidenceFreshness` walks every `TaskStateChangedFile`
 *     and compares its recorded `contentHash` against the latest
 *     known hash supplied by the caller. Files whose recorded hash
 *     matches the latest hash are `fresh`; files whose recorded hash
 *     disagrees with the latest hash are `stale`; files that the
 *     caller has no information about are `missing`.
 *
 *   - `annotateStaleness` attaches the resulting `FreshnessReport`
 *     to a `CompiledContext` and, when the report has at least one
 *     `stale` or `missing` row, prepends a non-displayed `custom`
 *     message (`customType: "freshness-warning"`) that surfaces the
 *     affected paths in the projection. The audit's stable/volatile
 *     split keeps this custom message on the stable side (it is
 *     prepended before the existing TaskState-injected messages are
 *     encountered by the model).
 *
 * The module is a pure function module. It does not read the
 * filesystem and does not compute hashes itself; the caller supplies
 * the latest known hashes. This keeps the function trivially
 * testable and lets the host (the agent loop, an extension, a
 * pre-flight check) decide how to populate the map.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { CompiledContext } from "./context-compiler.ts";
import type { CustomMessage as CodingAgentCustomMessage } from "./messages.ts";
import type { TaskState } from "./task-state.ts";

// =========================================================================
// Public types
// =========================================================================

/**
 * Per-file freshness verdict.
 *
 * - `fresh`   — the latest known hash for the path matches the hash
 *               recorded in `TaskState.changedFiles`.
 * - `stale`   — the latest known hash for the path does NOT match the
 *               hash recorded in `TaskState.changedFiles`. Any
 *               downstream evidence bound to the recorded hash is no
 *               longer trustworthy; re-read.
 * - `missing` — the caller supplied no information about this path
 *               (the path is absent from `latestHashes`). The
 *               recorded hash is preserved but cannot be verified
 *               against current state.
 * - `unknown` — defensive fallback. Not produced by the current
 *               algorithm; reserved for future expansion (e.g. when
 *               the latest evidence carries a different `kind` and
 *               cannot be compared directly).
 */
export type FreshnessStatus = "fresh" | "stale" | "missing" | "unknown";

/** A single freshness verdict for one path recorded in TaskState. */
export interface FreshnessCheck {
	/** Path recorded in `TaskState.changedFiles`. */
	path: string;
	/** Hash recorded in `TaskState.changedFiles[].contentHash`. */
	expectedHash: string;
	/**
	 * Hash from the latest known evidence (e.g. a fresh read result).
	 * Empty string when the path is not present in `latestHashes`.
	 */
	actualHash: string;
	/** Timestamp from `TaskState.changedFiles[].changedAt`. */
	capturedAt: number;
	/** Timestamp at which the check ran. Defaults to `Date.now()`. */
	checkedAt: number;
	/** `checkedAt - capturedAt`, clamped to 0. */
	ageMs: number;
	status: FreshnessStatus;
}

/** Aggregate of all per-file verdicts for one `checkEvidenceFreshness` call. */
export interface FreshnessReport {
	checks: FreshnessCheck[];
	freshCount: number;
	staleCount: number;
	missingCount: number;
	unknownCount: number;
}

/** Options for `checkEvidenceFreshness`. */
export interface CheckEvidenceFreshnessOptions {
	/**
	 * The current TaskState. When `undefined`, the function returns
	 * an empty report (nothing to check).
	 */
	taskState: TaskState | undefined;
	/**
	 * Map from path to the latest known content hash. A path absent
	 * from this map is treated as `missing`.
	 */
	latestHashes: Map<string, string>;
	/** Override for the current time. Defaults to `Date.now()`. */
	now?: number;
}

// =========================================================================
// =========================================================================
// Internal helpers
// =========================================================================

/**
 * Decide the freshness verdict for one path. Extracted as a function so
 * the returned type widens to the full `FreshnessStatus` union (an
 * inline `let` with if/else assigns would be narrowed to the literal
 * union by TypeScript's control-flow analysis, and the `"unknown"` arm
 * in the downstream switch would then be flagged as unreachable).
 */
function computeStatus(latest: string | undefined, expectedHash: string): FreshnessStatus {
	if (latest === undefined) return "missing";
	if (latest === expectedHash) return "fresh";
	return "stale";
}

/** The hash to record on the `FreshnessCheck`; empty when the path is missing. */
function computeActualHash(latest: string | undefined): string {
	return latest ?? "";
}

// =========================================================================
// Public entry point
// =========================================================================

/**
 * Walk `taskState.changedFiles` and compare each entry's recorded
 * `contentHash` against `latestHashes`.
 *
 * Algorithm:
 *  1. If `taskState` is undefined, return an empty report.
 *  2. For each `changedFile` in `taskState.changedFiles`:
 *     - If `latestHashes` has an entry for the path and the entry
 *       matches `changedFile.contentHash` → `status: "fresh"`.
 *     - Else if `latestHashes` has an entry for the path but the
 *       entry does not match → `status: "stale"`.
 *     - Else (the path is absent from `latestHashes`) → `status:
 *       "missing"`.
 *  3. Aggregate counts across all checks and return.
 */
export function checkEvidenceFreshness(options: CheckEvidenceFreshnessOptions): FreshnessReport {
	const { taskState, latestHashes, now } = options;
	if (taskState === undefined) {
		return {
			checks: [],
			freshCount: 0,
			staleCount: 0,
			missingCount: 0,
			unknownCount: 0,
		};
	}

	const checkedAt = now ?? Date.now();
	const checks: FreshnessCheck[] = [];
	let freshCount = 0;
	let staleCount = 0;
	let missingCount = 0;
	let unknownCount = 0;

	for (const changedFile of taskState.changedFiles) {
		const expectedHash = changedFile.contentHash;
		const capturedAt = changedFile.changedAt;
		const ageMs = Math.max(0, checkedAt - capturedAt);
		const latest = latestHashes.get(changedFile.path);

		const status: FreshnessStatus = computeStatus(latest, expectedHash);
		const actualHash = computeActualHash(latest);

		checks.push({
			path: changedFile.path,
			expectedHash,
			actualHash,
			capturedAt,
			checkedAt,
			ageMs,
			status,
		});

		switch (status) {
			case "fresh":
				freshCount++;
				break;
			case "stale":
				staleCount++;
				break;
			case "missing":
				missingCount++;
				break;
			case "unknown":
				unknownCount++;
				break;
		}
	}

	return {
		checks,
		freshCount,
		staleCount,
		missingCount,
		unknownCount,
	};
}

// =========================================================================
// Annotation helper
// =========================================================================

/**
 * Build the `customType: "freshness-warning"` custom message that
 * `annotateStaleness` prepends when there is at least one stale or
 * missing file. Exported for tests and for future extension hooks.
 */
export function buildFreshnessWarningMessage(report: FreshnessReport, now: number): CodingAgentCustomMessage {
	const affectedPaths = report.checks
		.filter((c) => c.status === "stale" || c.status === "missing")
		.map((c) => {
			const tag = c.status === "stale" ? "stale" : "missing";
			return `${c.path} (${tag})`;
		});

	const body =
		`[FRESHNESS] ${report.staleCount} stale, ${report.missingCount} missing.` +
		` Affected paths: ${affectedPaths.join(", ")}`;

	return {
		role: "custom",
		customType: "freshness-warning",
		content: body,
		display: false,
		details: { report },
		timestamp: now,
	};
}

// =========================================================================
// Read-tool result capture
// =========================================================================

/**
 * Input to `captureReadResultForFreshness`. The host (the agent loop's
 * `afterToolCall` hook in `agent-session.ts`) supplies the executed
 * tool's name, the validated `args`, the executed `result`, and the
 * `isError` flag from the agent core. The helper is structurally
 * decoupled from the agent-core types so it can be unit-tested with
 * plain literals and reused by other code paths that observe a
 * completed tool call.
 */
export interface CaptureReadResultOptions {
	/** The tool name from the executed tool call (e.g. `"read"`). */
	toolName: string;
	/** Validated tool arguments. The helper only inspects `args.path`. */
	args: unknown;
	/** The executed tool result. Only `details.contentIdentity` is used. */
	result: { details?: { contentIdentity?: string } | undefined };
	/** `true` when the tool result is treated as an error. */
	isError: boolean;
}

/**
 * Capture a single read tool result into the `latestHashes` map that
 * `checkEvidenceFreshness` consults.
 *
 * The map is updated only when every precondition holds:
 *  - `options.toolName === "read"` (other tools are ignored);
 *  - `options.isError === false` (failed reads are ignored — the
 *    error result does not carry a trustworthy `contentIdentity`);
 *  - `options.result.details?.contentIdentity` is a non-empty string;
 *  - `options.args.path` is a non-empty string.
 *
 * Returns `true` when the map was updated, `false` otherwise. The
 * return value exists for tests and for hosts that want to log/observe
 * the capture without re-running the same guards.
 *
 * The function is pure: it only mutates the supplied map and never
 * touches the filesystem. Callers decide how to source the `result`
 * (the agent-core `afterToolCall` hook uses the original executed
 * result, not a post-hook override, so the recorded hash matches the
 * file the tool actually opened).
 */
export function captureReadResultForFreshness(
	latestHashes: Map<string, string>,
	options: CaptureReadResultOptions,
): boolean {
	if (options.toolName !== "read") return false;
	if (options.isError) return false;
	const contentIdentity = options.result.details?.contentIdentity;
	if (typeof contentIdentity !== "string" || contentIdentity.length === 0) {
		return false;
	}
	const path = (options.args as { path?: unknown } | null | undefined)?.path;
	if (typeof path !== "string" || path.length === 0) {
		return false;
	}
	latestHashes.set(path, contentIdentity);
	return true;
}

/**
 * Attach a `FreshnessReport` to a `CompiledContext` and, when the
 * report has at least one stale or missing row, prepend a non-displayed
 * `custom` message that lists the affected paths. When every file is
 * `fresh` (or the report is empty), the function returns the input
 * context with only the `freshness` field attached and no new message
 * prepended.
 *
 * The original `CompiledContext` is not mutated. The returned
 * `CompiledContext` shares the original `messages` reference when no
 * new message is prepended; otherwise it carries a new array with the
 * freshness message at index 0.
 */
export function annotateStaleness(report: FreshnessReport, context: CompiledContext): CompiledContext {
	const hasIssues = report.staleCount > 0 || report.missingCount > 0;
	if (!hasIssues) {
		return { ...context, freshness: report };
	}

	const now = report.checks.length > 0 ? report.checks[0]!.checkedAt : Date.now();
	const message = buildFreshnessWarningMessage(report, now);
	return {
		...context,
		messages: [message, ...context.messages] as AgentMessage[],
		freshness: report,
	};
}

