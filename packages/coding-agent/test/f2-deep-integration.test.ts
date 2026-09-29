/**
 * F2 deep integration — full pipeline.
 *
 * Exercises the complete F2 context-compiler pipeline in a single test:
 *
 *   1. `compileContext` (selection + dedup + budgeting)
 *   2. `annotateCacheMarkers` (stable/volatile split → 3-position CachePlan)
 *   3. `attachCachePlanToMessages` (wire the plan to the last user/assistant message)
 *   4. `checkEvidenceFreshness` (compare recorded file hashes vs. latest reads)
 *   5. `annotateStaleness` (prepend a freshness-warning custom message when stale)
 *   6. `validateProviderProtocol` (Anthropic alternating-roles / tool-result rules)
 *
 * The test seeds:
 *   - A `TaskState` with an objective, 2 active constraints, 1 decision,
 *     1 open hypothesis, 1 changedFile (with a content hash), and 1 failed
 *     verification.
 *   - A long conversation: 1 compaction entry + 20 user/assistant turns +
 *     15 tool results. Turn 0 has two consecutive identical tool results
 *     so `dedupeIdenticalToolResults` has something to drop.
 *   - A `latestHashes` map whose entry for the changed file does NOT match
 *     the recorded `contentHash`. The freshness check therefore reports
 *     the file as `stale` and `annotateStaleness` prepends a
 *     `freshness-warning` custom message at the head of the projection.
 *
 * `validateProviderProtocol("anthropic")` must report zero issues and zero
 * fixes because the projection, after staleness, still has alternating
 * user/assistant messages (the freshness-warning is a `custom` message
 * which the walker skips).
 *
 * Acceptance: every step's output is asserted on — message counts, the
 * cache plan shape, the freshness report, the staleness message, and the
 * provider-protocol verdict.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { annotateCacheMarkers, attachCachePlanToMessages, type CacheMarker } from "../src/core/cache-rendering.ts";
import { compileContext } from "../src/core/context-compiler.ts";
import { annotateStaleness, checkEvidenceFreshness } from "../src/core/evidence-freshness.ts";
import type { CustomMessage } from "../src/core/messages.ts";
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

/** Path recorded in `TaskState.changedFiles`. */
const FILE_PATH = "src/foo.ts";

/** Hash recorded in `TaskState.changedFiles[].contentHash`. */
const FILE_HASH_RECORDED = "hash-recorded-v1";

/**
 * Hash supplied by the F2 read-tool wire-in. Intentionally different from
 * the recorded hash so the freshness check reports the file as `stale`.
 */
const FILE_HASH_LATEST = "hash-latest-v2";

// ---- Message factories ----

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

// ---- TaskState builder ----

function buildTaskState(): TaskState {
	const now = 1_000_000;
	let state = createInitialTaskState("f2-deep-integration");
	state = { ...state, objective: { text: "Refactor the auth module to use JWT", createdAt: now } };
	state = addConstraint(state, { text: "No new npm dependencies", source: "user" });
	state = addConstraint(state, { text: "Keep the public API stable", source: "model" });
	state = recordDecision(state, {
		text: "Use JWT for authentication",
		rationale: "Stateless and widely supported",
	});
	state = {
		...state,
		hypotheses: [
			...state.hypotheses,
			{
				id: "hyp-1",
				text: "JWT works with the existing middleware",
				status: "open" as const,
				madeAt: now,
			},
		],
	};
	state = recordChange(state, { path: FILE_PATH, contentHash: FILE_HASH_RECORDED });
	state = recordVerification(state, { kind: "test", command: "npm test", passed: false });
	return state;
}

// ---- Conversation builder ----
//
// 1 compaction + 20 user/assistant turns + 15 tool results = 56 messages.
// Tool results are distributed so that every 4th turn (0, 4, 8, 12, 16)
// has 2 tool results, every other 2nd turn (2, 6, 10, 14, 18) has 1, and
// the remaining turns have 0. Turn 0's two tool results carry identical
// text so `dedupeIdenticalToolResults` drops the second.

