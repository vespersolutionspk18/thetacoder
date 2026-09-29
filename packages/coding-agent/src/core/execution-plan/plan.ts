/**
 * F6 foundational layer: declarative {@link ExecutionPlan} data type.
 *
 * This module is a pure data layer. It does not run, schedule, or
 * interpret plans. The runtime executor and agent-loop integration are
 * intentionally out of scope for the minimum viable layer.
 *
 * The shape is informed by the F6 audit finding (bounded execution
 * plans with dependencies, read/write sets, preconditions, cancellation,
 * and stop-on-unexpected-result behavior) and the Section 14 call
 * amplification table.
 */

export type ExecutionStepKind =
	| "read"
	| "edit"
	| "write"
	| "bash"
	| "grep"
	| "find"
	| "test"
	| "lint"
	| "typecheck"
	| "build"
	| "package"
	| "verify"
	| "subagent"
	| "custom";

export type ExecutionPreconditionKind = "file-exists" | "file-hash" | "compaction-preserved" | "tool-result";

export interface ExecutionPrecondition {
	kind: ExecutionPreconditionKind;
	target: string;
	expected?: string;
}

export type ExecutionExpectedOutcome = "succeeded" | "completed" | "passed" | "ok";

export interface ExecutionStep {
	id: string;
	kind: ExecutionStepKind;
	target?: string;
	operation: string;
	dependsOn: string[];
	readSet?: string[];
	writeSet?: string[];
	preconditions?: ExecutionPrecondition[];
	timeoutMs?: number;
	stopOnUnexpected?: boolean;
	expectedOutcome?: ExecutionExpectedOutcome;
}

export type ExecutionStopConditionKind =
	| "on-failure"
	| "on-conflict"
	| "on-context-overflow"
	| "on-budget-exceeded"
	| "on-user-cancel";

export interface ExecutionStopCondition {
	kind: ExecutionStopConditionKind;
	haltAll?: boolean;
	skipRemaining?: boolean;
}

export type ExecutionResourceIo = "low" | "medium" | "high";

export interface ExecutionResourceHints {
	gpu?: number;
	cpu?: number;
	io?: ExecutionResourceIo;
}

export interface ExecutionPlan {
	id: string;
	intent: string;
	steps: ExecutionStep[];
	stopConditions: ExecutionStopCondition[];
	resourceHints?: ExecutionResourceHints;
	createdAt: number;
}

export type PlanValidationErrorKind = "duplicate-id" | "unknown-dependency" | "cycle" | "invalid-resource-hint";

export interface PlanValidationError {
	kind: PlanValidationErrorKind;
	stepIds?: string[];
	details?: string;
}

export type PlanValidationResult = { ok: true } | { ok: false; errors: PlanValidationError[] };

/**
 * Fluent builder for {@link ExecutionPlan}.
 *
 * Methods are designed to chain. `.step(...)` opens a new step; the
 * `.dependsOn`, `.reads`, `.writes` helpers attach metadata to the
 * most recently opened step. `.stopOn(...)` accumulates plan-level
 * stop conditions. `.build()` snapshots the current state into an
 * {@link ExecutionPlan} value (later mutations of the builder do not
 * affect previously built plans).
 */
export interface PlanBuilder {
	step(
		opts: Partial<ExecutionStep> & {
			id: string;
			kind: ExecutionStepKind;
			operation: string;
		},
	): PlanBuilder;
	dependsOn(stepId: string): PlanBuilder;
	reads(paths: string[]): PlanBuilder;
	writes(paths: string[]): PlanBuilder;
	stopOn(condition: ExecutionStopCondition): PlanBuilder;
	build(): ExecutionPlan;
}

class PlanBuilderImpl implements PlanBuilder {
	private readonly steps: ExecutionStep[] = [];
	private readonly stopConditions: ExecutionStopCondition[] = [];
	private current: ExecutionStep | null = null;
	private planId = 0;
	private readonly intent: string;

	constructor(intent: string) {
		this.intent = intent;
	}

