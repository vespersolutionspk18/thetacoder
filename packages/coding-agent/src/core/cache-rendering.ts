/**
 * F2 stable rendering — cache marker annotation + wire-in attachment.
 *
 * The compiled projection has a natural stable/volatile split:
 *  - Stable: system prompt + tool definitions + TaskState-injected messages
 *  - Volatile: recent turns + tool results
 *
 * The audit identifies three breakpoints where provider-side automatic
 * prefix caching can place `cache_control` markers to reuse the stable
 * prefix across requests:
 *   1. `system`     — after the system/developer prompt
 *   2. `last-tool`  — after the last tool definition
 *   3. `last-message` — after the last user/assistant/tool text
 *
 * `annotateCacheMarkers` is the F2-side equivalent: it walks the compiled
 * `AgentMessage[]` projection produced by `compileContext`, decides where
 * each marker should go, and writes a `CachePlan` to the returned
 * `CompiledContext`. The plan carries:
 *   - the per-marker positions (`breakpoints` are message indices)
 *   - the marker metadata (`markers` is the same data, indexed)
 *   - the stable/volatile token split (`estimatedStablePrefixTokens` /
 *     `estimatedVolatileSuffixTokens`) computed with the same chars/4
 *     estimator as the compiler
 *
 * For messages that already have a `details` field (custom, toolResult),
 * `annotateCacheMarkers` writes the per-position markers into
 * `message.details.cacheMarkers`. For message types that do not carry a
 * `details` field (`user`, `assistant`, etc.) the top-level
 * `CompiledContext.cachePlan` is the authoritative source for the
 * adapter.
 *
 * `attachCachePlanToMessages` is the F2 wire-in step that runs after
 * `annotateCacheMarkers`. It walks the projection in reverse, finds the
 * last user/assistant message, and attaches the plan to its `details`
 * field so the provider adapters in `packages/ai/src/api/openai-completions.ts`
 * and `packages/ai/src/api/anthropic-messages.ts` can read it
 * structurally. The same pass also attaches per-position
 * `cacheMarkers` to user/assistant messages at the `system` and
 * `last-tool` positions so the adapter can use them directly without
 * re-deriving positions from the plan.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, TextContent, UserMessage } from "@theta/ai";
import type { CompiledContext } from "./context-compiler.ts";
import type { CustomMessage as CodingAgentCustomMessage } from "./messages.ts";

// =========================================================================
// Public types
// =========================================================================

/** Where a cache marker should be placed. Matches the audit's 3 breakpoints. */
export type CacheMarkerPosition = "system" | "last-tool" | "last-message";

/**
 * The cache marker type. Currently the only supported value is
 * `"ephemeral"` (Anthropic-style); a `ttl` of `"1h"` selects Anthropic's
 * 1-hour extended-cache retention when the provider supports it.
 */
export interface CacheMarker {
	position: CacheMarkerPosition;
	type: "ephemeral";
	/** Optional 1-hour extended-cache TTL (Anthropic-only). */
	ttl?: "1h";
}

/** Format the receiving provider speaks. */
export type CacheFormat = "anthropic" | "openai";

/** Cache retention tier. `"long"` opts into the 1-hour TTL where supported. */
export type CacheRetention = "short" | "long";

/** Knobs that control which breakpoints get markers and which TTL/format. */
export interface RenderCacheOptions {
	/** Provider format. Anthropic supports `ttl`; OpenAI ignores it. */
	format: CacheFormat;
	/** Retention tier. `"long"` adds `ttl: "1h"`; `"short"` omits `ttl`. */
	retention: CacheRetention;
	/** Whether to mark the system/developer prompt breakpoint. */
	systemPrompt: boolean;
	/** Whether to mark the last-tool-definition breakpoint. */
	lastTool: boolean;
	/** Whether to mark the last user/assistant/tool text breakpoint. */
	lastMessage: boolean;
	/**
	 * Token estimator. Input is the concatenated text of a message; output
	 * is the estimated token count. Defaults to chars/4 (rounded up), the
	 * same default as `compileContext`.
	 */
	estimator?: (text: string) => number;
}

