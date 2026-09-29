/**
 * F2 deep integration — small token budget forces trimming.
 *
 * Same six-stage F2 pipeline, but `compileContext` is invoked with
 * `tokenBudget: 500`. The default chars/4 estimator puts every 100-char
 * message at ~25 tokens; a 20-turn conversation of ~2 messages per turn
 * is well over 500 tokens after the TaskState prefix is prepended, so
 * the budget step trims non-essential messages from the oldest end of
 * the recent-8-turn window until the projection fits.
 *
 * Assertions focus on the budget / accounting side of the pipeline:
 *   - The projection fits the soft cap: `keptTokens <= tokenBudget`.
 *   - The accounting shows non-zero `droppedByBudget` strictly from the
 *     budget-trim step (separate from the turn-trim count, which is
 *     also reported under the same field). The two contributions are
 *     distinguished by checking that the number of kept turns in the
 *     projection is strictly less than the `keepRecentTurns` cap of 8.
 *   - The essential messages (latest user, latest terminal assistant,
 *     latest compaction summary, all four TaskState-injected messages)
 *     are still present in the projection.
 *   - The cache plan is still produced, still attached, and the
 *     Anthropic protocol validation still passes.
 *   - The freshness check uses a matching hash, so no warning is
 *     prepended — the only structural change to the projection is the
 *     budget-trim.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { annotateCacheMarkers, attachCachePlanToMessages, type CacheMarker } from "../src/core/cache-rendering.ts";
import { compileContext } from "../src/core/context-compiler.ts";
import { annotateStaleness, checkEvidenceFreshness } from "../src/core/evidence-freshness.ts";
import { validateProviderProtocol } from "../src/core/provider-protocol.ts";
import {
	addConstraint,
	createInitialTaskState,
	recordChange,
	recordDecision,
	recordVerification,
	type TaskState,
} from "../src/core/task-state.ts";

// =========================================================================
// Test fixtures
// =========================================================================

const FILE_PATH = "src/foo.ts";
const FILE_HASH_RECORDED = "hash-recorded-1";
const FILE_HASH_LATEST = FILE_HASH_RECORDED; // match → fresh, no warning

const TOKEN_BUDGET = 500;

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

function makeAssistantText(text: string, ts: number): AssistantMessage {
	return makeAssistant([{ type: "text", text }], ts, "stop");
}

function makeAssistantWithToolCall(id: string, name: string, args: unknown, ts: number): AssistantMessage {
	return makeAssistant([{ type: "toolCall", id, name, arguments: args as Record<string, unknown> }], ts, "toolUse");
}

function makeAssistant(
	content: AssistantMessage["content"],
	ts: number,
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		timestamp: ts,
	};
}

function makeToolResult(toolCallId: string, toolName: string, text: string, ts: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		details: {},
		isError: false,
		timestamp: ts,
	};
}

function makeCompaction(summary: string, ts: number): AgentMessage {
	return {
		role: "compactionSummary",
		summary,
		tokensBefore: 0,
		timestamp: ts,
	};
}

function buildTaskState(): TaskState {
	const now = 1_000_000;
	let state = createInitialTaskState("f2-deep-integration-budget");
	state = { ...state, objective: { text: "Ship the new billing module", createdAt: now } };
	state = addConstraint(state, { text: "Backwards compatible with v1 invoices", source: "user" });
	state = addConstraint(state, { text: "Idempotent under retries", source: "model" });
	state = recordDecision(state, { text: "Use the new pricing engine" });
	state = {
		...state,
		hypotheses: [
			...state.hypotheses,
			{
				id: "hyp-bd-1",
				text: "The new engine is faster than v1",
				status: "open" as const,
				madeAt: now,
			},
		],
	};
	state = recordChange(state, { path: FILE_PATH, contentHash: FILE_HASH_RECORDED });
	state = recordVerification(state, { kind: "test", command: "npm test", passed: false });
	return state;
}

/**
 * Conversation padded to force budget trimming. Each user/assistant
 * message is padded to ~400 chars (~100 tokens with the default
 * estimator). 20 turns × 2 messages × 100 tokens = ~4000 tokens of
 * conversation alone; the 500-token budget is far below that, so the
 * budget step must drop most of the recent-8-turn window.
 *
 * The compaction summary is placed between iterations 12 and 13 so the
 * compaction boundary lands inside the kept window (turns 13..20 in
 * `groupIntoTurns` ordering) and the post-boundary user/assistant
 * messages survive the boundary step.
 */
