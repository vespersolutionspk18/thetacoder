import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { compileContext } from "../src/core/context-compiler.ts";
import { createCompactionSummaryMessage } from "../src/core/messages.ts";
import { addConstraint, createInitialTaskState, recordDecision, recordVerification } from "../src/core/task-state.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

function makeAssistant(
	text: string,
	ts: number,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
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

function makeToolResult(toolCallId: string, text: string, ts: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: ts,
	};
}

describe("compileContext — accounting", () => {
	it("counts kept messages by role and dropped by category", () => {
		const compaction = createCompactionSummaryMessage("body", 100, new Date(5).toISOString());
		const messages: AgentMessage[] = [
			// pre-boundary
			makeUser("old", 1),
			makeAssistant("running", 2),
			makeToolResult("c-1", "old", 3),
			compaction, // index 3, boundary = 4
			// post-boundary
			makeUser("new", 4),
			makeAssistant("reply", 5),
			makeToolResult("c-2", "dup", 6),
			makeToolResult("c-3", "dup", 7), // identical, deduped
		];

		const out = compileContext(messages, undefined, {
			tokenBudget: 1_000_000,
			keepRecentTurns: 20,
		});

		// Both "old" and "new" user messages are kept: the pre-boundary rule
		// only drops pre-boundary tool results, not user/assistant messages.
		expect(out.accounting.keptUserMessages).toBe(2);
		expect(out.accounting.keptAssistantMessages).toBe(2);
		expect(out.accounting.keptToolResults).toBe(1); // c-2; c-3 deduped
		expect(out.accounting.keptCompactionSummaries).toBe(1);
		expect(out.accounting.droppedByCompactionBoundary).toBe(1); // c-1
		expect(out.accounting.droppedByDedup).toBe(1); // c-3
		expect(out.accounting.droppedByBudget).toBe(0);
		expect(out.accounting.taskStateInjectedMessages).toBe(0);
	});

	it("counts droppedByBudget for messages trimmed by the recency window", () => {
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 20; i++) {
			messages.push(makeUser(`u-${i}`, i * 2));
			messages.push(makeAssistant(`a-${i}`, i * 2 + 1));
		}
		const out = compileContext(messages, undefined, {
			tokenBudget: 1_000_000,
			keepRecentTurns: 3,
		});

		// 20 turns total, 3 kept, 17 dropped x 2 messages = 34.
		expect(out.accounting.droppedByBudget).toBe(34);
	});

	it("counts TaskState-injected messages in taskStateInjectedMessages", () => {
		let state = createInitialTaskState("s");
		state = { ...state, objective: { text: "O", createdAt: 1 } };
		state = addConstraint(state, { text: "C1", source: "user" });
		state = addConstraint(state, { text: "C2", source: "model" });
		state = recordDecision(state, { text: "D" });
		state = recordVerification(state, { kind: "test", command: "x", passed: false });
		const out = compileContext([makeUser("hi", 1)], state, { tokenBudget: 1_000_000 });

		// objective + constraints + decisions-hypotheses + failed-verifications
		// = 4 injected messages.
		expect(out.accounting.taskStateInjectedMessages).toBe(4);
	});

	it("budgetUsed = keptTokens / tokenBudget", () => {
		// Each message is 100 chars; estimator default 25 tokens. 2 messages
		// = 50 tokens.
		const messages: AgentMessage[] = [makeUser("x".repeat(100), 1), makeAssistant("y".repeat(100), 2)];
		const out = compileContext(messages, undefined, { tokenBudget: 200 });

		expect(out.keptTokens).toBe(50);
		expect(out.budgetUsed).toBeCloseTo(0.25);
	});

	it("droppedCount is the difference between input length and final output length (excluding injected TaskState messages)", () => {
		const messages: AgentMessage[] = [makeUser("a", 1), makeAssistant("b", 2)];
		const out = compileContext(messages, undefined, { tokenBudget: 1_000_000 });

		// 2 input messages, 2 output messages (no TaskState, no dedup, no budget trim).
		expect(out.droppedCount).toBe(0);

		const messagesWithTrim: AgentMessage[] = [];
		for (let i = 0; i < 10; i++) {
			messagesWithTrim.push(makeUser(`u-${i}`, i));
			messagesWithTrim.push(makeAssistant(`a-${i}`, i + 0.5));
		}
		const out2 = compileContext(messagesWithTrim, undefined, {
			tokenBudget: 1_000_000,
			keepRecentTurns: 2,
		});
		// 20 input, 4 output -> 16 dropped (all by recency).
		expect(out2.droppedCount).toBe(16);
		expect(out2.accounting.droppedByBudget).toBe(16);
	});

	it("compaction summary is counted under keptCompactionSummaries, not keptCustomMessages", () => {
		const compaction = createCompactionSummaryMessage("body", 100, new Date(5).toISOString());
		const messages: AgentMessage[] = [compaction, makeUser("after", 100)];
		const out = compileContext(messages, undefined, { tokenBudget: 1_000_000, keepRecentTurns: 20 });

		expect(out.accounting.keptCompactionSummaries).toBe(1);
		// No custom messages of any kind were injected.
		expect(out.accounting.keptCustomMessages).toBe(0);
	});
});

