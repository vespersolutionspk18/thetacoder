/**
 * F2 provider-protocol validation — synthetic-marker contract.
 *
 * Every bridge message the validator inserts must carry
 * `details.synthetic: true` and a `details.rule` naming the protocol
 * rule that triggered the insertion. Downstream consumers use the
 * marker to distinguish synthesized bridges from real conversation
 * content.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { validateProviderProtocol } from "../src/core/provider-protocol.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

function makeAssistant(text: string, ts: number): AssistantMessage {
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

describe("F2 provider-protocol — synthetic-marker contract", () => {
	it("every bridge inserted by the Anthropic walker carries details.synthetic = true", () => {
		const result = validateProviderProtocol(makeCompiled([makeUser("a", 1), makeUser("b", 2)]), "anthropic");

		// Two user messages → one bridge.
		expect(result.fixedCount).toBe(1);
		const bridge = result.context.messages.find(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === "synthetic-bridge",
		);
		expect(bridge).toBeDefined();
		if (bridge && bridge.role === "custom") {
			const details = bridge.details as { synthetic?: boolean; rule?: string };
			expect(details.synthetic).toBe(true);
			expect(typeof details.rule).toBe("string");
		}
	});

	it("the first-message bridge for OpenAI carries details.synthetic = true", () => {
		const result = validateProviderProtocol(makeCompiled([makeAssistant("hi", 1)]), "openai");

		expect(result.fixedCount).toBe(1);
		const bridge = result.context.messages[0]!;
		expect(bridge.role).toBe("custom");
		if (bridge.role === "custom") {
			const details = bridge.details as { synthetic?: boolean; rule?: string; targetRole?: string };
			expect(details.synthetic).toBe(true);
			expect(details.rule).toBe("first-message-must-be-user");
			expect(details.targetRole).toBe("user");
		}
	});

	it("every bridge inserted across providers carries the synthetic marker", () => {
		// Anthropic: alternating-roles → assistant bridge
		const anthropicResult = validateProviderProtocol(makeCompiled([makeUser("a", 1), makeUser("b", 2)]), "anthropic");
		const anthropicBridge = anthropicResult.context.messages.find(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === "synthetic-bridge",
		);
		expect(anthropicBridge).toBeDefined();

		// OpenAI: first-message-must-be-user → user bridge
		const openaiResult = validateProviderProtocol(makeCompiled([makeAssistant("hi", 1)]), "openai");
		const openaiBridge = openaiResult.context.messages.find(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === "synthetic-bridge",
		);
		expect(openaiBridge).toBeDefined();

		for (const bridge of [anthropicBridge, openaiBridge]) {
			expect(bridge).toBeDefined();
			if (bridge && bridge.role === "custom") {
				const details = bridge.details as { synthetic?: boolean; rule?: string };
				expect(details.synthetic).toBe(true);
				expect(typeof details.rule).toBe("string");
			}
		}
	});
});