/**
 * The plan describing the cache markers and the stable/volatile token split.
 * Attached to the returned `CompiledContext` as `cachePlan` so the provider
 * adapter (and tests) can read it without inspecting every message.
 */
export interface CachePlan {
	/** Indices into `CompiledContext.messages` for each placed marker. */
	breakpoints: number[];
	/** Stable-side token estimate (system-equivalent + TaskState context). */
	estimatedStablePrefixTokens: number;
	/** Volatile-side token estimate (everything after the stable region). */
	estimatedVolatileSuffixTokens: number;
	/** Markers parallel to `breakpoints` — same length, same order. */
	markers: Array<{ messageIndex: number; marker: CacheMarker }>;
	/** Format / retention echo so the adapter does not need to re-derive them. */
	format: CacheFormat;
	retention: CacheRetention;
}

// =========================================================================
// Internal helpers
// =========================================================================

/** Default estimator: ~4 characters per token, rounded up to keep an integer. */
function defaultEstimator(text: string): number {
	if (text.length === 0) return 0;
	return Math.ceil(text.length / 4);
}

/** Plain-text representation of a single message for token estimation. */
function messageToText(message: AgentMessage): string {
	switch (message.role) {
		case "user":
			return userMessageText(message);
		case "assistant":
			return assistantMessageText(message);
		case "toolResult":
			return contentArrayText(message.content);
		case "compactionSummary":
			return message.summary;
		case "branchSummary":
			return message.summary;
		case "bashExecution":
			return `${message.command}\n${message.output}`;
		case "custom":
			return typeof message.content === "string" ? message.content : contentArrayText(message.content);
		default: {
			const _exhaustive: never = message;
			return "";
		}
	}
}

function userMessageText(message: UserMessage): string {
	return typeof message.content === "string" ? message.content : contentArrayText(message.content);
}

function assistantMessageText(message: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "thinking") parts.push(block.thinking);
		else if (block.type === "toolCall") {
			parts.push(block.name);
			try {
				parts.push(JSON.stringify(block.arguments));
			} catch {
				parts.push("[unserializable tool args]");
			}
		}
	}
	return parts.join("\n");
}

function contentArrayText(content: (TextContent | { type: "image"; data: string; mimeType: string })[]): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join("\n");
}

/**
 * Returns true if the message is a TaskState-injected context message —
 * these are the `custom` messages with `customType: "task-state-context"`
 * that `compileContext` prepends to the projection. They live on the
 * stable side of the split.
 */
function isTaskStateContextMessage(message: AgentMessage): boolean {
	return message.role === "custom" && (message as CodingAgentCustomMessage).customType === "task-state-context";
}

/**
 * Returns true if the assistant message contains at least one tool call.
 * The "last-tool" marker is best placed on the last assistant message
 * that emits tool calls, because that is the message immediately after
 * which the tool definitions will be re-evaluated in the provider wire
 * format (in a request where the tool list is rebuilt from the active
 * set, this is the last conversational point before the tool list ends).
 */
function isAssistantWithToolCall(message: AgentMessage): boolean {
	if (message.role !== "assistant") return false;
	return message.content.some((block) => block.type === "toolCall");
}

/**
 * Returns true if the message carries a "last-message" cache position
 * candidate: a user, assistant (with text or tool calls), or tool result.
 * These are the message types the audit considers for the final
 * `last-message` breakpoint.
 */
