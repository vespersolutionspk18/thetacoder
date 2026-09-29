/**
 * F2 stable-rendering — token estimation.
 *
 * Verifies that the cache plan's `estimatedStablePrefixTokens` and
 * `estimatedVolatileSuffixTokens` are populated, positive when there is
 * content on each side of the split, and roughly consistent with the
 * chars/4 estimator used by `compileContext`.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { annotateCacheMarkers } from "../src/core/cache-rendering.ts";
import { compileContext } from "../src/core/context-compiler.ts";
import { createInitialTaskState } from "../src/core/task-state.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

function makeAssistantText(text: string, ts: number): AssistantMessage {
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
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		timestamp: ts,
	};
}

function makeToolResult(text: string, ts: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${ts}`,
		toolName: "bash",
		content: [{ type: "text", text }],
		details: {},
		isError: false,
		timestamp: ts,
	};
}

describe("F2 stable-rendering — token estimation", () => {
	it("populates stable and volatile token counts when both sides have content", () => {
		const state = createInitialTaskState("s");
		// A non-trivial objective so the TaskState-injected message carries
		// enough text to register > 0 stable tokens.
		const withState = {
			...state,
			objective: { text: "Ship the F2 stable rendering layer with cache markers", createdAt: 1 },
		};
		// 200 chars of text in the volatile region -> ~50 tokens.
		const volatileText = "x".repeat(200);
		const messages: AgentMessage[] = [
			makeUser(volatileText, 1),
			makeAssistantText("reply", 2),
			makeToolResult(volatileText, 3),
			makeAssistantText(volatileText, 4),
		];

		const compiled = compileContext(messages, withState, { tokenBudget: 1_000_000 });
		const annotated = annotateCacheMarkers(compiled, {
			format: "anthropic",
			retention: "short",
			systemPrompt: true,
			lastTool: true,
			lastMessage: true,
		});

		const plan = annotated.cachePlan!;
		expect(plan.estimatedStablePrefixTokens).toBeGreaterThan(0);
		expect(plan.estimatedVolatileSuffixTokens).toBeGreaterThan(0);
	});

	it("uses the chars/4 estimator by default", () => {
		const state = createInitialTaskState("s");
		const withState = {
			...state,
			// TaskState-injected body is `## Objective\n${text}` = 13 + N
			// chars; pick N so the math is simple: 40 chars objective ->
			// 53 chars total body -> 14 tokens (ceil(53/4)).
			objective: { text: "x".repeat(40), createdAt: 1 },
		};
		// 80 chars of user text -> 20 tokens.
		const messages: AgentMessage[] = [makeUser("y".repeat(80), 1)];
		const compiled = compileContext(messages, withState, { tokenBudget: 1_000_000 });
		const annotated = annotateCacheMarkers(compiled, {
			format: "anthropic",
			retention: "short",
			systemPrompt: true,
			lastTool: true,
			lastMessage: true,
		});
		const plan = annotated.cachePlan!;
		// The objective is the only TaskState-injected message; everything
		// else is volatile.
		expect(plan.estimatedStablePrefixTokens).toBe(14);
		expect(plan.estimatedVolatileSuffixTokens).toBe(20);
	});

	it("honors a custom estimator", () => {
		const state = createInitialTaskState("s");
		const withState = { ...state, objective: { text: "objective", createdAt: 1 } };
		const messages: AgentMessage[] = [makeUser("body", 1)];
		const compiled = compileContext(messages, withState, { tokenBudget: 1_000_000 });
		const annotated = annotateCacheMarkers(compiled, {
			format: "anthropic",
			retention: "short",
			systemPrompt: true,
			lastTool: true,
			lastMessage: true,
			estimator: () => 42, // every message counts as 42 tokens
		});
		const plan = annotated.cachePlan!;
		// The projection has 1 stable (objective) and 1 volatile (user).
		expect(plan.estimatedStablePrefixTokens).toBe(42);
		expect(plan.estimatedVolatileSuffixTokens).toBe(42);
	});
});

