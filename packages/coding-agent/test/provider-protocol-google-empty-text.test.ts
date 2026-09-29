/**
 * F2 provider-protocol validation — Google empty-text-not-allowed.
 *
 * Google rejects empty text blocks. The validator walks every user and
 * assistant message, finds empty `text` fields (both the string form on
 * `UserMessage.content` and individual `TextContent` blocks), and
 * replaces them with a single space.
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
		api: "google-generative-ai",
		provider: "google",
		model: "gemini-1.5-pro",
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

describe("F2 provider-protocol — Google empty text", () => {
	it("replaces an empty text block in an assistant message with a single space", () => {
		const result = validateProviderProtocol(makeCompiled([makeAssistant("", 1)]), "google");

		expect(result.issues).toHaveLength(1);
		expect(result.issues[0]!.rule).toBe("empty-text-not-allowed");
		expect(result.issues[0]!.severity).toBe("error");

		// No bridges inserted — the fix is in-place text replacement.
		expect(result.fixedCount).toBe(0);
		// (fixedCount is for synthetic bridges; the empty-text fix is
		// recorded via the issue but does not bump fixedCount. This
		// mirrors the spec: the only thing counted by fixedCount is
		// synthetic messages.)

		const fixed = result.context.messages[0]!;
		expect(fixed.role).toBe("assistant");
		if (fixed.role === "assistant") {
			const block = fixed.content[0]!;
			expect(block.type).toBe("text");
			if (block.type === "text") {
				expect(block.text).toBe(" ");
			}
		}
	});

	it("replaces an empty string content on a user message with a single text block", () => {
		const result = validateProviderProtocol(makeCompiled([makeUser("", 1)]), "google");

		expect(result.issues).toHaveLength(1);
		expect(result.issues[0]!.rule).toBe("empty-text-not-allowed");

		const fixed = result.context.messages[0]!;
		expect(fixed.role).toBe("user");
		if (fixed.role === "user") {
			expect(typeof fixed.content).toBe("object");
			const arr = fixed.content as { type: string; text?: string }[];
			expect(arr).toHaveLength(1);
			expect(arr[0]!.type).toBe("text");
			expect(arr[0]!.text).toBe(" ");
		}
	});

	it("leaves non-empty text alone", () => {
		const result = validateProviderProtocol(makeCompiled([makeAssistant("ok", 1)]), "google");
		expect(result.issues).toHaveLength(0);
		expect(result.fixedCount).toBe(0);
		expect(result.ok).toBe(true);
	});
});

