import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { compileContext } from "../src/core/context-compiler.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

function makeAssistant(text: string, ts: number): AssistantMessage {
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
		stopReason: "stop",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		timestamp: ts,
	};
}

function padded(s: string, length: number): string {
	return s.length >= length ? s : s + "x".repeat(length - s.length);
}

describe("compileContext — token budget", () => {
	it("drops oldest non-essential messages until the projection fits the budget", () => {
		// 10 user/assistant turns; each user text is padded to ~1000 chars
		// (~250 tokens with chars/4). 10 turns x 2 messages x ~125 tokens
		// each ~= 2500 tokens. Budget of 1000 should force trimming.
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 10; i++) {
			messages.push(makeUser(padded(`user-${i}`, 1000), i * 2));
			messages.push(makeAssistant(padded(`assistant-${i}`, 1000), i * 2 + 1));
		}
		const out = compileContext(messages, undefined, { tokenBudget: 1000, keepRecentTurns: 20 });

		// Default estimator: chars/4 rounded up. 1000 chars -> 250 tokens per
		// message. Budget 1000 = 4 messages maximum.
		expect(out.keptTokens).toBeLessThanOrEqual(1000);
		// We should be under the budget (essentials may push over, but with
		// 2-token latest user and 2-token latest terminal assistant, we are
		// under).
		expect(out.budgetUsed).toBeLessThanOrEqual(1);
		// The latest user message and the latest terminal assistant must be
		// in the output.
		expect(out.messages.some((m) => m.role === "user" && m.content === padded("user-9", 1000))).toBe(true);
		expect(out.messages.some((m) => m.role === "assistant")).toBe(true);
	});

	it("with an oversized budget, keeps every message", () => {
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 5; i++) {
			messages.push(makeUser(`user-${i}`, i * 2));
			messages.push(makeAssistant(`assistant-${i}`, i * 2 + 1));
		}
		const out = compileContext(messages, undefined, { tokenBudget: 1_000_000, keepRecentTurns: 20 });
		expect(out.messages).toHaveLength(10);
		expect(out.droppedCount).toBe(0);
	});

	it("with an impossibly small budget, keeps only essentials", () => {
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 5; i++) {
			messages.push(makeUser(padded(`user-${i}`, 1000), i * 2));
			messages.push(makeAssistant(padded(`assistant-${i}`, 1000), i * 2 + 1));
		}
		const out = compileContext(messages, undefined, { tokenBudget: 1, keepRecentTurns: 20 });

		// Budget = 1 token; the latest user (>= 250 tokens) and the latest
		// terminal assistant (>= 250 tokens) cannot fit either, so the
		// essentials overflow the cap. The output still contains them — the
		// budget is a soft cap.
		expect(out.messages.some((m) => m.role === "user")).toBe(true);
		expect(out.messages.some((m) => m.role === "assistant")).toBe(true);
		// No non-essential messages should remain (the first 8 messages are
		// all non-essential and would have been dropped first).
		expect(out.messages.length).toBeLessThan(10);
		expect(out.accounting.droppedByBudget).toBeGreaterThan(0);
	});

	it("custom estimator is respected", () => {
		// Trivial estimator: every message costs exactly 10 tokens.
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 10; i++) {
			messages.push(makeUser(padded(`user-${i}`, 100), i * 2));
			messages.push(makeAssistant(padded(`assistant-${i}`, 100), i * 2 + 1));
		}
		const out = compileContext(messages, undefined, {
			tokenBudget: 50, // 5 messages worth
			keepRecentTurns: 20,
			estimator: () => 10,
		});

		expect(out.keptTokens).toBeLessThanOrEqual(50);
		// At least 2 messages should remain (the latest user + latest terminal assistant).
		expect(out.messages.length).toBeGreaterThanOrEqual(2);
	});
});

