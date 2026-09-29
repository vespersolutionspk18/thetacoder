/**
 * F2 deep integration — stale evidence path.
 *
 * Same six-stage F2 pipeline as `f2-deep-integration.test.ts`, but the
 * `latestHashes` map intentionally disagrees with the changedFile's
 * recorded `contentHash`. The freshness check therefore reports the file
 * as `stale` (not `fresh`, not `missing`), and `annotateStaleness`
 * prepends a `customType: "freshness-warning"` message at the head of
 * the projection.
 *
 * Assertions focus on the stale-evidence side of the pipeline:
 *   - The FreshnessReport has `staleCount === 1`, `freshCount === 0`,
 *     and `missingCount === 0`, with the right `expectedHash` /
 *     `actualHash` / `status` for the recorded file.
 *   - The freshness-warning message is at index 0 of the post-staleness
 *     projection, is `display: false`, names the file, carries the
 *     `stale` tag, and embeds the FreshnessReport in its `details`.
 *   - The rest of the pipeline still runs to completion: the cache plan
 *     is attached, the protocol validation is well-formed, and the
 *     TaskState-injected messages are present in the documented order.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { annotateCacheMarkers, attachCachePlanToMessages, type CacheMarker } from "../src/core/cache-rendering.ts";
import { compileContext } from "../src/core/context-compiler.ts";
import { annotateStaleness, checkEvidenceFreshness, type FreshnessCheck } from "../src/core/evidence-freshness.ts";
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
const FILE_HASH_RECORDED = "hash-recorded-v1";
const FILE_HASH_LATEST = "hash-latest-mismatch";

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
	let state = createInitialTaskState("f2-deep-integration-stale");
	state = { ...state, objective: { text: "Migrate the legacy auth flow", createdAt: now } };
	state = addConstraint(state, { text: "Preserve existing session cookies", source: "user" });
	state = addConstraint(state, { text: "Roll out behind a feature flag", source: "model" });
	state = recordDecision(state, { text: "Adopt the new token format" });
	state = {
		...state,
		hypotheses: [
			...state.hypotheses,
			{
				id: "hyp-stale-1",
				text: "The new format is backward compatible",
				status: "open" as const,
				madeAt: now,
			},
		],
	};
	state = recordChange(state, { path: FILE_PATH, contentHash: FILE_HASH_RECORDED });
	state = recordVerification(state, {
		kind: "typecheck",
		command: "tsc --noEmit",
		passed: false,
	});
	return state;
}

// Shorter conversation than the main test — enough to exercise the
// pipeline but the focus is the freshness warning, not the full structure.
function buildConversation(): AgentMessage[] {
	const messages: AgentMessage[] = [];
	let ts = 1;

	messages.push(makeCompaction("Earlier session summarized: chose the new auth flow.", ts++));

	for (let turn = 0; turn < 4; turn++) {
		messages.push(makeUser(`Question ${turn}`, ts++));
		messages.push(makeAssistantText(`Answer ${turn}`, ts++));
	}

	// One tool call round to give `last-tool` a real anchor.
	messages.push(makeUser("Run the test suite", ts++));
	messages.push(makeAssistantWithToolCall("call-test", "bash", { command: "npm test" }, ts++));
	messages.push(makeToolResult("call-test", "bash", "FAIL src/foo.test.ts", ts++));
	messages.push(makeAssistantText("The new auth flow is broken.", ts++));

	return messages;
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

describe("F2 deep integration — stale evidence path", () => {
	it("marks the changedFile stale when latestHashes disagrees, prepends a freshness-warning, and still validates cleanly for Anthropic", () => {
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
		expect(annotated.cachePlan!.markers).toHaveLength(3);

		// ---- Stage 3: attachCachePlanToMessages ----
		const withPlan = attachCachePlanToMessages(annotated.messages, annotated.cachePlan!);
		expect(withPlan).not.toBe(annotated.messages);

		// ---- Stage 4: checkEvidenceFreshness (mismatched hash) ----
		const latestHashes = new Map<string, string>();
		latestHashes.set(FILE_PATH, FILE_HASH_LATEST);
		const report = checkEvidenceFreshness({ taskState, latestHashes });

		// Strictly one stale file, zero fresh, zero missing.
		expect(report.staleCount).toBe(1);
		expect(report.freshCount).toBe(0);
		expect(report.missingCount).toBe(0);
		expect(report.unknownCount).toBe(0);
		expect(report.checks).toHaveLength(1);

		const check: FreshnessCheck = report.checks[0]!;
		expect(check.path).toBe(FILE_PATH);
		expect(check.expectedHash).toBe(FILE_HASH_RECORDED);
		expect(check.actualHash).toBe(FILE_HASH_LATEST);
		expect(check.status).toBe("stale");
		// `ageMs` is `checkedAt - capturedAt`, clamped at 0; both
		// timestamps are derived from the TaskState / `now` so the value
		// is a non-negative integer.
		expect(check.ageMs).toBeGreaterThanOrEqual(0);

		// ---- Stage 5: annotateStaleness ----
		const withStaleness = annotateStaleness(report, { ...annotated, messages: withPlan });

		expect(withStaleness.freshness).toBe(report);
		expect(withStaleness.messages).toHaveLength(withPlan.length + 1);

		const warning = withStaleness.messages[0] as CustomMessage<{
			report: unknown;
			marker?: string;
		}>;
		expect(warning.role).toBe("custom");
		expect(warning.customType).toBe("freshness-warning");
		expect(warning.display).toBe(false);

		// The warning body names the file, tags it `stale`, and reports
		// the counts in the documented format. The body uses the
		// `[FRESHNESS] N stale, M missing. Affected paths: <path> (<tag>)`
		// shape, so we check the per-file tag and the stale count rather
		// than asserting absence of the word "missing" (which appears in
		// the counts section of every warning body).
		const body = typeof warning.content === "string" ? warning.content : "";
		expect(body).toContain(FILE_PATH);
		expect(body).toContain("(stale)");
		expect(body).toMatch(/1 stale/);
		expect(body).toMatch(/0 missing/);

		// The FreshnessReport is preserved on the warning's `details`
		// for downstream consumers (e.g. the provider adapter or a UI
		// panel).
		const warningDetails = warning.details as { report: unknown; marker?: string } | undefined;
		expect(warningDetails?.report).toBe(report);

		// The four TaskState-injected messages are still present,
		// shifted right by one because the warning is at index 0.
		const taskStateMessages = withStaleness.messages.filter(
			(m): m is CustomMessage<{ marker: string }> =>
				m.role === "custom" && (m as { customType?: string }).customType === "task-state-context",
		);
		expect(taskStateMessages).toHaveLength(4);
		const markers = taskStateMessages.map((m) => (m.details as { marker?: string } | undefined)?.marker);
		expect(markers).toContain("objective");
		expect(markers).toContain("constraints");
		expect(markers).toContain("decisions-hypotheses");
		expect(markers).toContain("failed-verifications");

		// ---- Stage 6: validateProviderProtocol ----
		const validation = validateProviderProtocol(withStaleness, "anthropic");

		// Prepending a `custom` message does not break the
		// alternating-roles rule (the Anthropic walker skips custom).
		// The projection is well-formed.
		expect(validation.ok).toBe(true);
		expect(validation.fixedCount).toBe(0);
		expect(validation.issues).toHaveLength(0);

		// The cache plan is still attached to the last user/assistant
		// message of the post-staleness projection.
		const projection = validation.context.messages;
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

		// The freshness-warning is still at index 0 of the post-validation
		// projection (validation is a no-op for a well-formed projection).
		const headWarning = projection[0] as AgentMessage & { customType?: string };
		expect(headWarning.customType).toBe("freshness-warning");
	});
});

