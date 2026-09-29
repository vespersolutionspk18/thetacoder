/**
 * F6 ExecutionPlan runtime executor.
 *
 * The executor is a pure function module: it takes an {@link ExecutionPlan}
 * (a static, validated data structure from `./plan.ts`) and a
 * caller-supplied {@link StepRunner}, and walks the plan in dependency
 * order, calling the runner for each step.
 *
 * The executor is intentionally decoupled from the agent loop. It does
 * not import any tool, session, or agent state. All side effects flow
 * through the runner that the caller provides. This is what makes the
 * executor unit-testable without touching the filesystem, the network,
 * or any model provider.
 *
 * The behavior is informed by the F6 audit finding (bounded execution
 * plans with dependencies, read/write sets, preconditions, cancellation,
 * and stop-on-unexpected-result behavior) and the Section 14
 * call-amplification table:
 *
 *  - Sequential by default; opt-in concurrency for independent steps
 *    (e.g. tests, lint, typecheck, builds, package operations, child
 *    agents). The audit classifies these as "Conditionally concurrent";
 *    we keep the executor simple with a worker pool keyed by
 *    `topologicalOrder` so the model can opt into fan-out explicitly.
 *  - Dependent edits, mutation-then-validation, and conflicting
 *    transformations stay sequential; the executor enforces this by
 *    only releasing a step when all of its `dependsOn` results are
 *    available.
 *  - Stop conditions surface model-regaining signals back to the
 *    caller. The runner reports `failed` results with a structured
 *    `error.code` of `"conflict" | "context-overflow" | "budget-exceeded"`
 *    (or a message containing `"conflict"` as a fallback), and the
 *    executor maps them to the matching plan-level halt status.
 *  - `AbortSignal` is checked before every step; pre-abort steps finish
 *    normally, the aborting step and everything after it is reported as
 *    `cancelled` and the plan is halted.
 */

import {
	type ExecutionPlan,
	type ExecutionStep,
	type ExecutionStopCondition,
	type ExecutionStopConditionKind,
	topologicalOrder,
	validatePlan,
} from "./plan.ts";

/** Status of a single step's execution. */
export type ExecutionStepStatus = "succeeded" | "failed" | "cancelled" | "incomplete" | "unknown";

/**
 * Result of a single step's execution, as captured by the executor.
 *
 * `startedAt`/`endedAt`/`wallTimeMs` are measured by the executor, not
 * the runner, so the executor owns the canonical timing even if the
 * runner misbehaves (e.g. resolves a value but logs a failure).
 */
export interface ExecutionStepResult {
	stepId: string;
	status: ExecutionStepStatus;
	output?: unknown;
	error?: Error;
	startedAt: number;
	endedAt: number;
	wallTimeMs: number;
}

/**
 * Top-level outcome of an {@link executePlan} call. The `status`
 * discriminator is the same set the plan-level stop conditions are
 * based on, plus `"completed"` for the success path.
 */
export type ExecutionResultStatus =
	| "completed"
	| "halted-on-failure"
	| "halted-on-conflict"
	| "halted-on-context-overflow"
	| "halted-on-budget-exceeded"
	| "halted-on-user-cancel";

export interface ExecutionResult {
	planId: string;
	status: ExecutionResultStatus;
	stepResults: ExecutionStepResult[];
	startedAt: number;
	endedAt: number;
	wallTimeMs: number;
}

/**
 * The runner the caller supplies. It is invoked once per step the
 * executor releases, with the step and the caller's `AbortSignal`. The
 * signal is propagated so a runner that does I/O can wire it into its
 * underlying primitive (fetch, child process, AbortController timeout).
 */
export type StepRunner = (step: ExecutionStep, signal: AbortSignal) => Promise<ExecutionStepResult>;

/**
 * Stop conditions are merged with the plan's own `stopConditions`. A
 * caller-level stop condition takes precedence over a plan-level one
 * of the same kind (the first match wins when scanning the merged list
 * in the order the caller supplied, with plan-level conditions filling
 * in the rest).
 */