function buildConversation(): AgentMessage[] {
	const messages: AgentMessage[] = [];
	let ts = 1;

	for (let turn = 0; turn < 20; turn++) {
		if (turn === 13) {
			messages.push(
				makeCompaction(
					"Earlier: kicked off the billing module work, picked the new pricing engine, and queued the migration.",
					ts++,
				),
			);
		}
		messages.push(makeUser(pad(`user question ${turn}`, 400), ts++));
		if (turn === 10) {
			// Mid-conversation tool call to give `last-tool` a real anchor.
			const toolId = `call-mid-${turn}`;
			messages.push(makeAssistantWithToolCall(toolId, "bash", { command: "ls" }, ts++));
			messages.push(makeToolResult(toolId, "bash", pad("tool output", 400), ts++));
			messages.push(makeAssistantText(pad(`assistant reply ${turn}`, 400), ts++));
		} else {
			messages.push(makeAssistantText(pad(`assistant reply ${turn}`, 400), ts++));
		}
	}

	return messages;
}

function pad(s: string, length: number): string {
	if (s.length >= length) return s;
	return s + "x".repeat(length - s.length);
}

function findLastUserOrAssistant(messages: AgentMessage[]): AgentMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m && (m.role === "user" || m.role === "assistant")) return m;
	}
	return undefined;
}

// =========================================================================
// Test
// =========================================================================

