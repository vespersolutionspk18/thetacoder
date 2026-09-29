/**
 * F6 ExecutionPlan foundational layer.
 *
 * This is a pure data layer: types, a fluent builder, structural
 * validation, and topological ordering. There is no runtime executor
 * and no agent-loop integration in this module.
 */

export type {
	ExecutePlanOptions,
	ExecutionResult,
	ExecutionResultStatus,
	ExecutionStepResult,
	ExecutionStepStatus,
	StepRunner,
} from "./executor.ts";
export { executePlan } from "./executor.ts";
export type {
	ExecutionExpectedOutcome,
	ExecutionPlan,
	ExecutionPrecondition,
	ExecutionPreconditionKind,
	ExecutionResourceHints,
	ExecutionResourceIo,
	ExecutionStep,
	ExecutionStepKind,
	ExecutionStopCondition,
	ExecutionStopConditionKind,
	PlanBuilder,
	PlanValidationError,
	PlanValidationErrorKind,
	PlanValidationResult,
} from "./plan.ts";
export { createPlan, topologicalOrder, validatePlan } from "./plan.ts";