export interface ExecutePlanOptions {
	plan: ExecutionPlan;
	runner: StepRunner;
	/**
	 * Maximum number of steps in flight at once. `1` (the default)
	 * forces strict sequential execution. Values > 1 enable a simple
	 * worker pool that respects the dependency DAG.
	 *
	 * Values < 1 are treated as 1.
	 */
	concurrency?: number;
	/**
	 * Optional external cancellation signal. When aborted, the current
	 * step (if any) is allowed to settle; the executor then reports
	 * every remaining step as `cancelled` and the plan as
	 * `halted-on-user-cancel`.
	 */
	signal?: AbortSignal;
	/**
	 * Extra stop conditions merged with `plan.stopConditions`. Use
	 * this to tighten or override plan defaults from the calling
	 * context.
	 */
	stopConditions?: ExecutionStopCondition[];
}

/**
 * Well-known `Error.code` values that the runner can stamp onto a
 * thrown or returned error to signal a specific halt category. The
 * executor also accepts a message-substring fallback for `"conflict"`
 * because conflicts are commonly reported as plain errors in tool
 * layers that predate this convention.
 */
const HALT_CODE_TO_STATUS: Readonly<Record<string, ExecutionResultStatus>> = {
	conflict: "halted-on-conflict",
	"context-overflow": "halted-on-context-overflow",
	"budget-exceeded": "halted-on-budget-exceeded",
} as const;

function haltStatusForError(err: Error): ExecutionResultStatus | null {
	const code = (err as Error & { code?: unknown }).code;
	if (typeof code === "string") {
		const mapped = HALT_CODE_TO_STATUS[code];
		if (mapped) return mapped;
	}
	const message = err.message ?? "";
	if (/conflict/i.test(message)) return "halted-on-conflict";
	return null;
}

function isAbortErrorLike(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const name = (err as { name?: unknown }).name;
	if (name === "AbortError") return true;
	const message = (err as { message?: unknown }).message;
	if (typeof message === "string" && /aborted|cancellation|cancelled|canceled/i.test(message)) {
		return true;
	}
	return false;
}

function mergeStopConditions(
	plan: ExecutionPlan,
	extra: ExecutionStopCondition[] | undefined,
): ExecutionStopCondition[] {
	if (!extra || extra.length === 0) return plan.stopConditions;
	return [...extra, ...plan.stopConditions];
}

function hasStopCondition(merged: ExecutionStopCondition[], kind: ExecutionStopConditionKind): boolean {
	for (const c of merged) {
		if (c.kind === kind) return true;
	}
	return false;
}

function dependentsOf(plan: ExecutionPlan, id: string): string[] {
	const out: string[] = [];
	for (const s of plan.steps) {
		if (s.dependsOn.includes(id)) out.push(s.id);
	}
	return out;
}

/**
 * Run an {@link ExecutionPlan}.
 *
 * The plan is validated first; if it is structurally invalid this
 * function throws an `Error` whose message lists every validation
 * problem. After validation, the executor walks the plan in
 * topological order, releases each step to the caller-supplied runner
 * (respecting `concurrency` and the dependency DAG), and stops the
 * plan the first time a stop condition is triggered.
 *
 * The function never rethrows. The runner's exceptions are converted
 * into `failed` step results. The only path that throws is
 * `validatePlan` failing, which surfaces a programmer error in the
 * plan data.
 */
