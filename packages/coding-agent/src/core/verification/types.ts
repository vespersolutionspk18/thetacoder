/**
 * Shared types for the F16 verification engine.
 *
 * This module is the type-only root: it has no runtime code so every
 * other verification sub-module can import the types without dragging
 * the runner's process-management code along.
 */

import type { BashOperations } from "../tools/bash.ts";

/**
 * A single named check the verification policy knows how to run.
 *
 * - `id`        — stable id used to bind a `TaskStateRequirement` to a
 *                 concrete check. Two policies that mean the same thing
 *                 should reuse the same id (`tsc-noEmit`, `vitest-run`,
 *                 …) so requirements are portable across repos.
 * - `kind`      — the `TaskStateVerification.kind` this check produces.
 *                 A typecheck check lands as `kind: "typecheck"`, a
 *                 vitest run lands as `kind: "test"`, and so on.
 * - `command`   — the command line the runner spawns. The runner does
 *                 not parse this; it forwards to `BashOperations.exec`.
 * - `cwd`       — relative to the worktree. Defaults to the worktree
 *                 root when `undefined`.
 * - `env`       — extra env vars merged on top of the parent's env.
 * - `timeoutMs` — per-check timeout. Defaults to `policy.timeoutMs`.
 * - `parser`    — which structured parser consumes the output. The
 *                 `raw` parser treats any `exit 0` as a pass and any
 *                 other exit as a fail (least safe, but fine for
 *                 well-behaved tools whose output we haven't modelled).
 * - `blocking`  — whether the gate refuses to mark a turn `satisfied`
 *                 when this check has no matching passing verification.
 *                 Defaults to `true`.
 * - `trigger`   — when the runner should proactively fire this check.
 *                 `every-turn` runs at every `turn_end`; `on-demand`
 *                 (the default) only runs when the gate is evaluated
 *                 and the current evidence is stale.
 */
export interface VerificationCheck {
	id: string;
	kind: "test" | "lint" | "typecheck" | "snapshot" | "manual" | "user-accepted";
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	parser: VerificationParserId;
	blocking?: boolean;
	trigger?: "every-turn" | "on-demand";
	/** Human-readable description for the policy's audit trail. */
	description?: string;
}

/** Parser identifiers the engine knows about. */
export type VerificationParserId =
	| "raw"
	| "vitest"
	| "jest"
	| "mocha"
	| "pytest"
	| "biome"
	| "eslint"
	| "tsc"
	| "unknown";

/**
 * A bounded, normalized view of one check run. The runner produces
 * one of these per check; the parser populates the typed fields.
 *
 * `note` carries any diagnostic that a downstream consumer might
 * surface: `"Unknown format, treated as failure"` for `unknown`
 * parsers, `"timed out after 60s"`, `"exit 0 not trusted"`, etc.
 */
export interface CheckOutcome {
	passed: boolean;
	parser: VerificationParserId;
	note?: string;
	/** Best-effort extracted totals. Not every parser populates these. */
	total?: number;
	passedCount?: number;
	failedCount?: number;
	skippedCount?: number;
	/** Per-failure detail rows (failed test names, lint rule violations, …). */
	failures?: CheckFailure[];
	/** Raw output, bounded to 50 KiB by the runner. */
	outputTruncated?: string;
	/** Path to the full log file when the output exceeded the 50 KiB cap. */
	fullOutputPath?: string;
	/** True when the process was killed (timeout, abort signal, …). */
	timedOut?: boolean;
}

export interface CheckFailure {
	/** Stable id the parser can produce (e.g. `rule-name`, `file:line:col`). */
	id?: string;
	/** Human-readable name (test name, lint rule id, …). */
	name: string;
	/** Optional location (e.g. `path/to/file.ts:42`). */
	location?: string;
	/** Optional short message. */
	message?: string;
}

/**
 * A runner input — the parsed policy + the environment the runner
 * needs to operate in. Kept separate from `VerificationPolicy` so
 * the runner can be unit-tested with a hand-built context.
 */
export interface VerificationSnapshot {
	/** Stable hash of `state.changedFiles` (path + contentHash). */
	snapshotHash: string;
	/** Paths the user has changed in the current snapshot. */
	changedFilePaths: string[];
	/** Worktree root the runner spawns checks against. */
	worktreeRoot: string;
	/** Current time, overridable for tests. */
	now: number;
}

/**
 * The resolved, fully-defaulted policy the gate and runner consume.
 * The loader produces one of these; the policy file is the optional
 * input that shapes the resolution.
 */
export interface VerificationPolicy {
	/** Policy schema version. Bumped on breaking changes. */
	version: 1;
	/**
	 * Maximum number of checks the runner runs in parallel.
	 * Clamped to `[1, 16]` by the loader.
	 */
	concurrency: number;
	/** Default per-check timeout, in milliseconds. */
	timeoutMs: number;
	/** Where the runner writes overflow logs. Relative to worktree. */
	logDir: string;
	/**
	 * Master switch. When `false`, the gate short-circuits to
	 * `satisfied` and the runner never fires.
	 */
	enabled: boolean;
	/**
	 * When `true`, the runner re-spawns every-turn checks at every
	 * `turn_end`. When `false`, the runner only fires when the
	 * gate is evaluated and the current evidence is stale.
	 */
	runOnEveryTurn: boolean;
	/** The resolved list of checks. Always non-empty after loading. */
	checks: VerificationCheck[];
	/** Where the policy was loaded from. Diagnostic only. */
	source: VerificationPolicySource;
}

export type VerificationPolicySource =
	| { kind: "explicit-file"; path: string }
	| { kind: "package-json"; path: string }
	| { kind: "default"; reason: string };

/**
 * The runner's return value. One entry per check the policy declares,
 * in policy order. The runner does not collapse skipped checks — the
 * gate does that — so the consumer can tell "did not run" from "ran
 * and failed" apart.
 */
export interface VerificationRunResult {
	snapshotHash: string;
	startedAt: number;
	endedAt: number;
	outcomes: Array<{
		check: VerificationCheck;
		outcome: CheckOutcome;
	}>;
}

/** Context the runner needs. Lets the runner swap a fake for tests. */
export interface VerificationRunnerContext {
	bashOperations: BashOperations;
	worktreeRoot: string;
	now?: number;
}

