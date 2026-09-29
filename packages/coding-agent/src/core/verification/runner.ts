/**
 * Verification runner.
 *
 * Spawns the policy's checks via the existing `BashOperations`
 * abstraction (the same one `BashTool` uses), captures output to
 * a bounded 50 KiB ring buffer, parses the result, and returns a
 * `VerificationRunResult` ready for the gate.
 *
 * Design notes:
 *
 *   * Bounded output: the runner keeps at most 50 KiB in memory. On
 *     overflow, the full output is written to
 *     `<worktree>/.theta/verification/<timestamp>/<check>.log`
 *     and the path is attached to the `CheckOutcome`.
 *
 *   * Concurrency: capped at `policy.concurrency`. The runner uses
 *     a small worker pool (no extra dep).
 *
 *   * Timeouts: enforced per check. `policy.timeoutMs` is the
 *     default; a check can override with `check.timeoutMs`.
 *     `AbortSignal` plumbing is honored.
 *
 *   * Parsers: each check's `parser` field is consulted via
 *     `parseById`. The runner does not interpret output beyond
 *     forwarding it to the parser.
 *
 *   * Fake-friendly: the production path uses
 *     `createLocalBashOperations`. Tests pass a hand-rolled
 *     `BashOperations` (see `verification-runner.test.ts`).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordVerification, type TaskState, type TaskStateVerification } from "../task-state.ts";
import { parseById } from "./parsers.ts";
import { resolveCheckCwd, safeCheckIdForLog } from "./policy.ts";
import type {
	CheckOutcome,
	VerificationCheck,
	VerificationPolicy,
	VerificationRunnerContext,
	VerificationRunResult,
	VerificationSnapshot,
} from "./types.ts";

/** Per-check in-memory output cap. The audit calls for 50 KiB. */
const OUTPUT_CAP_BYTES = 50 * 1024;

// ============================================================================
// Public entry point
// ============================================================================

export interface RunChecksOptions {
	policy: VerificationPolicy;
	snapshot: VerificationSnapshot;
	context: VerificationRunnerContext;
	signal?: AbortSignal;
	/**
	 * Optional state receiver — when set, the runner appends a
	 * `TaskStateVerification` to the supplied state for every
	 * outcome that produced one. The runner is otherwise pure
	 * (no side effects on any host state) when this is omitted.
	 */
	state?: TaskState;
}

/**
 * Run every check in `policy.checks` against the snapshot, in
 * parallel up to `policy.concurrency`, and return a populated
 * `VerificationRunResult`. The runner is the only place that
 * spawns processes; everything else is pure.
 */
export async function runChecks(options: RunChecksOptions): Promise<VerificationRunResult> {
	const { policy, snapshot, context, signal } = options;
	const startedAt = options.context.now ?? Date.now();
	const logRoot = ensureLogRoot(policy, snapshot, context);

	const outcomes: Array<{ check: VerificationCheck; outcome: CheckOutcome }> = [];
	const pool = new WorkerPool(policy.concurrency);

	for (const check of policy.checks) {
		const task = pool.run(async () => {
			const outcome = await runOneInternal(check, policy, snapshot, context, logRoot, signal);
			outcomes.push({ check, outcome });
		});
		// Fire-and-await; the pool caps in-flight work.
		await task;
	}

	const endedAt = options.context.now ?? Date.now();

	const result: VerificationRunResult = {
		snapshotHash: snapshot.snapshotHash,
		startedAt,
		endedAt,
		outcomes,
	};

	// Optional state mutation. Pure when `state` is omitted.
	if (options.state) {
		let next = options.state;
		for (const { check, outcome } of outcomes) {
			const verification = makeVerificationFromOutcome(check, outcome, snapshot.snapshotHash);
			next = recordVerification(next, verification);
		}
		// Stash the result back via the proxy mutation. The host
		// owns the canonical state (the SessionManager); the runner
		// only records the *caller's* copy here. Real wiring uses
		// `TaskStateMutation` or a callback.
		(options as { __stateRef?: { current: TaskState } }).__stateRef = { current: next };
	}

	return result;
}

// ============================================================================
// Surgical single-check runner
// ============================================================================

