/**
 * Shared helpers for F2 cache-markers deep integration tests.
 *
 * The deep integration tests in this directory exercise the full F2
 * wire-in pipeline end-to-end with a real provider adapter:
 *
 *   compileContext  →  annotateCacheMarkers  →  attachCachePlanToMessages
 *     →  checkEvidenceFreshness  →  annotateStaleness  →  validateProviderProtocol
 *
 * Each test (OpenAI / Anthropic) starts from a sample conversation,
 * runs the wire-in through this helper, then forwards the projected
 * `AgentMessage[]` to the provider adapter. Mocking the HTTP/SDK layer
 * happens in the per-provider test files; this module only produces
 * the projection.
 *
 * Splitting the helper out keeps the per-provider tests focused on
 * the provider-specific mock + wire-format assertions, while the
 * pipeline steps stay in one place.
 */

import type { AgentMessage } from "@theta/agent-core";
import {
	annotateCacheMarkers,
	attachCachePlanToMessages,
	type CachePlan,
	type RenderCacheOptions,
} from "../../coding-agent/src/core/cache-rendering.ts";
import { type CompiledContext, compileContext } from "../../coding-agent/src/core/context-compiler.ts";
import {
	annotateStaleness,
	checkEvidenceFreshness,
	type FreshnessReport,
} from "../../coding-agent/src/core/evidence-freshness.ts";
import {
	type ProviderName,
	type ValidationResult,
	validateProviderProtocol,
} from "../../coding-agent/src/core/provider-protocol.ts";
import type { TaskState } from "../../coding-agent/src/core/task-state.ts";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Conversation fixture factories
// ---------------------------------------------------------------------------

/** Build a `UserMessage` for the sample conversation. */
export function makeUser(text: string, ts: number): AgentMessage & UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

/** Build a text-only `AssistantMessage` for the sample conversation. */
export function makeAssistantText(
	text: string,
	ts: number,
	api: "openai-completions" | "anthropic-messages",
): AgentMessage & AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		api,
		provider: api === "anthropic-messages" ? "anthropic" : "openrouter",
		model: "f2-deep-test",
		timestamp: ts,
	};
}

/** Build an `AssistantMessage` carrying a single tool call. */
export function makeAssistantWithToolCall(
	name: string,
	args: unknown,
	ts: number,
	api: "openai-completions" | "anthropic-messages",
): AgentMessage & AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `call-${ts}`, name, arguments: args as Record<string, unknown> }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		api,
		provider: api === "anthropic-messages" ? "anthropic" : "openrouter",
		model: "f2-deep-test",
		timestamp: ts,
	};
}

/** Build a `ToolResultMessage` for the sample conversation. */
export function makeToolResult(toolCallId: string, text: string, ts: number): AgentMessage & ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: ts,
	};
}

// ---------------------------------------------------------------------------
// F2 wire-in pipeline driver
// ---------------------------------------------------------------------------

/** Aggregated inputs to the F2 wire-in driver. */
export interface BuildF2ProjectionOptions {
	/** The conversation to compile. */
	conversation: AgentMessage[];
	/** Marker placement + format/retention for `annotateCacheMarkers`. */
	render: RenderCacheOptions;
	/** Provider name to validate the final projection against. */
	provider: ProviderName;
	/**
	 * Optional TaskState. When omitted, the freshness step is a no-op
	 * (returns an empty report) and `annotateStaleness` does not prepend
	 * a freshness-warning message.
	 */
	taskState?: TaskState;
	/**
	 * Optional latest-hashes map passed to `checkEvidenceFreshness`.
	 * Ignored when `taskState` is undefined.
	 */
	latestHashes?: Map<string, string>;
	/**
	 * Optional clock override for `checkEvidenceFreshness`. Useful when
	 * you want the report's `checkedAt` to be a stable value for
	 * assertions.
	 */
	now?: number;
}

/** Result returned by `buildF2Projection`. */
export interface F2ProjectionResult {
	/** Messages after the full wire-in, ready to hand to the provider adapter. */
	messages: AgentMessage[];
	/** The cache plan produced by `annotateCacheMarkers`. */
	cachePlan: CachePlan;
	/** The freshness report produced by `checkEvidenceFreshness`. */
	freshness: FreshnessReport;
	/** The result of `validateProviderProtocol`. */
	validation: ValidationResult;
	/** Token budget that was used for `compileContext`. */
	tokenBudget: number;
}

/**
 * Run the full F2 wire-in pipeline in the same order `sdk.ts` does
 * inside the `contextCompiler.compile` callback:
 *
 *   1. `compileContext`         — bound the projection to a token budget.
 *   2. `annotateCacheMarkers`   — produce a `CachePlan`.
 *   3. `attachCachePlanToMessages` — wire the plan onto the last
 *                                   user/assistant message's `details`.
 *   4. `checkEvidenceFreshness` — score every TaskState-tracked file.
 *   5. `annotateStaleness`      — prepend a freshness-warning custom
 *                                 message when the report has issues.
 *   6. `validateProviderProtocol` — fix provider-specific role rules
 *                                   (first-message-must-be-user, etc.).
 *
 * The returned `messages` array is what the provider adapter in
 * `packages/ai/src/api/` sees. `cachePlan` is the plan the F2 wire-in
 * attached (so per-position assertions can match it).
 *
 * Throws when the projection has no user/assistant message (the
 * adapter's fallback walker would handle that, but the deep-integration
 * tests want to assert the plan-attached path, so a missing anchor is
 * a hard error).
 */
export function buildF2Projection(options: BuildF2ProjectionOptions): F2ProjectionResult {
	const tokenBudget = 1_000_000; // Generous so the projection is never budget-trimmed.

	// 1. compileContext
	const compiled: CompiledContext = compileContext(options.conversation, options.taskState, {
		tokenBudget,
	});

	// 2. annotateCacheMarkers
	const annotated = annotateCacheMarkers(compiled, options.render);
	if (!annotated.cachePlan) {
		throw new Error("Expected annotateCacheMarkers to produce a cachePlan for this conversation shape");
	}

	// 3. attachCachePlanToMessages — the F2 wire-in
	const projected = attachCachePlanToMessages(annotated.messages, annotated.cachePlan);

	// 4. checkEvidenceFreshness
	const freshnessReport = checkEvidenceFreshness({
		taskState: options.taskState,
		latestHashes: options.latestHashes ?? new Map<string, string>(),
		...(options.now !== undefined ? { now: options.now } : {}),
	});

	// 5. annotateStaleness
	const annotatedFreshness = annotateStaleness(freshnessReport, { ...annotated, messages: projected });

	// 6. validateProviderProtocol — runs against the (possibly freshness-extended) projection
	const validation = validateProviderProtocol(annotatedFreshness, options.provider);

	return {
		messages: validation.context.messages,
		cachePlan: annotated.cachePlan,
		freshness: freshnessReport,
		validation,
		tokenBudget,
	};
}