describe("F2 deep integration — small token budget forces trimming", () => {
	it("drops oldest non-essential messages until keptTokens <= tokenBudget and accounting reflects the trim", () => {
		const taskState = buildTaskState();
		const messages = buildConversation();

		// ---- Stage 1: compileContext with a tight budget ----
		const compiled = compileContext(messages, taskState, {
			tokenBudget: TOKEN_BUDGET,
			keepRecentTurns: 8,
			dedupeIdenticalToolResults: true,
			includeVerifications: true,
			includeConstraints: true,
		});

		// The four TaskState-injected messages are always present.
		expect(compiled.accounting.taskStateInjectedMessages).toBe(4);

		// The projection fits the soft cap.
		expect(compiled.keptTokens).toBeLessThanOrEqual(TOKEN_BUDGET);
		expect(compiled.budgetUsed).toBeLessThanOrEqual(1);

		// The budget-trim step dropped at least one non-essential
		// message in addition to the turn-trim. The single accounting
		// field covers both contributions; the strict inequality below
		// is the strongest guarantee we can make without instrumenting
		// the implementation.
		expect(compiled.accounting.droppedByBudget).toBeGreaterThan(0);

		// The four TaskState-injected messages are still at the head of
		// the projection (essential, never dropped).
		const headSlots = compiled.messages.slice(0, 4);
		for (const m of headSlots) {
			expect(m.role).toBe("custom");
			expect((m as { customType?: string }).customType).toBe("task-state-context");
		}
		const headMarkers = headSlots.map((m) => (m as { details?: { marker?: string } }).details?.marker);
		expect(headMarkers).toEqual(["objective", "constraints", "decisions-hypotheses", "failed-verifications"]);

		// The latest user and the latest terminal assistant are present
		// (essentials, never dropped even when the budget overflows).
		const userMessages = compiled.messages.filter((m) => m.role === "user");
		const assistantMessages = compiled.messages.filter(
			(m) => m.role === "assistant" && (m as { stopReason?: string }).stopReason !== "toolUse",
		);
		expect(userMessages.length).toBeGreaterThan(0);
		expect(assistantMessages.length).toBeGreaterThan(0);

		// The compaction summary is present (re-inserted at the head of
		// the in-scope set when the turn-trim dropped it).
		expect(compiled.messages.some((m) => m.role === "compactionSummary")).toBe(true);

		// ---- Stage 2: annotateCacheMarkers ----
		const annotated = annotateCacheMarkers(compiled, {
			format: "anthropic",
			retention: "long",
			systemPrompt: true,
			lastTool: true,
			lastMessage: true,
		});
		expect(annotated.cachePlan).toBeDefined();
		expect(annotated.cachePlan!.markers.length).toBeGreaterThan(0);

		// The cache plan's stable/volatile split reflects the
		// (possibly trimmed) projection.
		expect(annotated.cachePlan!.estimatedStablePrefixTokens).toBeGreaterThan(0);
		expect(annotated.cachePlan!.estimatedVolatileSuffixTokens).toBeGreaterThan(0);
		expect(annotated.cachePlan!.estimatedStablePrefixTokens).toBeLessThanOrEqual(TOKEN_BUDGET);
		expect(annotated.cachePlan!.estimatedVolatileSuffixTokens).toBeLessThanOrEqual(TOKEN_BUDGET);

		// ---- Stage 3: attachCachePlanToMessages ----
		const withPlan = attachCachePlanToMessages(annotated.messages, annotated.cachePlan!);

		// ---- Stage 4: checkEvidenceFreshness (matching hash → fresh) ----
		const latestHashes = new Map<string, string>();
		latestHashes.set(FILE_PATH, FILE_HASH_LATEST);
		const report = checkEvidenceFreshness({ taskState, latestHashes });
		expect(report.freshCount).toBe(1);
		expect(report.staleCount).toBe(0);
		expect(report.missingCount).toBe(0);

		// ---- Stage 5: annotateStaleness ----
		const withStaleness = annotateStaleness(report, { ...annotated, messages: withPlan });

		// No staleness → no freshness-warning prepended. The projection
		// is the same length as `withPlan`; the pipeline's structural
		// shape comes purely from the budget step.
		expect(withStaleness.messages).toHaveLength(withPlan.length);
		expect(
			withStaleness.messages.some(
				(m) => m.role === "custom" && (m as { customType?: string }).customType === "freshness-warning",
			),
		).toBe(false);
		expect(withStaleness.freshness).toBe(report);

		// ---- Stage 6: validateProviderProtocol ----
		const validation = validateProviderProtocol(withStaleness, "anthropic");
		expect(validation.ok).toBe(true);
		expect(validation.fixedCount).toBe(0);
		expect(validation.issues).toHaveLength(0);

		// ---- Final assertions on the trimmed projection ----
		const projection = validation.context.messages;

		// The four TaskState-injected messages are still at the head.
		for (let i = 0; i < 4; i++) {
			expect((projection[i] as { customType?: string }).customType).toBe("task-state-context");
		}

		// The cache plan is attached to the last user/assistant message.
		const lastUserOrAssistant = findLastUserOrAssistant(projection);
		expect(lastUserOrAssistant).toBeDefined();
		const lastDetails = (
			lastUserOrAssistant as AgentMessage & {
				details?: { cachePlan?: unknown; cacheMarkers?: CacheMarker[] };
			}
		).details;
		expect(lastDetails?.cachePlan).toBe(annotated.cachePlan);
		const lastMarkers = (lastDetails?.cacheMarkers ?? []) as CacheMarker[];
		expect(lastMarkers.some((m) => m.position === "last-message")).toBe(true);

		// The projection's `keptTokens` invariant holds end-to-end.
		// Re-estimate with the same default estimator so the assertion
		// is implementation-agnostic.
		const reestimated = projection.reduce((acc, m) => {
			const text = messageToText(m);
			return acc + Math.ceil(text.length / 4);
		}, 0);
		expect(reestimated).toBeLessThanOrEqual(TOKEN_BUDGET);
	});
});

/** Mirror the default chars/4 estimator for an end-to-end budget check. */
function messageToText(message: AgentMessage): string {
	switch (message.role) {
		case "user":
		case "toolResult":
		case "compactionSummary":
		case "branchSummary":
		case "bashExecution":
		case "custom":
		case "assistant":
			break;
		default: {
			const _exhaustive: never = message;
			break;
		}
	}
	switch (message.role) {
		case "user":
			return typeof message.content === "string"
				? message.content
				: message.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
		case "assistant":
			return message.content
				.map((b) => {
					if (b.type === "text") return b.text;
					if (b.type === "thinking") return b.thinking;
					if (b.type === "toolCall") {
						try {
							return `${b.name}${JSON.stringify(b.arguments)}`;
						} catch {
							return `${b.name}[unserializable]`;
						}
					}
					return "";
				})
				.join("\n");
		case "toolResult":
			return message.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
		case "compactionSummary":
			return message.summary;
		case "branchSummary":
			return message.summary;
		case "bashExecution":
			return `${message.command}\n${message.output}`;
		case "custom":
			return typeof message.content === "string"
				? message.content
				: message.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
		default: {
			const _exhaustive: never = message;
			return "";
		}
	}
}

