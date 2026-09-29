/**
 * F2 provider-protocol validation — clean projection.
 *
 * A well-formed projection against the most demanding provider
 * (Anthropic + Cohere rules: alternating user/assistant, every
 * toolResult followed by an assistant) must return ok with no issues
 * and zero fixedCount.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, TextContent, ToolResultMessage, UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { validateProviderProtocol } from "../src/core/provider-protocol.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

function makeAssistantText(text: string, ts: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: ts,
	};
}

function makeAssistantWithToolCall(id: string, ts: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: {} }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: ts,
	};
}

function makeToolResult(toolCallId: string, text: string, ts: number): ToolResultMessage {
	const content: TextContent[] = [{ type: "text", text }];
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content,
		isError: false,
		timestamp: ts,
	};
}

function makeCompiled(messages: AgentMessage[]) {
	return {
		messages,
		droppedCount: 0,
		keptTokens: 0,
		budgetUsed: 0,
		accounting: {
			keptUserMessages: 0,
			keptAssistantMessages: 0,
			keptToolResults: 0,
			keptCompactionSummaries: 0,
			keptCustomMessages: 0,
			droppedByBudget: 0,
			droppedByDedup: 0,
			droppedByCompactionBoundary: 0,
			taskStateInjectedMessages: 0,
		},
	};
}

describe("F2 provider-protocol — clean projection", () => {
	it("returns ok with no issues and zero fixedCount for a well-formed Anthropic projection", () => {
		// user → assistant (toolCall) → toolResult → assistant (text)
		// → user → assistant (text) — alternation holds, every
		// toolResult is followed by an assistant, and the first
		// message is a user.
		const messages: AgentMessage[] = [
			makeUser("read me foo", 1),
			makeAssistantWithToolCall("call-1", 2),
			makeToolResult("call-1", "contents of foo", 3),
			makeAssistantText("here it is", 4),
			makeUser("now bar", 5),
			makeAssistantText("done", 6),
		];
		const result = validateProviderProtocol(makeCompiled(messages), "anthropic");

		expect(result.ok).toBe(true);
		expect(result.issues).toEqual([]);
		expect(result.fixedCount).toBe(0);
		// The fixed context carries the same messages as the input.
		// (The validator always returns a fresh `messages` array, so
		// we compare by length and element identity rather than by
		// array identity.)
		expect(result.context.messages).toHaveLength(messages.length);
		expect(result.context.messages).toEqual(messages);
	});
});

