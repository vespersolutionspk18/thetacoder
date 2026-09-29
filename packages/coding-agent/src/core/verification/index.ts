/**
 * Public surface for the F16 verification engine.
 *
 * Re-exports the policy loader, runner, gate, parsers, and
 * requirement extractor. Consumers should import from here rather
 * than from individual sub-modules, so the engine's API surface
 * stays in one place.
 */

// Re-export the gate-related TaskState types for convenience.
export type { GateResult, TaskStateRequirement } from "../task-state.ts";
export { CompletionGate, type EvaluateGateOptions, evaluateGate } from "./gate.ts";
export {
	parseBiome,
	parseById,
	parseEslint,
	parseJest,
	parseMocha,
	parsePytest,
	parseRaw,
	parseTsc,
	parseVitest,
} from "./parsers.ts";
export {
	buildDefaultPolicy,
	type DefaultResolverInputs,
	detectDefaultInputs,
	loadVerificationPolicy,
	type PackageJsonShape,
	type PolicyFileFormat,
	type PolicyLoadInputs,
	resolveCheckCwd,
	safeCheckIdForLog,
} from "./policy.ts";
export {
	type ExtractRequirementsOptions,
	extractAndAddRequirements,
	extractRequirements,
} from "./requirement-extractor.ts";
export { computeSnapshotHash, type RunChecksOptions, runChecks, runOne } from "./runner.ts";
export type {
	CheckFailure,
	CheckOutcome,
	VerificationCheck,
	VerificationParserId,
	VerificationPolicy,
	VerificationPolicySource,
	VerificationRunnerContext,
	VerificationRunResult,
	VerificationSnapshot,
} from "./types.ts";

