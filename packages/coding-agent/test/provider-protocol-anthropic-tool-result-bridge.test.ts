/**
 * F2 provider-protocol validation — Anthropic role-sequence-mismatch on
 * consecutive toolResult messages.
 *
 * When two toolResult messages appear back-to-back, the validator
 * cannot synthesize the missing assistant turn (it does not know what
 * the assistant should say). It must report a warning and not fix.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, TextContent, ToolResultMessage, UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { validateProviderProtocol } from "../src/core/provider-protocol.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
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

describe("F2 provider-protocol — Anthropic consecutive toolResult", () => {
	it("warns on user → toolResult → toolResult and does not insert a bridge", () => {
		const messages: AgentMessage[] = [
			makeUser("do two things", 1),
			makeAssistantWithToolCall("call-1", 2),
			makeToolResult("call-1", "result-1", 3),
			makeToolResult("call-2", "result-2", 4),
		];
		const result = validateProviderProtocol(makeCompiled(messages), "anthropic");

		// Exactly one warning under `role-sequence-mismatch`.
		const roleSeqIssues = result.issues.filter((i) => i.rule === "role-sequence-mismatch");
		expect(roleSeqIssues).toHaveLength(1);
		expect(roleSeqIssues[0]!.severity).toBe("warning");

		// No synthetic bridge was inserted.
		expect(result.fixedCount).toBe(0);
		const bridges = result.context.messages.filter(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === "synthetic-bridge",
		);
		expect(bridges).toHaveLength(0);

		// Warnings do not flip `ok` to false.
		expect(result.ok).toBe(true);
	});
});