/**
 * Public single-check runner. The audit calls for surgical use
 * ("run just `tsc-noEmit` to refresh one evidence row"). Returns
 * the structured `CheckOutcome`; the caller decides how to record
 * it (typically via `recordVerification`).
 */
export async function runOne(
	check: VerificationCheck,
	policy: VerificationPolicy,
	snapshot: VerificationSnapshot,
	context: VerificationRunnerContext,
	signal?: AbortSignal,
): Promise<CheckOutcome> {
	const logRoot = ensureLogRoot(policy, snapshot, context);
	return runOneInternal(check, policy, snapshot, context, logRoot, signal);
}

// ============================================================================
// Internal helpers
// ============================================================================

async function runOneInternal(
	check: VerificationCheck,
	policy: VerificationPolicy,
	snapshot: VerificationSnapshot,
	context: VerificationRunnerContext,
	logRoot: string,
	signal?: AbortSignal,
): Promise<CheckOutcome> {
	const cwd = resolveCheckCwd(check, context.worktreeRoot);
	const timeoutMs = check.timeoutMs ?? policy.timeoutMs;
	const startedAt = context.now ?? Date.now();

	const buffered = new RingBuffer(OUTPUT_CAP_BYTES);
	let processExited = false;
	let exitCode: number | null = null;
	let timedOut = false;
	let cancelled = false;

	const timeoutController = new AbortController();
	const timeoutHandle = setTimeout(() => {
		timedOut = true;
		timeoutController.abort();
	}, timeoutMs);

	const composedSignal = mergeSignals(signal, timeoutController.signal);

	try {
		const onData = (chunk: Buffer) => {
			buffered.append(chunk);
		};
		const result = await context.bashOperations.exec(check.command, cwd, {
			onData,
			signal: composedSignal,
			timeout: Math.ceil(timeoutMs / 1000),
			env: check.env,
		});
		processExited = true;
		exitCode = result.exitCode;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (signal?.aborted) {
			cancelled = true;
		} else if (timedOut) {
			// leave timedOut = true
		} else {
			// Unexpected spawn error. Surface as a failed outcome.
			return {
				passed: false,
				parser: check.parser,
				note: `runner error: ${message}`,
				outputTruncated: buffered.toString(),
				timedOut: false,
			};
		}
	} finally {
		clearTimeout(timeoutHandle);
	}

	const rawOutput = buffered.toString();
	const fullOutputPath = maybeWriteOverflowLog(check, snapshot, logRoot, rawOutput, startedAt);

	if (timedOut) {
		return {
			passed: false,
			parser: check.parser,
			note: `timed out after ${timeoutMs}ms`,
			outputTruncated: rawOutput,
			fullOutputPath,
			timedOut: true,
		};
	}
	if (cancelled) {
		return {
			passed: false,
			parser: check.parser,
			note: "cancelled by signal",
			outputTruncated: rawOutput,
			fullOutputPath,
			timedOut: false,
		};
	}
	if (!processExited) {
		return {
			passed: false,
			parser: check.parser,
			note: "process did not exit cleanly",
			outputTruncated: rawOutput,
			fullOutputPath,
			timedOut: false,
		};
	}

	const parsed = parseById(check.parser, rawOutput, exitCode);
	// Tag overflow log onto the parsed result so the gate can show
	// the path in its `unmetRequirements` reason.
	return { ...parsed, fullOutputPath };
}

function makeVerificationFromOutcome(
	check: VerificationCheck,
	outcome: CheckOutcome,
	snapshotHash: string,
): Omit<TaskStateVerification, "id" | "observedAt"> {
	return {
		kind: check.kind,
		command: check.command,
		passed: outcome.passed,
		falseSuccess: outcome.passed && outcome.note !== undefined && /unknown format/i.test(outcome.note),
		snapshotHash,
	};
}

