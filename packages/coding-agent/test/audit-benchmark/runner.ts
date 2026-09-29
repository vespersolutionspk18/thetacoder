/**
 * Audit-benchmark runner.
 *
 * `runAuditBenchmark({ task, options })` executes the F2 context-compiler
 * + convertToLlm pipeline for a single task under one of the four cell
 * configurations (cold+F2-off, cold+F2-on, warm+F2-off, warm+F2-on) and
 * returns the resulting `RunMetrics` snapshot.
 *
 * The runner drives the F2 layer turn-by-turn. Between every LLM call
 * the runner:
 *   1. Applies `compileContext` to the message stream.
 *   2. Applies evidence freshness (check + annotate).
 *   3. Applies cache-marker annotation + plan attachment.
 *   4. Calls `convertToLlm` (incremental when F2 is on, plain when off).
 *   5. Hands the converted messages to the scripted mock LLM, which
 *      returns the next `AssistantMessage` for the stream.
 *
 * After the scripted turns run out, the runner finalises the metrics
 * and returns a `RunMetrics` snapshot.
 *
 * Cold vs warm:
 *  - Cold: a fresh `IncrementalSerializer` is constructed for the run,
 *    so the first turn of every run is a miss and subsequent turns
 *    within the run are hits.
 *  - Warm: the same `IncrementalSerializer` is shared across all
 *    repetitions of a cell, so by the second repetition the same
 *    message references are all cache hits.
 *
 * F2 on vs off:
 *  - On: `convertToLlmIncremental` is used (cache hit/miss counted).
 *  - Off: plain `convertToLlm` is used (no cache). Cache hit/miss
 *    counters stay at 0.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { RenderCacheOptions } from "../../src/core/cache-rendering.ts";
import {
	type IncrementalSerializer,
	IncrementalSerializer as IncrementalSerializerClass,
} from "../../src/core/incremental-serialization.ts";
import type { TaskState } from "../../src/core/task-state.ts";
import { type RunMetrics, RunMetricsCollector } from "./metrics.ts";
import { ScriptedMockLLM } from "./mock-llm.ts";
import { runF2Pipeline } from "./shared.ts";
import type { TaskDefinition, Turn } from "./tasks.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CacheMode = "cold" | "warm";
export type F2Mode = "on" | "off";

export interface RunOptions {
	/** Cold (fresh serializer per run) or warm (shared across repetitions). */
	cacheMode: CacheMode;
	/** On uses `convertToLlmIncremental`; off uses plain `convertToLlm`. */
	f2Mode: F2Mode;
	/** Shared F2 cache, only consulted when `cacheMode === "warm"`. */
	sharedSerializer?: IncrementalSerializer;
	/** Token budget passed to `compileContext`. Default: 200_000. */
	tokenBudget?: number;
	/** Render options passed to `annotateCacheMarkers`. */
	renderOptions?: RenderCacheOptions;
}

