/**
 * F2 provider-protocol validation — OpenAI tool-result-must-follow-tool-call.
 *
 * When a toolResult message has no matching toolCall in any preceding
 * assistant message, the validator warns but does not fix: the missing
 * tool call cannot be synthesized from the result alone.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { TextContent, ToolResultMessage, UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { validateProviderProtocol } from "../src/core/provider-protocol.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
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

describe("F2 provider-protocol — OpenAI orphan toolResult", () => {
	it("warns on an orphan toolResult and does not insert a bridge", () => {
		const messages: AgentMessage[] = [makeUser("hi", 1), makeToolResult("orphan-id", "result", 2)];
		const result = validateProviderProtocol(makeCompiled(messages), "openai");

		// One warning under `tool-result-must-follow-tool-call`.
		const issues = result.issues.filter((i) => i.rule === "tool-result-must-follow-tool-call");
		expect(issues).toHaveLength(1);
		expect(issues[0]!.severity).toBe("warning");
		expect(issues[0]!.location?.index).toBe(1);

		// No fix: no bridges inserted.
		expect(result.fixedCount).toBe(0);
		const bridges = result.context.messages.filter(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === "synthetic-bridge",
		);
		expect(bridges).toHaveLength(0);

		// Warnings do not flip `ok` to false.
		expect(result.ok).toBe(true);
	});
});