	step(
		opts: Partial<ExecutionStep> & {
			id: string;
			kind: ExecutionStepKind;
			operation: string;
		},
	): PlanBuilder {
		const next: ExecutionStep = {
			id: opts.id,
			kind: opts.kind,
			operation: opts.operation,
			target: opts.target,
			dependsOn: [...(opts.dependsOn ?? [])],
			readSet: opts.readSet ? [...opts.readSet] : undefined,
			writeSet: opts.writeSet ? [...opts.writeSet] : undefined,
			preconditions: opts.preconditions ? [...opts.preconditions] : undefined,
			timeoutMs: opts.timeoutMs,
			stopOnUnexpected: opts.stopOnUnexpected,
			expectedOutcome: opts.expectedOutcome,
		};
		this.steps.push(next);
		this.current = next;
		return this;
	}

	dependsOn(stepId: string): PlanBuilder {
		const cur = this.requireCurrent("dependsOn");
		if (!cur.dependsOn.includes(stepId)) {
			cur.dependsOn = [...cur.dependsOn, stepId];
		}
		return this;
	}

	reads(paths: string[]): PlanBuilder {
		const cur = this.requireCurrent("reads");
		cur.readSet = cur.readSet ? [...cur.readSet, ...paths] : [...paths];
		return this;
	}

	writes(paths: string[]): PlanBuilder {
		const cur = this.requireCurrent("writes");
		cur.writeSet = cur.writeSet ? [...cur.writeSet, ...paths] : [...paths];
		return this;
	}

	stopOn(condition: ExecutionStopCondition): PlanBuilder {
		this.stopConditions.push({ ...condition });
		return this;
	}

	build(): ExecutionPlan {
		// Snapshot to ensure later mutations on the builder do not affect
		// the produced plan value.
		const snapshotSteps = this.steps.map((s) => ({
			id: s.id,
			kind: s.kind,
			operation: s.operation,
			target: s.target,
			dependsOn: [...s.dependsOn],
			readSet: s.readSet ? [...s.readSet] : undefined,
			writeSet: s.writeSet ? [...s.writeSet] : undefined,
			preconditions: s.preconditions ? [...s.preconditions] : undefined,
			timeoutMs: s.timeoutMs,
			stopOnUnexpected: s.stopOnUnexpected,
			expectedOutcome: s.expectedOutcome,
		}));
		const plan: ExecutionPlan = {
			id: `plan-${Date.now().toString(36)}-${(this.planId++).toString(36)}`,
			intent: this.intent,
			steps: snapshotSteps,
			stopConditions: this.stopConditions.map((c) => ({ ...c })),
			createdAt: Date.now(),
		};
		return plan;
	}

	private requireCurrent(method: string): ExecutionStep {
		if (!this.current) {
			throw new Error(`PlanBuilder.${method}() called before any step() was opened.`);
		}
		return this.current;
	}
}

export function createPlan(intent: string): PlanBuilder {
	return new PlanBuilderImpl(intent);
}

/**
 * Build a dependency adjacency list keyed by step id. Only includes
 * edges that point to steps that actually exist in the plan; unknown
 * dependencies are surfaced separately by {@link validatePlan}.
 */
function buildDependents(steps: ExecutionStep[]): Map<string, string[]> {
	const ids = new Set(steps.map((s) => s.id));
	const dependents = new Map<string, string[]>();
	for (const s of steps) dependents.set(s.id, []);
	for (const s of steps) {
		for (const dep of s.dependsOn) {
			if (!ids.has(dep)) continue;
			const list = dependents.get(dep);
			if (list) list.push(s.id);
		}
	}
	return dependents;
}

function computeInDegrees(steps: ExecutionStep[]): Map<string, number> {
	const ids = new Set(steps.map((s) => s.id));
	const inDegree = new Map<string, number>();
	for (const s of steps) inDegree.set(s.id, 0);
	for (const s of steps) {
		for (const dep of s.dependsOn) {
			if (ids.has(dep)) {
				inDegree.set(s.id, (inDegree.get(s.id) ?? 0) + 1);
			}
		}
	}
	return inDegree;
}