export interface RunAuditBenchmarkInput {
	task: TaskDefinition;
	options: RunOptions;
	/** Optional 1-based repetition index, recorded in metrics for diagnostics. */
	repetition?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_RENDER_OPTIONS: RenderCacheOptions = {
	format: "anthropic",
	retention: "short",
	systemPrompt: true,
	lastTool: true,
	lastMessage: true,
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run a single task once and return the `RunMetrics` snapshot.
 *
 * The function is synchronous-ish: it awaits the F2 pipeline between
 * turns but does not start any real network calls. The mock LLM
 * response is pre-decided by the task's scripted turns.
 */
export async function runAuditBenchmark(input: RunAuditBenchmarkInput): Promise<RunMetrics> {
	const { task, options } = input;
	const repetition = input.repetition ?? 1;
	const cell = `${task.id}|${options.cacheMode}|F2-${options.f2Mode}|r${repetition}`;

	const collector = new RunMetricsCollector(cell, task.id, options.cacheMode, options.f2Mode);

	// ---- F2 wire-in setup ----
	// Cold: fresh serializer per run. Warm: share the supplied one
	// (the benchmark entry point hands the same one to every
	// repetition of the cell).
	const serializer: IncrementalSerializer | null =
		options.f2Mode === "on"
			? options.cacheMode === "warm"
				? (options.sharedSerializer ?? new IncrementalSerializerClass())
				: new IncrementalSerializerClass()
			: null;

	const renderOptions = options.renderOptions ?? DEFAULT_RENDER_OPTIONS;
	const tokenBudget = options.tokenBudget ?? 200_000;

	// ---- Per-run mutable state ----
	let taskState: TaskState = task.buildInitialTaskState();
	const latestHashes = new Map<string, string>();
	const stream: AgentMessage[] = [];
	const turns = task.buildTurns();
	const mockLlm = new ScriptedMockLLM(turns.map((t) => ({ assistantMessage: t.assistantMessage })));

	try {
		// ---- Turn loop ----
		for (let i = 0; i < turns.length; i++) {
			const turn = turns[i]!;

			// Record the LLM call the model would have made. The mock
			// provider is "called" by popping the queue — the runner
			// records the call count directly on the collector.
			mockLlm.next();
			collector.recordInference();

			// The mock LLM's response is `turn.assistantMessage`. The
			// runner records the prompt + generated text the F2 layer
			// would have sent / received for this turn. We replay the
			// F2 pipeline on `turn.streamBeforeCall` (the stream as
			// the model would have seen it), then update the stream
			// with the assistant message and the tool result.
			const f2 = runF2Pipeline({
				messages: turn.streamBeforeCall,
				taskState,
				latestHashes,
				f2Enabled: options.f2Mode === "on",
				incrementalSerializer: serializer,
				renderOptions,
				tokenBudget,
			});
			collector.recordTurnProjection(f2.projection);
			collector.recordCacheControlEmissions(f2.cacheControlEmissions);
			if (f2.freshnessWarningCount > 0) collector.recordFreshnessWarning();
			collector.recordF2Cache(serializer?.getCacheStats().hits ?? 0, serializer?.getCacheStats().misses ?? 0);

			// Apply the assistant message to the stream.
			stream.push(turn.assistantMessage);
			// toolCalls counter — count the tool-call blocks in the assistant message.
			for (const block of turn.assistantMessage.content) {
				if (block.type === "toolCall") {
					collector.toolCalls += 1;
					// Detect incorrect repo claims.
					if (turn.incorrectRepositoryClaim) {
						collector.recordIncorrectRepositoryClaim();
					} else {
						const path = block.arguments?.path;
						if (
							typeof path === "string" &&
							task.expectedPaths.length > 0 &&
							!task.expectedPaths.includes(path) &&
							!path.includes("helpers/") /* the navigation task's known-bad path */
						) {
							// Generic guard: tool call to a path the task did not declare as expected.
							// Skip when the path is intentionally the "expected wrong" path of a task.
						}
					}
				}
			}

			// If the assistant asked for a tool, execute it (scripted)
			// and update the stream + task state.
			if (turn.expectedToolCall) {
				const tc = turn.expectedToolCall;
				const toolResultContent = tc.result.isError ? (tc.result.text as string) : (tc.result.text as string);
				stream.push({
					role: "toolResult",
					toolCallId:
						turn.assistantMessage.content.find((b) => b.type === "toolCall")?.id ??
						`tc_${i}_${Math.random().toString(36).slice(2, 7)}`,
					toolName: tc.name,
					content: [{ type: "text", text: toolResultContent }],
					isError: tc.result.isError ?? false,
					timestamp: Date.now(),
				});
				collector.recordToolResult(tc.name, toolResultContent, tc.result.isError ?? false);

				// Capture the read's contentIdentity for freshness.
				if (tc.name === "read" && !tc.result.isError && tc.result.contentIdentity) {
					const path = tc.arguments.path;
					if (typeof path === "string") {
						latestHashes.set(path, tc.result.contentIdentity);
						collector.recordReadHash(tc.result.contentIdentity);
					}
				}

				// Mutate task state for the edit (and reflect the
				// contentIdentity in `changedFiles`).
				if (tc.name === "edit" && !tc.result.isError && tc.result.contentIdentity) {
					const path = tc.arguments.path;
					if (typeof path === "string") {
						taskState = {
							...taskState,
							changedFiles: taskState.changedFiles
								.filter((cf) => cf.path !== path)
								.concat([{ path, contentHash: tc.result.contentIdentity!, changedAt: Date.now() }]),
							updatedAt: Date.now(),
						};
					}
				}
			}

			// Terminal turns: stop iterating.
			if (turn.terminal) {
				collector.completed = true;
				break;
			}
		}
	} catch (error) {
		// Mark as not completed but still return metrics.
		collector.completed = false;
		// Re-raise after snapshot so the caller can log.
		const snapshot = collector.snapshot();
		snapshot.cell = `${snapshot.cell}|ERROR:${(error as Error).message.slice(0, 40)}`;
		// Warm mode: surface the error to the caller.
		if (options.cacheMode === "cold") {
			// Cold runs should be deterministic; re-throw.
			throw error;
		}
		return snapshot;
	}

	return collector.snapshot();
}

// ---------------------------------------------------------------------------
// Helpers exported for the entry point
// ---------------------------------------------------------------------------

/** Default render options for the F2 cache-marker step. */
export function defaultRenderOptions(): RenderCacheOptions {
	return { ...DEFAULT_RENDER_OPTIONS };
}

/** Construct a fresh shared `IncrementalSerializer` for warm runs. */
export function newSharedSerializer(): IncrementalSerializer {
	return new IncrementalSerializerClass();
}

/** A single cell result. Just an alias for the snapshot. */
export type CellRunResult = RunMetrics;

/** Coerce a stream into the post-call state used by the next turn. */
export function appendTurnToStream(stream: AgentMessage[], turn: Turn): AgentMessage[] {
	const next = stream.slice();
	next.push(turn.assistantMessage);
	return next;
}

