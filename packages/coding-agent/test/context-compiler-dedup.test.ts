import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@theta/ai";
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
		stopReason: "toolUse",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		timestamp: ts,
	};
}

function makeToolResult(toolCallId: string, text: string, ts: number, toolName = "bash"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: ts,
	};
}

describe("compileContext — dedupe consecutive tool results", () => {
	it("drops the second of two consecutive identical tool-result messages", () => {
		const messages: AgentMessage[] = [
			makeUser("run the command", 1),
			makeAssistant("running", 2),
			makeToolResult("call-1", "identical output\n", 3),
			makeToolResult("call-2", "identical output\n", 4),
		];
		const out = compileContext(messages, undefined, { tokenBudget: 1_000_000, keepRecentTurns: 20 });

		const toolResults = out.messages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(out.accounting.droppedByDedup).toBe(1);
	});

	it("does not dedupe tool results with different content", () => {
		const messages: AgentMessage[] = [
			makeUser("run", 1),
			makeAssistant("running", 2),
			makeToolResult("call-1", "first output", 3),
			makeToolResult("call-2", "second output", 4),
		];
		const out = compileContext(messages, undefined, { tokenBudget: 1_000_000, keepRecentTurns: 20 });

		const toolResults = out.messages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(2);
		expect(out.accounting.droppedByDedup).toBe(0);
	});

	it("only dedupes consecutively; a non-identical middle breaks the run", () => {
		const messages: AgentMessage[] = [
			makeUser("run", 1),
			makeAssistant("running", 2),
			makeToolResult("call-1", "same", 3),
			makeToolResult("call-2", "different", 4),
			makeToolResult("call-3", "same", 5),
		];
		const out = compileContext(messages, undefined, { tokenBudget: 1_000_000, keepRecentTurns: 20 });

		// call-1 (same) and call-3 (same) are not consecutive, so both stay.
		const toolResults = out.messages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(3);
		expect(out.accounting.droppedByDedup).toBe(0);
	});

	it("respects dedupeIdenticalToolResults=false", () => {
		const messages: AgentMessage[] = [
			makeUser("run", 1),
			makeAssistant("running", 2),
			makeToolResult("call-1", "identical", 3),
			makeToolResult("call-2", "identical", 4),
		];
		const out = compileContext(messages, undefined, {
			tokenBudget: 1_000_000,
			keepRecentTurns: 20,
			dedupeIdenticalToolResults: false,
		});

		const toolResults = out.messages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(2);
		expect(out.accounting.droppedByDedup).toBe(0);
	});

	it("dedupes a long run of identical consecutive tool results down to one", () => {
		const messages: AgentMessage[] = [makeUser("run", 1), makeAssistant("running", 2)];
		for (let i = 0; i < 5; i++) {
			messages.push(makeToolResult(`call-${i}`, "same payload", 3 + i));
		}
		const out = compileContext(messages, undefined, { tokenBudget: 1_000_000, keepRecentTurns: 20 });

		const toolResults = out.messages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(out.accounting.droppedByDedup).toBe(4);
	});
});