/**
 * Find one cycle in the dependency graph using iterative DFS with
 * path tracking. Returns the cycle as an array of step ids starting
 * and ending with the same id, or `null` if no cycle exists.
 */
function findCycle(steps: ExecutionStep[]): string[] | null {
	const ids = new Set(steps.map((s) => s.id));
	const idToStep = new Map(steps.map((s) => [s.id, s] as const));
	const color = new Map<string, 0 | 1 | 2>(); // 0=white, 1=gray, 2=black
	for (const s of steps) color.set(s.id, 0);

	for (const s of steps) {
		if (color.get(s.id) !== 0) continue;
		// Iterative DFS with explicit stack frames.
		const stack: Array<{ node: string; iter: Iterator<string> }> = [];
		const path: string[] = [s.id];
		color.set(s.id, 1);
		stack.push({ node: s.id, iter: (idToStep.get(s.id)?.dependsOn ?? [])[Symbol.iterator]() });

		while (stack.length > 0) {
			const frame = stack[stack.length - 1];
			const next = frame.iter.next();
			if (next.done) {
				color.set(frame.node, 2);
				stack.pop();
				path.pop();
				continue;
			}
			const dep = next.value;
			if (!ids.has(dep)) continue;
			const c = color.get(dep);
			if (c === 1) {
				// Back edge: dep is in our current path, so dep -> ... -> frame.node -> dep.
				const startIdx = path.indexOf(dep);
				return path.slice(startIdx).concat([dep]);
			}
			if (c === 0) {
				color.set(dep, 1);
				path.push(dep);
				stack.push({ node: dep, iter: (idToStep.get(dep)?.dependsOn ?? [])[Symbol.iterator]() });
			}
		}
	}
	return null;
}

/**
 * Validate the structural integrity of an {@link ExecutionPlan}.
 *
 * Returns `{ ok: true }` when the plan passes every check, otherwise
 * a list of {@link PlanValidationError} describing each problem.
 *
 * The plan must satisfy:
 *
 * 1. All step ids are unique.
 * 2. Every `dependsOn` entry references an existing step id.
 * 3. The dependency graph is a DAG (no cycles).
 * 4. Any path in a `writeSet` either appears in some `readSet` (i.e.
 *    the planner reads before it writes) or is a brand-new path that
 *    is written by exactly one step (a new file).
 * 5. `resourceHints`, if present, are non-negative numbers for `gpu`
 *    and `cpu`, and `io` is one of `"low" | "medium" | "high"`.
 */
