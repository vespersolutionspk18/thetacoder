/**
 * F2 provider-protocol validation — OpenAI first-message-must-be-user.
 *
 * OpenAI requires the first non-system message to be a user message.
 * When the projection starts with an assistant message, the validator
 * inserts a synthetic user bridge at the head.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { validateProviderProtocol } from "../src/core/provider-protocol.ts";

function makeAssistant(text: string, ts: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-4o",
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

describe("F2 provider-protocol — OpenAI first-message-must-be-user", () => {
	it("inserts a synthetic user bridge when the first message is assistant", () => {
		const result = validateProviderProtocol(makeCompiled([makeAssistant("hi", 1)]), "openai");

		// One bridge inserted at the head.
		expect(result.fixedCount).toBe(1);
		expect(result.context.messages).toHaveLength(2);
		const head = result.context.messages[0]!;
		expect(head.role).toBe("custom");
		if (head.role === "custom") {
			expect(head.customType).toBe("synthetic-bridge");
			const details = head.details as { synthetic?: boolean; rule?: string; targetRole?: string };
			expect(details.synthetic).toBe(true);
			expect(details.rule).toBe("first-message-must-be-user");
			expect(details.targetRole).toBe("user");
		}

		// The original assistant message follows the bridge.
		expect(result.context.messages[1]!.role).toBe("assistant");

		// One issue under `first-message-must-be-user`.
		expect(result.issues).toHaveLength(1);
		expect(result.issues[0]!.rule).toBe("first-message-must-be-user");
		expect(result.issues[0]!.severity).toBe("error");
		expect(result.ok).toBe(false);
	});
});

