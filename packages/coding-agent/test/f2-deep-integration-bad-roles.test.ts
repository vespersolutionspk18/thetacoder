/**
 * F2 deep integration — Anthropic alternating-roles violation.
 *
 * Same six-stage F2 pipeline, but the conversation ends with two
 * consecutive user messages (no assistant turn between them). Anthropic
 * requires strictly alternating user/assistant messages, so the
 * `validateProviderProtocol("anthropic")` walker must:
 *   1. Detect the alternation break.
 *   2. Insert a synthetic assistant bridge with
 *      `customType: "synthetic-bridge"`, `details.synthetic: true`,
 *      `details.rule: "alternating-roles"`, and
 *      `details.targetRole: "assistant"`.
 *   3. Report the issue as an `error` (so `ok === false`).
 *
 * The freshness check uses a matching hash so no freshness-warning is
 * prepended; the synthetic bridge is the only structural change the
 * validator introduces.
 *
 * Assertions focus on:
 *   - The synthetic-bridge message exists in the post-validation
 *     projection at the right slot, with the right `customType` /
 *     `details` payload.
 *   - The `issues` list has the right count and severity.
 *   - The cache plan is still attached to the last user/assistant
 *     message; the validator does not strip the plan.
 *   - `ok === false` because at least one `error` issue is present.
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

const FILE_PATH = "src/foo.ts";
const FILE_HASH_RECORDED = "hash-recorded-1";
const FILE_HASH_LATEST = FILE_HASH_RECORDED; // match → no freshness warning

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

function makeAssistantText(text: string, ts: number): AssistantMessage {
	return makeAssistant([{ type: "text", text }], ts, "stop");
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
	let state = createInitialTaskState("f2-deep-integration-bad-roles");
	state = { ...state, objective: { text: "Re-key the production database", createdAt: now } };
	state = addConstraint(state, { text: "Coordinate with on-call before any change", source: "user" });
	state = addConstraint(state, { text: "Take a snapshot first", source: "user" });
	state = recordDecision(state, { text: "Run the re-key during the maintenance window" });
	state = {
		...state,
		hypotheses: [
			...state.hypotheses,
			{
				id: "hyp-br-1",
				text: "The migration is reversible",
				status: "open" as const,
				madeAt: now,
			},
		],
	};
	state = recordChange(state, { path: FILE_PATH, contentHash: FILE_HASH_RECORDED });
	state = recordVerification(state, { kind: "manual", passed: false });
	return state;
}

/**
 * Conversation with two trailing user messages — a violation of the
 * Anthropic alternating-roles rule. The first trailing user is the
 * latest terminal assistant's follow-up; the second trailing user is a
 * queued steering message the agent has not yet answered.
 */
function buildConversation(): AgentMessage[] {
	const messages: AgentMessage[] = [];
	let ts = 1;

	messages.push(makeCompaction("Earlier: planned the maintenance window.", ts++));

	for (let turn = 0; turn < 3; turn++) {
		messages.push(makeUser(`User question ${turn}`, ts++));
		messages.push(makeAssistantText(`Assistant answer ${turn}`, ts++));
	}

	// Two consecutive user messages at the end — the violation.
	messages.push(makeUser("Also, please confirm the snapshot is uploaded.", ts++));
	messages.push(makeUser("And reschedule the runbook review.", ts++));

	return messages;
}

function findLastUserOrAssistant(messages: AgentMessage[]): AgentMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m && (m.role === "user" || m.role === "assistant")) return m;
	}
	return undefined;
}

/** Return the wire-format role for `m`: user/assistant pass through, custom bridges use `details.targetRole`. */
function wireRole(m: AgentMessage): string {
	if (m.role === "user" || m.role === "assistant") return m.role;
	if (m.role === "custom") {
		const d = (m as { details?: { targetRole?: string } }).details;
		return d?.targetRole ?? "custom";
	}
	return m.role;
}

// =========================================================================
// Test
// =========================================================================