function isLastMessageCandidate(message: AgentMessage): boolean {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

/**
 * Build the per-marker `CacheMarker` value for a given position,
 * applying format/retention rules:
 *  - `format: "openai"` is accepted but currently equivalent to
 *    `"anthropic"` (Anthropic is the only provider that uses `ttl`).
 *  - `retention: "long"` adds `ttl: "1h"`; `"short"` omits it.
 */
function buildMarker(position: CacheMarkerPosition, options: RenderCacheOptions): CacheMarker {
	const marker: CacheMarker = { position, type: "ephemeral" };
	if (options.retention === "long") {
		marker.ttl = "1h";
	}
	return marker;
}

/**
 * Find the first message index at or after `fromIndex` that satisfies
 * `predicate`, or `-1` if none.
 */
function findIndex(messages: AgentMessage[], fromIndex: number, predicate: (m: AgentMessage) => boolean): number {
	for (let i = fromIndex; i < messages.length; i++) {
		if (predicate(messages[i]!)) return i;
	}
	return -1;
}

/**
 * Find the last message index at or before `fromIndex` that satisfies
 * `predicate`, or `-1` if none. Walks backwards.
 */
function findLastIndex(messages: AgentMessage[], fromIndex: number, predicate: (m: AgentMessage) => boolean): number {
	for (let i = fromIndex; i >= 0; i--) {
		if (predicate(messages[i]!)) return i;
	}
	return -1;
}

/**
 * Mutate `message.details` to record a `cacheMarkers` array, if the
 * message has a `details` field. For message types that do not carry a
 * `details` field (e.g. `user`, `assistant`), this is a no-op — those
 * messages are reachable only via the top-level `cachePlan`.
 */
function attachMarkersToMessage(message: AgentMessage, markers: CacheMarker[]): void {
	if (message.role === "custom" || message.role === "toolResult") {
		const withDetails = message as CodingAgentCustomMessage | (AgentMessage & { details?: Record<string, unknown> });
		const existing = (withDetails.details ?? {}) as Record<string, unknown>;
		const priorMarkers = Array.isArray(existing.cacheMarkers) ? (existing.cacheMarkers as CacheMarker[]) : [];
		withDetails.details = { ...existing, cacheMarkers: [...priorMarkers, ...markers] };
	}
}

/**
 * Structural shape of a message that may carry a `details` field. The
 * agent core's `UserMessage` and `AssistantMessage` do not declare a
 * `details` field at the type level, but at runtime the projection can
 * carry one (the F2 wire-in attaches the cache plan there so the provider
 * adapter can read it structurally). We use this cast at the
 * `AgentMessage` boundary instead of importing a `details` type from
 * `@theta/ai`, keeping the `packages/coding-agent` → `packages/ai`
 * import direction one-way.
 */
type AgentMessageWithDetails = AgentMessage & { details?: Record<string, unknown> };

/**
 * Read the existing `cacheMarkers` array from a message's `details`
 * field, or an empty array when the field is absent or not an array.
 */
function readExistingMarkers(message: AgentMessage): CacheMarker[] {
	const withDetails = message as AgentMessageWithDetails;
	const raw = withDetails.details?.cacheMarkers;
	return Array.isArray(raw) ? (raw as CacheMarker[]) : [];
}

// =========================================================================
// Public entry point
// =========================================================================

/**
 * Annotate a compiled projection with cache markers.
 *
 * Walks `context.messages` and decides where to place each enabled
 * marker. The returned `CompiledContext` carries a `cachePlan` field
 * with the per-marker positions and the stable/volatile token split.
 * Markers are also written to `message.details.cacheMarkers` for
 * messages that support a `details` field.
 *
 * Stable/volatile split: every TaskState-injected message is on the
 * stable side, everything else is on the volatile side. The split index
 * is the first non-TaskState message (or `context.messages.length` if
 * all messages are TaskState-injected).
 *
 * Marker placement:
 *   - `system`     → first non-TaskState message (or message 0 if none)
 *   - `last-tool`  → first assistant-with-tool-calls message
 *                    (falls back to the first non-TaskState message)
 *   - `last-message` → last user/assistant/toolResult message
 */
export function annotateCacheMarkers(context: CompiledContext, options: RenderCacheOptions): CompiledContext {
	const estimator = options.estimator ?? defaultEstimator;
	const messages = context.messages;

	// ---- Compute the stable/volatile split ----
	// Stable region: every leading run of TaskState-injected messages.
	// The split index is the first non-TaskState message, or the end of
	// the array if every message is TaskState-injected.
	let splitIndex = messages.length;
	for (let i = 0; i < messages.length; i++) {
		if (!isTaskStateContextMessage(messages[i]!)) {
			splitIndex = i;
			break;
		}
	}

	// ---- Token estimates ----
	let stableTokens = 0;
	let volatileTokens = 0;
	for (let i = 0; i < messages.length; i++) {
		const tokens = estimator(messageToText(messages[i]!));
		if (i < splitIndex) {
			stableTokens += tokens;
		} else {
			volatileTokens += tokens;
		}
	}

	// ---- Marker placement ----
	// `system`     → first message at or after the split (the "first
	//                non-TaskState message"). If the projection is all
	//                TaskState messages, fall back to message 0.
	// `last-tool`  → first assistant message with tool calls at or after
	//                the split. Fall back to the system marker position
	//                when there are no tool-call messages.
	// `last-message` → last user/assistant/toolResult message. If the
	//                projection has none (only TaskState / custom), fall
	//                back to the last message in the projection.
	const systemIdx = splitIndex < messages.length ? splitIndex : messages.length > 0 ? 0 : -1;
	const firstToolIdx = findIndex(messages, splitIndex, isAssistantWithToolCall);
	const lastToolIdx = firstToolIdx >= 0 ? firstToolIdx : systemIdx;
	const lastMessageIdx = findLastIndex(messages, messages.length - 1, isLastMessageCandidate);

	const planned: Array<{ messageIndex: number; marker: CacheMarker }> = [];

	if (options.systemPrompt && systemIdx >= 0) {
		planned.push({ messageIndex: systemIdx, marker: buildMarker("system", options) });
	}
	if (options.lastTool && lastToolIdx >= 0) {
		planned.push({ messageIndex: lastToolIdx, marker: buildMarker("last-tool", options) });
	}
	if (options.lastMessage && lastMessageIdx >= 0) {
		planned.push({ messageIndex: lastMessageIdx, marker: buildMarker("last-message", options) });
	}

	// Deduplicate (when two or more markers land on the same message, the
	// message-level `details.cacheMarkers` array still needs to record
	// every marker, but the top-level `breakpoints` array is the set of
	// unique positions). Order is preserved on first occurrence.
	const seenIndices = new Set<number>();
	const breakpoints: number[] = [];
	for (const { messageIndex } of planned) {
		if (!seenIndices.has(messageIndex)) {
			seenIndices.add(messageIndex);
			breakpoints.push(messageIndex);
		}
	}

	// Group markers by message index so the per-message mutation adds the
	// right set in one shot.
	const byIndex = new Map<number, CacheMarker[]>();
	for (const { messageIndex, marker } of planned) {
		const list = byIndex.get(messageIndex);
		if (list) {
			list.push(marker);
		} else {
			byIndex.set(messageIndex, [marker]);
		}
	}

	// ---- Build the annotated messages ----
	// Copy the array so the input `context.messages` is not mutated.
	const annotatedMessages: AgentMessage[] = messages.map((m, i) => {
		const markers = byIndex.get(i);
		if (!markers || markers.length === 0) return m;
		// We must produce a new object so we do not mutate the input.
		const copy = { ...m } as AgentMessage;
		attachMarkersToMessage(copy, markers);
		return copy;
	});

	const cachePlan: CachePlan = {
		breakpoints,
		estimatedStablePrefixTokens: stableTokens,
		estimatedVolatileSuffixTokens: volatileTokens,
		markers: planned,
		format: options.format,
		retention: options.retention,
	};

	return {
		...context,
		messages: annotatedMessages,
		cachePlan,
	};
}

// =========================================================================
// F2 wire-in helper
// =========================================================================

/**
 * Attach a `CachePlan` to the last user/assistant message of the
 * projection so the provider adapter (in `packages/ai/src/api/`) can
 * honour it on the wire. The provider adapter reads the plan
 * structurally from `message.details.cachePlan`; the agent core's
 * `UserMessage` and `AssistantMessage` do not declare a `details` field
 * at the type level, so we attach it via a structural cast.
 *
 * Behaviour:
 *  - Walks `messages` in reverse and finds the last message whose role
 *    is `"user"` or `"assistant"`. Tool results, custom messages, and
 *    other roles are skipped (the provider adapter scans for the same
 *    user/assistant pair).
 *  - On that message, sets `details = { ...(details ?? {}), cachePlan,
 *    cacheMarkers: [...existingMarkers, ...lastMessageMarkers] }`. Any
 *    prior `cacheMarkers` are preserved.
 *  - For every other marker in the plan (the `system` and `last-tool`
 *    positions), if the message at `marker.messageIndex` is a
 *    `user`/`assistant` message, also attaches per-position
 *    `cacheMarkers` to it. `custom` and `toolResult` messages are
 *    already annotated by `annotateCacheMarkers` and are left alone
 *    here — we only fill the user/assistant gap.
 *  - Returns a new array; the input is not mutated.
 *  - When no user/assistant message exists in the projection, the
 *    original array is returned unchanged (the adapter's fallback
 *    walker handles the empty case).
 *
 * The function is the F2 wire-in side of the cache-rendering pipeline.
 * It is intentionally not called from `annotateCacheMarkers` so the
 * F2 stable/volatile split logic stays free of any provider-adapter
 * coupling — the higher-level `sdk.ts` wire-in layer calls it
 * immediately after `annotateCacheMarkers` so the returned `CompiledContext`
 * is the single source of truth for the next provider request.
 */
export function attachCachePlanToMessages(messages: AgentMessage[], plan: CachePlan): AgentMessage[] {
	if (messages.length === 0) return messages;

	// Copy the array first; we may not need to replace any element, but
	// the projection is shared with the caller so we must never mutate
	// in place.
	const result = messages.slice();

	// ---- Per-position markers on user/assistant messages ----
	// `custom` and `toolResult` messages are already annotated by
	// `annotateCacheMarkers`; the only gap is `user` and `assistant`.
	// We skip the `last-message` position here because that
	// attachment happens in the dedicated pass below (the last-message
	// message may also be the `system` or `last-tool` message when
	// those positions coincide, and we want the cachePlan alongside
	// the markers in that case).
	const lastMessageMarkers = plan.markers.filter((m) => m.marker.position === "last-message").map((m) => m.marker);
	const otherMarkersByIndex = new Map<number, CacheMarker[]>();
	for (const { messageIndex, marker } of plan.markers) {
		if (marker.position === "last-message") continue;
		const existing = otherMarkersByIndex.get(messageIndex);
		if (existing) {
			existing.push(marker);
		} else {
			otherMarkersByIndex.set(messageIndex, [marker]);
		}
	}
	for (const [idx, markers] of otherMarkersByIndex) {
		const current = result[idx];
		if (!current) continue;
		if (current.role !== "user" && current.role !== "assistant") continue;
		const copy = { ...current } as AgentMessageWithDetails;
		const existing = (copy.details ?? {}) as Record<string, unknown>;
		const priorMarkers = Array.isArray(existing.cacheMarkers) ? (existing.cacheMarkers as CacheMarker[]) : [];
		copy.details = { ...existing, cacheMarkers: [...priorMarkers, ...markers] };
		result[idx] = copy as AgentMessage;
	}

	// ---- Attach the plan to the last user/assistant message ----
	for (let i = result.length - 1; i >= 0; i--) {
		const current = result[i];
		if (!current) break;
		if (current.role !== "user" && current.role !== "assistant") continue;
		const copy = { ...current } as AgentMessageWithDetails;
		const existing = (copy.details ?? {}) as Record<string, unknown>;
		const priorMarkers = readExistingMarkers(copy as AgentMessage);
		copy.details = {
			...existing,
			cachePlan: plan,
			cacheMarkers: [...priorMarkers, ...lastMessageMarkers],
		};
		result[i] = copy as AgentMessage;
		return result;
	}

	// No user/assistant message found; return the per-position-marker
	// annotations (if any) without a cachePlan attachment. The adapter
	// falls back to the positional walker in this case.
	return result;
}