export function validatePlan(plan: ExecutionPlan): PlanValidationResult {
	const errors: PlanValidationError[] = [];

	// 1. Duplicate ids.
	const idCounts = new Map<string, number>();
	for (const step of plan.steps) {
		idCounts.set(step.id, (idCounts.get(step.id) ?? 0) + 1);
	}
	const duplicateIds: string[] = [];
	for (const [id, count] of idCounts) {
		if (count > 1) duplicateIds.push(id);
	}
	if (duplicateIds.length > 0) {
		errors.push({
			kind: "duplicate-id",
			stepIds: [...duplicateIds].sort(),
			details: `Step ids must be unique; duplicates: ${duplicateIds.join(", ")}`,
		});
	}

	// 2. Unknown dependencies.
	const knownIds = new Set(plan.steps.map((s) => s.id));
	const unknownDepsByStep = new Map<string, string[]>();
	for (const step of plan.steps) {
		const unknown: string[] = [];
		for (const dep of step.dependsOn) {
			if (!knownIds.has(dep)) unknown.push(dep);
		}
		if (unknown.length > 0) unknownDepsByStep.set(step.id, unknown);
	}
	if (unknownDepsByStep.size > 0) {
		const stepIds = Array.from(unknownDepsByStep.keys()).sort();
		const detail = Array.from(unknownDepsByStep.entries())
			.map(([step, deps]) => `${step} -> ${deps.join(",")}`)
			.join("; ");
		errors.push({
			kind: "unknown-dependency",
			stepIds,
			details: `Unknown step references in dependsOn: ${detail}`,
		});
	}

	// 3. Cycle detection (Kahn's algorithm on remaining nodes after
	// duplicate/unknown resolution; we run it on all edges that point
	// to known ids to be robust against mixed errors).
	const cycle = findCycle(plan.steps);
	if (cycle) {
		errors.push({
			kind: "cycle",
			stepIds: cycle,
			details: `Dependency cycle: ${cycle.join(" -> ")}`,
		});
	}

	// 4. writeSet vs readSet rule.
	const allReads = new Set<string>();
	const writeOwners = new Map<string, string[]>();
	for (const step of plan.steps) {
		for (const path of step.readSet ?? []) allReads.add(path);
		for (const path of step.writeSet ?? []) {
			const owners = writeOwners.get(path) ?? [];
			owners.push(step.id);
			writeOwners.set(path, owners);
		}
	}
	const undeclaredWriteSteps: string[] = [];
	for (const [path, owners] of writeOwners) {
		if (allReads.has(path)) continue; // Read-before-write is allowed.
		// New file: must be written by exactly one step.
		if (owners.length > 1) {
			undeclaredWriteSteps.push(...owners);
			errors.push({
				kind: "unknown-dependency",
				stepIds: [...owners].sort(),
				details: `Path ${path} is written by multiple steps but is not in any readSet: ${owners.join(", ")}`,
			});
		}
	}
	// Avoid double-reporting the same owners across multiple paths.
	void undeclaredWriteSteps;

	// 5. Resource hints.
	if (plan.resourceHints) {
		const { gpu, cpu, io } = plan.resourceHints;
		const detail: string[] = [];
		if (gpu !== undefined) {
			if (typeof gpu !== "number" || !Number.isFinite(gpu) || gpu < 0) {
				detail.push(`gpu=${String(gpu)}`);
			}
		}
		if (cpu !== undefined) {
			if (typeof cpu !== "number" || !Number.isFinite(cpu) || cpu < 0) {
				detail.push(`cpu=${String(cpu)}`);
			}
		}
		if (io !== undefined) {
			if (io !== "low" && io !== "medium" && io !== "high") {
				detail.push(`io=${String(io)}`);
			}
		}
		if (detail.length > 0) {
			errors.push({
				kind: "invalid-resource-hint",
				details: `Resource hint values must be non-negative numbers (gpu, cpu) and io in {"low","medium","high"}; got ${detail.join(", ")}`,
			});
		}
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}
	return { ok: true };
}

/**
 * Return the step ids of an {@link ExecutionPlan} in a valid
 * execution order (dependencies before dependents). Throws if the
 * plan contains a cycle; the error message includes the offending
 * cycle.
 *
 * Ties are broken by the order the steps appear in `plan.steps`,
 * which is stable and deterministic for a given builder invocation.
 */
export function topologicalOrder(plan: ExecutionPlan): string[] {
	const inDegree = computeInDegrees(plan.steps);
	const dependents = buildDependents(plan.steps);

	const ready: string[] = [];
	for (const step of plan.steps) {
		if ((inDegree.get(step.id) ?? 0) === 0) ready.push(step.id);
	}

	const result: string[] = [];
	while (ready.length > 0) {
		// Use shift to preserve the input step order for ties.
		const id = ready.shift()!;
		result.push(id);
		for (const dependent of dependents.get(id) ?? []) {
			const next = (inDegree.get(dependent) ?? 0) - 1;
			inDegree.set(dependent, next);
			if (next === 0) ready.push(dependent);
		}
	}

	if (result.length !== plan.steps.length) {
		const cycle = findCycle(plan.steps);
		const detail = cycle ? ` Cycle: ${cycle.join(" -> ")}.` : "";
		throw new Error(`ExecutionPlan has a dependency cycle.${detail}`);
	}
	return result;
}