const TOOL_RESULT_COUNTS: Record<number, number> = {
	0: 2,
	2: 1,
	4: 2,
	6: 1,
	8: 2,
	10: 1,
	12: 2,
	14: 1,
	16: 2,
	18: 1,
};

function buildConversation(): AgentMessage[] {
	const messages: AgentMessage[] = [];
	let ts = 1;

	for (let turn = 0; turn < 20; turn++) {
		const toolCount = TOOL_RESULT_COUNTS[turn] ?? 0;
		// Insert the compaction summary between iterations 12 and 13
		// so the compaction boundary lands inside the kept window
		// (turns 13..20 in `groupIntoTurns` ordering). The tool
		// results in the kept turns are then post-boundary, so the
		// boundary step does not drop them and the dedup pass gets to
		// see turn 16's two identical tool-result strings.
		if (turn === 13) {
			messages.push(
				makeCompaction(
					"Earlier discussion: explored OAuth, SAML, and JWT. Settled on JWT for the new auth flow.",
					ts++,
				),
			);
		}
		messages.push(
			makeUser(
				toolCount > 0 ? `Investigate auth options (turn ${turn})` : `Continue discussion (turn ${turn})`,
				ts++,
			),
		);
		if (toolCount === 0) {
			messages.push(makeAssistantText(`Let me think about this more. (reply ${turn})`, ts++));
			continue;
		}
		const toolId = `call-${turn}-a`;
		messages.push(makeAssistantWithToolCall(toolId, "bash", { command: "ls -la" }, ts++));
		for (let j = 0; j < toolCount; j++) {
			const resultId = j === 0 ? toolId : `call-${turn}-${String.fromCharCode(98 + j)}`;
			// Turn 16 is the second 2-tool-result turn in the kept
			// window (turns 13..20 in `groupIntoTurns` ordering), so the
			// dedup pass sees two consecutive identical tool-result
			// strings and drops the second copy.
			const text = turn === 16 ? "stale-content-same" : `tool output for turn ${turn} part ${j}`;
			messages.push(makeToolResult(resultId, "bash", text, ts++));
		}
		// Anthropic requires every toolResult to be followed by an
		// assistant message. Add a terminal assistant text after the
		// tool results so the walker sees a well-formed alternation.
		messages.push(makeAssistantText(`Let me think about this more. (reply ${turn})`, ts++));
	}

	return messages;
}

// ---- Helpers ----

/** Walk the projection in reverse and return the last `user` or `assistant` message. */
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