describe("F2 deep integration — Anthropic alternating-roles violation", () => {
	it("inserts a synthetic assistant bridge between consecutive user messages and reports the issue", () => {
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
		expect(compiled.accounting.taskStateInjectedMessages).toBe(4);

		// ---- Stage 2: annotateCacheMarkers ----
		const annotated = annotateCacheMarkers(compiled, {
			format: "anthropic",
			retention: "long",
			systemPrompt: true,
			lastTool: true,
			lastMessage: true,
		});
		expect(annotated.cachePlan).toBeDefined();

		// ---- Stage 3: attachCachePlanToMessages ----
		const withPlan = attachCachePlanToMessages(annotated.messages, annotated.cachePlan!);

		// ---- Stage 4: checkEvidenceFreshness (matching hash → fresh, no warning) ----
		const latestHashes = new Map<string, string>();
		latestHashes.set(FILE_PATH, FILE_HASH_LATEST);
		const report = checkEvidenceFreshness({ taskState, latestHashes });
		expect(report.freshCount).toBe(1);
		expect(report.staleCount).toBe(0);
		expect(report.missingCount).toBe(0);

		// ---- Stage 5: annotateStaleness ----
		const withStaleness = annotateStaleness(report, { ...annotated, messages: withPlan });

		// No staleness issues → no freshness-warning is prepended.
		expect(
			withStaleness.messages.some(
				(m) => m.role === "custom" && (m as { customType?: string }).customType === "freshness-warning",
			),
		).toBe(false);
		expect(withStaleness.messages).toHaveLength(withPlan.length);

		// ---- Stage 6: validateProviderProtocol ----
		const validation = validateProviderProtocol(withStaleness, "anthropic");

		// The Anthropic walker detects the alternation break and
		// inserts a synthetic assistant bridge between the two trailing
		// user messages.
		expect(validation.fixedCount).toBe(1);
		expect(validation.ok).toBe(false);
		expect(validation.issues).toHaveLength(1);

		const issue = validation.issues[0]!;
		expect(issue.provider).toBe("anthropic");
		expect(issue.rule).toBe("alternating-roles");
		expect(issue.severity).toBe("error");
		expect(issue.message).toContain("user");
		expect(issue.message).toContain("synthetic");
		expect(issue.location?.index).toBeGreaterThan(0);

		// The synthetic bridge is in the projection at the slot the
		// walker chose, with the documented payload.
		const bridges = validation.context.messages.filter(
			(
				m,
			): m is CustomMessage<{
				synthetic: boolean;
				rule: string;
				targetRole: string;
			}> => m.role === "custom" && (m as { customType?: string }).customType === "synthetic-bridge",
		);
		expect(bridges).toHaveLength(1);

		const bridge = bridges[0]!;
		const bridgeDetails = bridge.details as { synthetic: boolean; rule: string; targetRole: string };
		expect(bridgeDetails.synthetic).toBe(true);
		expect(bridgeDetails.rule).toBe("alternating-roles");
		expect(bridgeDetails.targetRole).toBe("assistant");
		expect(bridge.display).toBe(false);
		expect(bridge.content).toBe("");

		// After the fix, the wire-format user/assistant sequence is
		// strictly alternating. The bridge is `role: "custom"` with
		// `details.targetRole: "assistant"`, so on the wire it counts
		// as an assistant turn. The Anthropic walker skips
		// non-user/assistant messages; we replicate that here by
		// filtering out plain `custom` messages (those without a
		// `targetRole`) and projecting each remaining message to its
		// wire-format role.
		const projection = validation.context.messages;
		const wireRoles: string[] = projection
			.filter((m) => {
				if (m.role === "user" || m.role === "assistant") return true;
				if (m.role === "custom") {
					const d = (m as { details?: { targetRole?: string } }).details;
					return d?.targetRole !== undefined;
				}
				return false;
			})
			.map(wireRole);
		for (let i = 1; i < wireRoles.length; i++) {
			expect(wireRoles[i]).not.toBe(wireRoles[i - 1]);
		}

		// The two trailing user messages are still present in the
		// post-fix projection, with the bridge between them.
		const userIndices = projection.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);
		expect(userIndices.length).toBeGreaterThanOrEqual(2);
		const lastTwo = userIndices.slice(-2);
		const bridgeIndex = projection.findIndex(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === "synthetic-bridge",
		);
		expect(bridgeIndex).toBeGreaterThan(lastTwo[0]!);
		expect(bridgeIndex).toBeLessThan(lastTwo[1]!);

		// The cache plan is still attached to the last user/assistant
		// message; the bridge insertion does not strip it.
		const lastUserOrAssistant = findLastUserOrAssistant(validation.context.messages);
		expect(lastUserOrAssistant).toBeDefined();
		const lastDetails = (
			lastUserOrAssistant as AgentMessage & {
				details?: { cachePlan?: unknown; cacheMarkers?: CacheMarker[] };
			}
		).details;
		expect(lastDetails?.cachePlan).toBe(annotated.cachePlan);
		const lastMarkers = (lastDetails?.cacheMarkers ?? []) as CacheMarker[];
		expect(lastMarkers.some((m) => m.position === "last-message")).toBe(true);

		// The TaskState-injected messages are still at the head of the
		// projection in the documented order.
		const taskStateMessages = validation.context.messages.filter(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === "task-state-context",
		);
		expect(taskStateMessages).toHaveLength(4);
	});
});