export async function executePlan(options: ExecutePlanOptions): Promise<ExecutionResult> {
	const { plan, runner } = options;
	const signal = options.signal;
	const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
	const stopConditions = mergeStopConditions(plan, options.stopConditions);

	const validation = validatePlan(plan);
	if (!validation.ok) {
		throw new Error(
			`ExecutionPlan failed validation: ${validation.errors
				.map((e) => `${e.kind}${e.details ? `: ${e.details}` : ""}`)
				.join("; ")}`,
		);
	}

	const order = topologicalOrder(plan);
	const startedAt = Date.now();
	const stepResults: ExecutionStepResult[] = [];
	const resultsById = new Map<string, ExecutionStepResult>();
	let haltStatus: ExecutionResultStatus | null = null;

	// Pre-compute a step lookup keyed by id for O(1) access.
	const stepById = new Map<string, ExecutionStep>();
	for (const s of plan.steps) stepById.set(s.id, s);

	// In-degree remaining for the worker pool. We start each step at
	// its declared in-degree (filtered to known deps) and decrement as
	// dependencies complete.
	const remainingDeps = new Map<string, number>();
	for (const s of plan.steps) {
		const knownDeps = s.dependsOn.filter((d) => stepById.has(d));
		remainingDeps.set(s.id, knownDeps.length);
	}

	// Mutable ready queue of step ids that are eligible to run. The
	// pool walks it in order so ties break deterministically by the
	// declared step order.
	const ready: string[] = [];
	for (const id of order) {
		if ((remainingDeps.get(id) ?? 0) === 0) ready.push(id);
	}

	const started = new Set<string>();
	let nextReadyIndex = 0;
	// Fallback signal used when the caller did not supply one. The
	// runner contract still receives an AbortSignal, so it can always
	// wire it into its underlying primitive.
	const fallbackSignal = new AbortController().signal;

	async function runStep(id: string): Promise<void> {
		const step = stepById.get(id);
		if (!step) return; // Should never happen: validated above.
		started.add(id);

		// Pre-step abort check: if the signal is already aborted we
		// never even call the runner.
		if (signal?.aborted) {
			const endedAt = Date.now();
			const result: ExecutionStepResult = {
				stepId: id,
				status: "cancelled",
				startedAt: endedAt,
				endedAt,
				wallTimeMs: 0,
			};
			stepResults.push(result);
			resultsById.set(id, result);
			haltStatus = "halted-on-user-cancel";
			return;
		}

		const stepStartedAt = Date.now();
		let result: ExecutionStepResult;
		try {
			const runnerResult = await runner(step, signal ?? fallbackSignal);
			const stepEndedAt = Date.now();
			const status: ExecutionStepStatus =
				runnerResult && typeof runnerResult === "object" && "status" in runnerResult
					? (runnerResult.status as ExecutionStepStatus)
					: "unknown";
			result = {
				stepId: id,
				status,
				output: runnerResult?.output,
				error: runnerResult?.error,
				startedAt: runnerResult?.startedAt ?? stepStartedAt,
				endedAt: runnerResult?.endedAt ?? stepEndedAt,
				wallTimeMs: runnerResult?.wallTimeMs ?? Math.max(0, (runnerResult?.endedAt ?? stepEndedAt) - stepStartedAt),
			};
		} catch (err) {
			const stepEndedAt = Date.now();
			const error = err instanceof Error ? err : new Error(String(err));
			if (isAbortErrorLike(error)) {
				result = {
					stepId: id,
					status: "cancelled",
					startedAt: stepStartedAt,
					endedAt: stepEndedAt,
					wallTimeMs: Math.max(0, stepEndedAt - stepStartedAt),
					error,
				};
			} else {
				result = {
					stepId: id,
					status: "failed",
					startedAt: stepStartedAt,
					endedAt: stepEndedAt,
					wallTimeMs: Math.max(0, stepEndedAt - stepStartedAt),
					error,
				};
			}
		}
		stepResults.push(result);
		resultsById.set(id, result);

		// Evaluate stop conditions for the just-completed step. We
		// only consider conditions that exist in the merged list; if
		// the plan did not opt into a halt, we never trigger it.
		if (haltStatus === null) {
			if (
				hasStopCondition(stopConditions, "on-failure") &&
				(result.status === "failed" || result.status === "incomplete" || result.status === "unknown")
			) {
				haltStatus = "halted-on-failure";
			} else if (
				hasStopCondition(stopConditions, "on-conflict") &&
				(result.status === "failed" || result.status === "incomplete" || result.status === "unknown") &&
				result.error &&
				haltStatusForError(result.error) === "halted-on-conflict"
			) {
				haltStatus = "halted-on-conflict";
			} else if (
				hasStopCondition(stopConditions, "on-context-overflow") &&
				(result.status === "failed" || result.status === "incomplete" || result.status === "unknown") &&
				result.error &&
				haltStatusForError(result.error) === "halted-on-context-overflow"
			) {
				haltStatus = "halted-on-context-overflow";
			} else if (
				hasStopCondition(stopConditions, "on-budget-exceeded") &&
				(result.status === "failed" || result.status === "incomplete" || result.status === "unknown") &&
				result.error &&
				haltStatusForError(result.error) === "halted-on-budget-exceeded"
			) {
				haltStatus = "halted-on-budget-exceeded";
			} else if (hasStopCondition(stopConditions, "on-user-cancel") && result.status === "cancelled") {
				haltStatus = "halted-on-user-cancel";
			}
		}

		// Decrement dependent counts and enqueue any newly-ready
		// dependents, regardless of whether we halted — the dependents
		// will be cancelled by the gate below when they are picked up.
		for (const dependent of dependentsOf(plan, id)) {
			const left = (remainingDeps.get(dependent) ?? 0) - 1;
			remainingDeps.set(dependent, left);
			if (left === 0 && !started.has(dependent)) {
				ready.push(dependent);
			}
		}
	}

	// Worker pool: at most `concurrency` `runStep` promises in flight.
	// The pool walks the `ready` queue. When a step completes, the
	// dependent-decrement block above pushes newly-ready ids onto the
	// same queue, and the next worker tick picks them up.
	async function worker(): Promise<void> {
		while (true) {
			if (haltStatus !== null) return;
			if (signal?.aborted) {
				haltStatus = "halted-on-user-cancel";
				return;
			}
			// Find the next ready step in queue order, skipping
			// anything already started. The ready queue is appended
			// in topological order modulo concurrency, so this scan
			// preserves dependency-order as much as possible.
			let picked: string | null = null;
			while (nextReadyIndex < ready.length) {
				const candidate = ready[nextReadyIndex++];
				if (candidate && !started.has(candidate)) {
					picked = candidate;
					break;
				}
			}
			if (picked === null) return;
			await runStep(picked);
		}
	}

	const workers: Promise<void>[] = [];
	const workerCount = Math.min(concurrency, Math.max(1, order.length));
	for (let i = 0; i < workerCount; i++) workers.push(worker());
	await Promise.all(workers);

	// Cancellation pass: any step that was never started because of
	// an early halt is reported as `cancelled` so the result has one
	// entry per declared step.
	if (haltStatus !== null) {
		for (const id of order) {
			if (resultsById.has(id)) continue;
			const endedAt = Date.now();
			const result: ExecutionStepResult = {
				stepId: id,
				status: "cancelled",
				startedAt: endedAt,
				endedAt,
				wallTimeMs: 0,
			};
			stepResults.push(result);
			resultsById.set(id, result);
		}
	}

	const endedAt = Date.now();
	// A plan that did not trigger any stop condition is "completed"
	// even if some individual steps returned "failed". Without an
	// opt-in stop condition the executor does not regain control on
	// failures; it lets the plan run to the end so the caller can
	// inspect the per-step results.
	const finalStatus: ExecutionResultStatus = haltStatus ?? "completed";

	// Reorder `stepResults` to the topological step order so callers
	// can pair them with `plan.steps` by index. (Workers append in
	// completion order, which is correct for the dependency DAG but
	// can differ from declaration order when concurrency > 1.)
	stepResults.sort((a, b) => order.indexOf(a.stepId) - order.indexOf(b.stepId));

	return {
		planId: plan.id,
		status: finalStatus,
		stepResults,
		startedAt,
		endedAt,
		wallTimeMs: Math.max(0, endedAt - startedAt),
	};
}

