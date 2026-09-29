import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { compileContext, findLatestCompactionBoundary } from "../src/core/context-compiler.ts";
import { COMPACTION_SUMMARY_PREFIX, createCompactionSummaryMessage } from "../src/core/messages.ts";

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

describe("compileContext — compaction boundary", () => {
	it("drops tool results that precede a compaction summary in the middle of the stream", () => {
		const compaction = createCompactionSummaryMessage("compacted body", 5000, new Date(10).toISOString());
		const messages: AgentMessage[] = [
			makeUser("old task", 1),
			makeAssistant("running", 2),
			makeToolResult("old-call-1", "old output A", 3),
			makeToolResult("old-call-2", "old output B", 4),
			compaction, // index 4; boundary = 5.
			makeUser("new task", 5),
			makeAssistant("new reply", 6),
			makeToolResult("new-call-1", "new output", 7),
		];
		const out = compileContext(messages, undefined, { tokenBudget: 1_000_000, keepRecentTurns: 20 });

		// Both old tool results should be gone.
		const kept = out.messages;
		const toolResults = kept.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toBe(messages[7]);
		expect(out.accounting.droppedByCompactionBoundary).toBe(2);

		// The compaction summary is preserved.
		expect(kept.some((m) => m.role === "compactionSummary")).toBe(true);
	});

	it("does not drop the compaction summary itself (only tool results before it)", () => {
		const compaction = createCompactionSummaryMessage("body", 100, new Date(5).toISOString());
		const messages: AgentMessage[] = [makeUser("a", 1), makeToolResult("c-1", "x", 2), compaction, makeUser("b", 6)];

		const out = compileContext(messages, undefined, { tokenBudget: 1_000_000, keepRecentTurns: 20 });

		expect(out.messages.some((m) => m.role === "compactionSummary")).toBe(true);
		expect(out.accounting.droppedByCompactionBoundary).toBe(1);
	});

	it("drops ALL pre-boundary tool results, not just the immediately-adjacent one", () => {
		const compaction = createCompactionSummaryMessage("body", 100, new Date(100).toISOString());
		const messages: AgentMessage[] = [];
		for (let i = 0; i < 5; i++) {
			messages.push(makeToolResult(`pre-${i}`, `pre-${i}-out`, i));
		}
		messages.push(compaction);
		messages.push(makeUser("post", 200));
		messages.push(makeToolResult("post-1", "post-1-out", 201));

		const out = compileContext(messages, undefined, { tokenBudget: 1_000_000, keepRecentTurns: 20 });
		const toolResults = out.messages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]?.role === "toolResult" && toolResults[0].toolCallId).toBe("post-1");
		expect(out.accounting.droppedByCompactionBoundary).toBe(5);
	});

	it("detects compaction summary encoded as a user message with the recognized prefix", () => {
		const asUserMessage: UserMessage = {
			role: "user",
			content: `${COMPACTION_SUMMARY_PREFIX}the summary body\n</summary>`,
			timestamp: 50,
		};
		const messages: AgentMessage[] = [
			makeUser("old", 1),
			makeToolResult("c-1", "x", 2),
			asUserMessage,
			makeUser("new", 100),
		];
		// findLatestCompactionBoundary should detect the user-as-compaction.
		expect(findLatestCompactionBoundary(messages)).toBe(3);
		// And the compile result should drop the pre-boundary tool result.
		const out = compileContext(messages, undefined, { tokenBudget: 1_000_000, keepRecentTurns: 20 });
		expect(out.messages.some((m) => m.role === "toolResult")).toBe(false);
		expect(out.accounting.droppedByCompactionBoundary).toBe(1);
	});

	it("with no compaction summary, drops no tool results for the boundary", () => {
		const messages: AgentMessage[] = [
			makeUser("a", 1),
			makeToolResult("c-1", "x", 2),
			makeUser("b", 3),
			makeToolResult("c-2", "y", 4),
		];
		const out = compileContext(messages, undefined, { tokenBudget: 1_000_000, keepRecentTurns: 20 });
		expect(out.accounting.droppedByCompactionBoundary).toBe(0);
		// Both tool results are still present.
		expect(out.messages.filter((m) => m.role === "toolResult")).toHaveLength(2);
	});
});