describe("F2 deep integration — full pipeline", () => {
	it("runs compileContext → annotateCacheMarkers → attachCachePlanToMessages → checkEvidenceFreshness → annotateStaleness → validateProviderProtocol in order", () => {
		const taskState = buildTaskState();
		const messages = buildConversation();

		// ---- Stage 1: compileContext ----
		const compiled = compileContext(messages, taskState, {
			tokenBudget: 5000,
			keepRecentTurns: 8,
			dedupeIdenticalToolResults: true,
			includeVerifications: true,
			includeConstraints: true,
		});

		// The four TaskState-injected custom messages (objective,
		// constraints, decisions-hypotheses, failed-verifications) are
		// always injected. The accounting reflects that.
		expect(compiled.accounting.taskStateInjectedMessages).toBe(4);

		// The turn-trim step drops the first 13 turns (compaction + turns
		// 1..12) because `keepRecentTurns: 8`; the latest compaction
		// summary is re-inserted at the head, so `droppedByBudget` covers
		// the dropped-turn messages.
		expect(compiled.accounting.droppedByBudget).toBeGreaterThan(0);
		// The dedup pass dropped exactly one tool result (the second of
		// turn 16's two identical tool results — turn 16 is the second
		// 2-tool-result turn in the kept window so the dedup pass gets
		// to see the consecutive identical pair).
		expect(compiled.accounting.droppedByDedup).toBe(1);

		// The compaction summary must be in the projection.
		expect(compiled.messages.some((m) => m.role === "compactionSummary")).toBe(true);

		// The TaskState-injected messages are at the head of the
		// projection, in the documented order, each with the right marker.
		const headSlots = compiled.messages.slice(0, 4);
		for (const m of headSlots) {
			expect(m.role).toBe("custom");
			expect((m as { customType?: string }).customType).toBe("task-state-context");
		}
		const headMarkers = headSlots.map((m) => (m as { details?: { marker?: string } }).details?.marker);
		expect(headMarkers).toEqual(["objective", "constraints", "decisions-hypotheses", "failed-verifications"]);

		// ---- Stage 2: annotateCacheMarkers ----
		const annotated = annotateCacheMarkers(compiled, {
			format: "anthropic",
			retention: "long",
			systemPrompt: true,
			lastTool: true,
			lastMessage: true,
		});

		expect(annotated.cachePlan).toBeDefined();
		const plan = annotated.cachePlan!;
		expect(plan.format).toBe("anthropic");
		expect(plan.retention).toBe("long");
		// All three positions enabled → three markers in the plan.
		expect(plan.markers).toHaveLength(3);
		const positions = plan.markers.map((m) => m.marker.position).sort();
		expect(positions).toEqual(["last-message", "last-tool", "system"]);
		// Anthropic format + long retention → every marker is `ephemeral`
		// with a `1h` TTL.
		for (const { marker } of plan.markers) {
			expect(marker.type).toBe("ephemeral");
			expect(marker.ttl).toBe("1h");
		}
		// The stable/volatile split accounts for the TaskState prefix
		// on the stable side.
		expect(plan.estimatedStablePrefixTokens).toBeGreaterThan(0);
		expect(plan.estimatedVolatileSuffixTokens).toBeGreaterThan(0);

		// The stable-side tokens equal the sum of tokens for the four
		// TaskState-injected messages; the volatile-side tokens cover
		// everything after the split (compaction + recent turns).
		const taskStateTokens = headSlots.reduce(
			(acc, m) =>
				acc +
				Math.ceil(
					(typeof (m as { content?: unknown }).content === "string"
						? ((m as { content: string }).content as string)
						: ""
					).length / 4,
				),
			0,
		);
		expect(plan.estimatedStablePrefixTokens).toBe(taskStateTokens);

		// The plan's `breakpoints` are the unique message indices.
		expect(plan.breakpoints).toHaveLength(new Set(plan.markers.map((m) => m.messageIndex)).size);

		// ---- Stage 3: attachCachePlanToMessages ----
		const withPlan = attachCachePlanToMessages(annotated.messages, plan);

		// The wire-in step returns a new array; the input is untouched.
		expect(withPlan).not.toBe(annotated.messages);
		expect(withPlan).toHaveLength(annotated.messages.length);

		// The plan is attached to the last user/assistant message's
		// `details.cachePlan` and merges the `last-message` marker into
		// that message's `details.cacheMarkers`.
		const lastUserOrAssistant = findLastUserOrAssistant(withPlan);
		expect(lastUserOrAssistant).toBeDefined();
		const lastDetails = (
			lastUserOrAssistant as AgentMessage & {
				details?: { cachePlan?: unknown; cacheMarkers?: CacheMarker[] };
			}
		).details;
		expect(lastDetails?.cachePlan).toBe(plan);
		const lastMarkers = (lastDetails?.cacheMarkers ?? []) as CacheMarker[];
		expect(lastMarkers.some((m) => m.position === "last-message")).toBe(true);

		// ---- Stage 4: checkEvidenceFreshness ----
		const latestHashes = new Map<string, string>();
		// Intentionally different from the recorded `FILE_HASH_RECORDED`
		// so the freshness check reports the file as `stale`.
		latestHashes.set(FILE_PATH, FILE_HASH_LATEST);
		const report = checkEvidenceFreshness({ taskState, latestHashes });
		expect(report.staleCount).toBe(1);
		expect(report.freshCount).toBe(0);
		expect(report.missingCount).toBe(0);
		expect(report.checks[0]?.path).toBe(FILE_PATH);
		expect(report.checks[0]?.expectedHash).toBe(FILE_HASH_RECORDED);
		expect(report.checks[0]?.actualHash).toBe(FILE_HASH_LATEST);
		expect(report.checks[0]?.status).toBe("stale");

		// ---- Stage 5: annotateStaleness ----
		const withStaleness = annotateStaleness(report, { ...annotated, messages: withPlan });

		// The freshness report is attached to the returned context.
		expect(withStaleness.freshness).toBe(report);
		// The stale report triggers a freshness-warning custom message
		// prepended at index 0. The projection gains one message.
		expect(withStaleness.messages).toHaveLength(withPlan.length + 1);
		const warning = withStaleness.messages[0] as CustomMessage<{ report: unknown; marker?: string }>;
		expect(warning.role).toBe("custom");
		expect(warning.customType).toBe("freshness-warning");
		expect(warning.display).toBe(false);
		// The body lists the affected file and its `stale` tag.
		const warningBody = typeof warning.content === "string" ? warning.content : "";
		expect(warningBody).toContain(FILE_PATH);
		expect(warningBody).toContain("stale");
		expect(warningBody).toContain("1 stale");
		// The freshness report is preserved on the custom message's
		// `details.report` for downstream consumers.
		const warningDetails = warning.details as { report: unknown; marker?: string } | undefined;
		expect(warningDetails?.report).toBe(report);

		// ---- Stage 6: validateProviderProtocol ----
		const validation = validateProviderProtocol(withStaleness, "anthropic");

		// The Anthropic walker skips `custom` messages, so prepending the
		// freshness-warning does not break the alternating user/assistant
		// sequence. Every toolResult is followed by an assistant message
		// in the conversation shape, so the projection is well-formed.
		expect(validation.ok).toBe(true);
		expect(validation.fixedCount).toBe(0);
		expect(validation.issues).toHaveLength(0);

		// ---- Final assertions on the projection ----
		const projection = validation.context.messages;

		// The freshness-warning is at the head, followed by the four
		// TaskState-injected messages, the compaction summary, and the
		// recent turns (in that order).
		expect((projection[0] as { customType?: string }).customType).toBe("freshness-warning");
		for (let i = 1; i <= 4; i++) {
			expect((projection[i] as { customType?: string }).customType).toBe("task-state-context");
		}
		// The compaction summary sits between the TaskState prefix and
		// the recent turns (it lives at turn 13 in `groupIntoTurns`
		// ordering, which is the head of the kept window). In the
		// post-staleness projection it is at index 5.
		expect(projection[5]?.role).toBe("compactionSummary");
		// From index 6 onward, the recent turns carry at least one
		// user/assistant message.
		const tail = projection.slice(6);
		expect(tail.some((m) => m.role === "user")).toBe(true);
		expect(tail.some((m) => m.role === "assistant")).toBe(true);

		// The cache plan is still attached to the last user/assistant
		// message (prepending the freshness warning shifted the array
		// index but the plan lives on the same message object).
		const lastAfterValidation = findLastUserOrAssistant(projection);
		expect(lastAfterValidation).toBeDefined();
		const lastAfterDetails = (
			lastAfterValidation as AgentMessage & {
				details?: { cachePlan?: unknown; cacheMarkers?: CacheMarker[] };
			}
		).details;
		expect(lastAfterDetails?.cachePlan).toBe(plan);
		const lastAfterMarkers = (lastAfterDetails?.cacheMarkers ?? []) as CacheMarker[];
		expect(lastAfterMarkers.some((m) => m.position === "last-message")).toBe(true);

		// The system marker points at the compaction (the first
		// non-TaskState message in the pre-staleness projection, at
		// index 4). The plan carries it; the compaction is a
		// `compactionSummary` so the message-level `details.cacheMarkers`
		// array is not the authoritative source for it.
		const systemMarker = plan.markers.find((m) => m.marker.position === "system");
		expect(systemMarker).toBeDefined();
		expect(systemMarker?.messageIndex).toBe(4);

		// The most recent N turns are present. The last user message in
		// the projection is the final user message from the kept turns
		// (turn 19's "Continue discussion (turn 19)").
		const userMessages = projection.filter((m) => m.role === "user");
		const lastUser = userMessages[userMessages.length - 1];
		expect((lastUser as UserMessage | undefined)?.content).toBe("Continue discussion (turn 19)");
	});
});

