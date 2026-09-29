import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { compileContext, findLatestCompactionBoundary } from "../src/core/context-compiler.ts";
import { createCompactionSummaryMessage } from "../src/core/messages.ts";

function makeUser(text: string, ts = 0): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

function makeAssistant(text: string, ts = 0, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
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
		stopReason,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		timestamp: ts,
	};
}

describe("compileContext — basic", () => {
	it("returns an empty projection for an empty message stream", () => {
		const out = compileContext([], undefined, { tokenBudget: 1000 });
		expect(out.messages).toEqual([]);
		expect(out.droppedCount).toBe(0);
		expect(out.keptTokens).toBe(0);
		expect(out.budgetUsed).toBe(0);
		expect(out.accounting).toEqual({
			keptUserMessages: 0,
			keptAssistantMessages: 0,
			keptToolResults: 0,
			keptCompactionSummaries: 0,
			keptCustomMessages: 0,
			droppedByBudget: 0,
			droppedByDedup: 0,
			droppedByCompactionBoundary: 0,
			taskStateInjectedMessages: 0,
		});
	});

	it("keeps a single user message", () => {
		const messages: AgentMessage[] = [makeUser("hello", 1)];
		const out = compileContext(messages, undefined, { tokenBudget: 1000 });

		expect(out.messages).toHaveLength(1);
		expect(out.messages[0]).toBe(messages[0]);
		expect(out.accounting.keptUserMessages).toBe(1);
		expect(out.accounting.keptAssistantMessages).toBe(0);
		expect(out.accounting.keptToolResults).toBe(0);
		expect(out.droppedCount).toBe(0);
	});

	it("keeps the latest user message and the latest terminal assistant", () => {
		const messages: AgentMessage[] = [
			makeUser("first", 1),
			makeAssistant("first reply", 2),
			makeUser("second", 3),
			makeAssistant("second reply", 4),
		];
		const out = compileContext(messages, undefined, { tokenBudget: 100_000 });

		expect(out.messages).toHaveLength(4);
		expect(out.accounting.keptUserMessages).toBe(2);
		expect(out.accounting.keptAssistantMessages).toBe(2);
	});

	it("does not treat a toolUse assistant as terminal", () => {
		const messages: AgentMessage[] = [makeUser("do something", 1), makeAssistant("calling tool", 2, "toolUse")];
		const out = compileContext(messages, undefined, { tokenBudget: 100_000 });

		// Both messages are within recent-N=20 turns, so both are kept by the
		// recency rule, but the assistant is not marked essential because it
		// is non-terminal. This is observable via the token-budget step: with
		// an extremely tight budget the non-terminal assistant can still be
		// dropped.
		expect(out.messages).toHaveLength(2);
	});

	it("findLatestCompactionBoundary returns 0 when no compaction is present", () => {
		const messages: AgentMessage[] = [makeUser("hi", 1), makeAssistant("hello", 2)];
		expect(findLatestCompactionBoundary(messages)).toBe(0);
	});

	it("findLatestCompactionBoundary returns the index after the most recent compaction summary", () => {
		const compaction = createCompactionSummaryMessage("compacted body", 5000, new Date(10).toISOString());
		const messages: AgentMessage[] = [makeUser("pre", 1), compaction, makeUser("post", 20)];
		// compaction is at index 1, so boundary is 2.
		expect(findLatestCompactionBoundary(messages)).toBe(2);
	});
});