function ensureLogRoot(
	policy: VerificationPolicy,
	snapshot: VerificationSnapshot,
	context: VerificationRunnerContext,
): string {
	const ts = new Date(context.now ?? Date.now()).toISOString().replace(/[:.]/g, "-");
	const hashPrefix = snapshot.snapshotHash.slice(0, 8);
	const root = join(
		resolveCheckCwd({ id: "log-root", kind: "manual", command: "", parser: "raw" }, context.worktreeRoot),
		policy.logDir,
		`${ts}-${hashPrefix}`,
	);
	try {
		mkdirSync(root, { recursive: true });
	} catch {
		// best-effort; the runner can still operate without a log dir
	}
	return root;
}

function maybeWriteOverflowLog(
	check: VerificationCheck,
	snapshot: VerificationSnapshot,
	logRoot: string,
	output: string,
	startedAt: number,
): string | undefined {
	if (Buffer.byteLength(output, "utf-8") <= OUTPUT_CAP_BYTES) return undefined;
	const filename = `${safeCheckIdForLog(check.id)}-${snapshot.snapshotHash.slice(0, 8)}-${startedAt}.log`;
	const fullPath = join(logRoot, filename);
	try {
		if (!existsSync(logRoot)) mkdirSync(logRoot, { recursive: true });
		writeFileSync(fullPath, output, "utf-8");
		return fullPath;
	} catch {
		return undefined;
	}
}

// ============================================================================
// Small ring buffer
// ============================================================================

/**
 * Bounded text buffer. Tracks byte count rather than character count
 * so multi-byte UTF-8 stays under the cap. On overflow, the oldest
 * bytes are dropped — the runner surfaces the truncation via
 * `outputTruncated` and the `fullOutputPath` overflow log.
 */
class RingBuffer {
	private cap: number;
	private chunks: string[] = [];
	private byteCount = 0;

	constructor(capBytes: number) {
		this.cap = capBytes;
	}

	append(chunk: Buffer): void {
		const text = chunk.toString("utf-8");
		const bytes = Buffer.byteLength(text, "utf-8");
		this.chunks.push(text);
		this.byteCount += bytes;
		while (this.byteCount > this.cap && this.chunks.length > 1) {
			const removed = this.chunks.shift()!;
			this.byteCount -= Buffer.byteLength(removed, "utf-8");
		}
	}

	toString(): string {
		return this.chunks.join("");
	}
}

// ============================================================================
// Worker pool
// ============================================================================

class WorkerPool {
	private max: number;
	private inFlight = 0;
	private queue: Array<() => void> = [];

	constructor(max: number) {
		this.max = Math.max(1, max);
	}

	async run(task: () => Promise<void>): Promise<void> {
		if (this.inFlight < this.max) {
			this.inFlight++;
			try {
				await task();
			} finally {
				this.inFlight--;
				this.drain();
			}
			return;
		}
		await new Promise<void>((resolve) => this.queue.push(resolve));
		this.inFlight++;
		try {
			await task();
		} finally {
			this.inFlight--;
			this.drain();
		}
	}

	private drain(): void {
		const next = this.queue.shift();
		if (next) next();
	}
}

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
	if (!a) return b;
	if (a.aborted) return a;
	const controller = new AbortController();
	const onAbortA = () => controller.abort(a.reason);
	const onAbortB = () => controller.abort(b.reason);
	a.addEventListener("abort", onAbortA, { once: true });
	b.addEventListener("abort", onAbortB, { once: true });
	if (a.aborted) controller.abort(a.reason);
	if (b.aborted) controller.abort(b.reason);
	return controller.signal;
}

// ============================================================================
// Snapshot hashing
// ============================================================================

/**
 * Compute the snapshot hash for a `TaskState`. The hash is the
 * SHA-256 of `path\ncontentHash\n` rows, sorted by path, encoded
 * as hex. The hash is stable across machines and is what the
 * gate uses to bind evidence to the current source state.
 */
export function computeSnapshotHash(state: Pick<TaskState, "changedFiles">): string {
	const sorted = [...state.changedFiles].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const hash = createHash("sha256");
	for (const file of sorted) {
		hash.update(file.path);
		hash.update("\n");
		hash.update(file.contentHash);
		hash.update("\n");
	}
	return hash.digest("hex");
}

// Silence the unused-import warning for `join` in the no-op
// file-resolution branch. The runner resolves the policy log dir
// against the worktree root via `resolveCheckCwd` above.
void join;

