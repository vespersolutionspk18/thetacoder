/**
 * F2 provider-protocol validation — Cohere alternating-roles.
 *
 * Cohere shares the same conversation-shape requirements as Anthropic:
 * strictly alternating user/assistant messages. The rule set and fix
 * are identical; only the provider label differs.
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

describe("F2 provider-protocol — Cohere alternating-roles", () => {
	it("inserts synthetic assistant bridges between consecutive user messages", () => {
		const result = validateProviderProtocol(
			makeCompiled([makeUser("a", 1), makeUser("b", 2), makeUser("c", 3)]),
			"cohere",
		);

		// Two bridges inserted (one per consecutive same-role pair).
		expect(result.fixedCount).toBe(2);

		const bridges = result.context.messages.filter(
			(m): m is Extract<AgentMessage, { role: "custom" }> =>
				m.role === "custom" && (m as { customType?: string }).customType === "synthetic-bridge",
		);
		expect(bridges).toHaveLength(2);
		for (const b of bridges) {
			const details = b.details as { synthetic?: boolean; rule?: string; targetRole?: string };
			expect(details.synthetic).toBe(true);
			expect(details.rule).toBe("alternating-roles");
			expect(details.targetRole).toBe("assistant");
		}

		// Two issues, both `alternating-roles` errors, provider = cohere.
		expect(result.issues).toHaveLength(2);
		expect(result.issues.every((i) => i.provider === "cohere")).toBe(true);
		expect(result.issues.every((i) => i.rule === "alternating-roles")).toBe(true);
		expect(result.ok).toBe(false);
	});
});

