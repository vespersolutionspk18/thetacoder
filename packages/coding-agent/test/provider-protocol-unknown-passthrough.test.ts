/**
 * F2 provider-protocol validation — unknown provider passthrough.
 *
 * When the caller cannot identify the target provider, the validator
 * is a no-op. It reports no issues and inserts no bridges, regardless
 * of the projection's shape.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { validateProviderProtocol } from "../src/core/provider-protocol.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
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

describe("F2 provider-protocol — unknown passthrough", () => {
	it("returns ok with no issues and zero fixedCount for an empty projection", () => {
		const result = validateProviderProtocol(makeCompiled([]), "unknown");
		expect(result.ok).toBe(true);
		expect(result.issues).toEqual([]);
		expect(result.fixedCount).toBe(0);
		expect(result.context.messages).toEqual([]);
	});

	it("returns ok even when the projection would violate other providers' rules", () => {
		// Three consecutive user messages would trip Anthropic's
		// alternating-roles check. The unknown provider does not
		// inspect structural rules, so the projection passes through
		// unchanged.
		const messages: AgentMessage[] = [makeUser("a", 1), makeUser("b", 2), makeUser("c", 3)];
		const result = validateProviderProtocol(makeCompiled(messages), "unknown");

		expect(result.ok).toBe(true);
		expect(result.issues).toEqual([]);
		expect(result.fixedCount).toBe(0);
		expect(result.context.messages).toEqual(messages);
	});
});

