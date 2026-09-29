/**
 * F2 provider-protocol validation — Anthropic alternating-roles.
 *
 * Anthropic requires strictly alternating user/assistant messages. Three
 * consecutive user messages should trigger a synthetic assistant bridge
 * between each pair.
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

describe("F2 provider-protocol — Anthropic alternating-roles", () => {
	it("inserts a synthetic assistant bridge between each pair of consecutive user messages", () => {
		const result = validateProviderProtocol(
			makeCompiled([makeUser("a", 1), makeUser("b", 2), makeUser("c", 3)]),
			"anthropic",
		);

		// Two consecutive same-role pairs (a-b and b-c); two bridges inserted.
		expect(result.fixedCount).toBe(2);

		// Collect the synthetic bridges in the fixed projection.
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

		// Two issues, both `alternating-roles` errors.
		expect(result.issues).toHaveLength(2);
		expect(result.issues.every((i) => i.rule === "alternating-roles" && i.severity === "error")).toBe(true);
		expect(result.ok).toBe(false);
	});

	it("produces an alternating user/assistant sequence after the fix", () => {
		const result = validateProviderProtocol(
			makeCompiled([makeUser("a", 1), makeUser("b", 2), makeUser("c", 3)]),
			"anthropic",
		);

		// Walk the fixed projection and verify the user messages
		// are no longer adjacent. The synthetic bridges are
		// `role: "custom"` with `details.targetRole: "assistant"`,
		// so we project the wire-format role for each message
		// (custom → assistant for the bridge) and check the
		// resulting sequence alternates.
		const wireRoles: string[] = result.context.messages.map((m) => {
			if (m.role === "user" || m.role === "assistant") return m.role;
			if (m.role === "custom") {
				const d = (m as { details?: { targetRole?: string } }).details;
				return d?.targetRole ?? "custom";
			}
			return m.role;
		});
		for (let i = 1; i < wireRoles.length; i++) {
			expect(wireRoles[i]).not.toBe(wireRoles[i - 1]);
		}
	});
});

