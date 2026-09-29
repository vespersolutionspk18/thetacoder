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

/** Build a stream of 25 user/assistant turns (= 50 messages) with deterministic text. */
function buildFiftyMessages(): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (let i = 0; i < 25; i++) {
		out.push(makeUser(`user-${i}`, i * 2));
		out.push(makeAssistant(`assistant-${i}`, i * 2 + 1));
	}
	return out;
}

describe("compileContext — recent turns", () => {
	it("keeps only the latest N turns (50 messages, N=5)", () => {
		const messages = buildFiftyMessages();
		const out = compileContext(messages, undefined, { tokenBudget: 1_000_000, keepRecentTurns: 5 });

		// Each turn has 2 messages (user + assistant) -> 10 messages kept.
		expect(out.messages).toHaveLength(10);
		// First kept message must be the 21st message (turn index 20,
		// message index 40) — the start of the 5th-from-last turn.
		// (25 turns - 5 = 20; turn 20 starts at message index 40.)
		expect(out.messages[0]).toBe(messages[40]);
		// Last kept message must be the final assistant.
		expect(out.messages[out.messages.length - 1]).toBe(messages[messages.length - 1]);

		// 40 messages dropped (20 turns x 2 messages).
		expect(out.accounting.droppedByBudget).toBe(40);
	});

	it("preserves the conversation order within the kept turns", () => {
		const messages = buildFiftyMessages();
		const out = compileContext(messages, undefined, { tokenBudget: 1_000_000, keepRecentTurns: 3 });

		// 3 turns x 2 = 6 messages.
		expect(out.messages).toHaveLength(6);
		// Turn index 22 starts at message index 44; turn 24 ends at index 49.
		expect(out.messages[0]).toBe(messages[44]);
		expect(out.messages[5]).toBe(messages[49]);
	});

	it("falls back to default keepRecentTurns=20 when option is omitted", () => {
		const messages = buildFiftyMessages();
		const out = compileContext(messages, undefined, { tokenBudget: 1_000_000 });

		// Default is 20 turns -> 40 messages.
		expect(out.messages).toHaveLength(40);
	});

	it("treats compaction summaries as their own turn", () => {
		// Mix of user/assistant turns plus a compaction summary message.
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 3; i++) {
			messages.push(makeUser(`u-${i}`, i * 2));
			messages.push(makeAssistant(`a-${i}`, i * 2 + 1));
		}
		// Append a compaction summary message — by itself, this starts a new
		// (8th) turn consisting of just the summary.
		messages.push({
			role: "compactionSummary",
			summary: "compacted body",
			tokensBefore: 1000,
			timestamp: 100,
		});
		// Three more user/assistant turns after compaction.
		for (let i = 3; i < 6; i++) {
			messages.push(makeUser(`u-${i}`, 100 + i * 2));
			messages.push(makeAssistant(`a-${i}`, 100 + i * 2 + 1));
		}

		const out = compileContext(messages, undefined, { tokenBudget: 1_000_000, keepRecentTurns: 4 });
		// 4 most recent turns: the compaction-summary turn (1 message) plus
		// the three post-compaction user/assistant turns (6 messages) = 7.
		expect(out.messages).toHaveLength(7);
		// The first kept message is the compaction summary.
		expect(out.messages[0]?.role).toBe("compactionSummary");
	});
});

