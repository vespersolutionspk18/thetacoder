/**
 * F2 stable-rendering — cache marker placement (all 3 markers enabled).
 *
 * Verifies that `annotateCacheMarkers` places a marker at each of the
 * three documented breakpoints when all three are enabled:
 *   1. system      — on the first non-TaskState message
 *   2. last-tool   — on the first assistant message with tool calls
 *   3. last-message — on the last user/assistant/toolResult message
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { annotateCacheMarkers } from "../src/core/cache-rendering.ts";
import { compileContext } from "../src/core/context-compiler.ts";
import { createInitialTaskState } from "../src/core/task-state.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

function makeAssistant(
	blocks: AssistantMessage["content"],
	ts: number,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content: blocks,
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

function makeAssistantText(text: string, ts: number): AssistantMessage {
	return makeAssistant([{ type: "text", text }], ts);
}

function makeAssistantWithToolCall(name: string, args: unknown, ts: number): AssistantMessage {
	return makeAssistant(
		[
			{
				type: "toolCall",
				id: `call-${ts}`,
				name,
				arguments: args as Record<string, unknown>,
			},
		],
		ts,
		"toolUse",
	);
}

function makeToolResult(toolCallId: string, text: string, ts: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		details: {},
		isError: false,
		timestamp: ts,
	};
}

describe("F2 stable-rendering — basic marker placement", () => {
	it("places 3 markers at the documented breakpoints when all are enabled", () => {
		const state = createInitialTaskState("s");
		const withState = {
			...state,
			objective: { text: "Ship the F2 layer", createdAt: 1 },
		};
		const messages: AgentMessage[] = [
			makeUser("first", 1),
			makeAssistantText("first reply", 2),
			makeUser("second", 3),
			makeAssistantWithToolCall("bash", { command: "ls" }, 4),
			makeToolResult("call-4", "README.md", 5),
			makeAssistantText("done", 6),
		];

		const compiled = compileContext(messages, withState, { tokenBudget: 1_000_000 });
		const annotated = annotateCacheMarkers(compiled, {
			format: "anthropic",
			retention: "short",
			systemPrompt: true,
			lastTool: true,
			lastMessage: true,
		});

		// A cache plan must be present.
		expect(annotated.cachePlan).toBeDefined();
		const plan = annotated.cachePlan!;

		// Three markers, one per position.
		expect(plan.markers).toHaveLength(3);
		expect(plan.breakpoints).toHaveLength(3);

		// The system marker is on the first non-TaskState message. With an
		// objective set, the projection looks like:
		//   [0] task-state-context (objective)
		//   [1] first user           <-- system marker here
		//   [2] first assistant
		//   [3] second user
		//   [4] assistant with tool  <-- last-tool marker here
		//   [5] tool result
		//   [6] last assistant       <-- last-message marker here
		const systemMarker = plan.markers.find((m) => m.marker.position === "system");
		const lastToolMarker = plan.markers.find((m) => m.marker.position === "last-tool");
		const lastMessageMarker = plan.markers.find((m) => m.marker.position === "last-message");

		expect(systemMarker).toBeDefined();
		expect(lastToolMarker).toBeDefined();
		expect(lastMessageMarker).toBeDefined();

		expect(systemMarker!.marker.type).toBe("ephemeral");
		expect(lastToolMarker!.marker.type).toBe("ephemeral");
		expect(lastMessageMarker!.marker.type).toBe("ephemeral");

		// The first non-TaskState message is the first user message.
		expect(annotated.messages[systemMarker!.messageIndex]?.role).toBe("user");

		// The first assistant message with tool calls is at the index of
		// the assistant message containing a toolCall block.
		expect(annotated.messages[lastToolMarker!.messageIndex]?.role).toBe("assistant");
		const toolMsg = annotated.messages[lastToolMarker!.messageIndex] as AssistantMessage;
		expect(toolMsg.content.some((b) => b.type === "toolCall")).toBe(true);

		// The last-message marker lands on the last terminal message.
		expect(annotated.messages[lastMessageMarker!.messageIndex]?.role).toBe("assistant");
		expect(lastMessageMarker!.messageIndex).toBe(annotated.messages.length - 1);

		// Breakpoints reflect the same indices.
		expect(plan.breakpoints).toContain(systemMarker!.messageIndex);
		expect(plan.breakpoints).toContain(lastToolMarker!.messageIndex);
		expect(plan.breakpoints).toContain(lastMessageMarker!.messageIndex);
	});

	it("does not mutate the input CompiledContext", () => {
		const state = createInitialTaskState("s");
		const withState = { ...state, objective: { text: "Goal", createdAt: 1 } };
		const messages: AgentMessage[] = [makeUser("hi", 1)];
		const compiled = compileContext(messages, withState, { tokenBudget: 1_000_000 });
		const beforeJson = JSON.stringify(compiled);
		annotateCacheMarkers(compiled, {
			format: "anthropic",
			retention: "short",
			systemPrompt: true,
			lastTool: true,
			lastMessage: true,
		});
		const afterJson = JSON.stringify(compiled);
		expect(afterJson).toBe(beforeJson);
		expect(compiled.cachePlan).toBeUndefined();
	});

	it("returns a CompiledContext with a cachePlan even when messages is empty", () => {
		const compiled = compileContext([], undefined, { tokenBudget: 1000 });
		const annotated = annotateCacheMarkers(compiled, {
			format: "anthropic",
			retention: "short",
			systemPrompt: true,
			lastTool: true,
			lastMessage: true,
		});
		expect(annotated.cachePlan).toBeDefined();
		expect(annotated.cachePlan!.markers).toEqual([]);
		expect(annotated.cachePlan!.breakpoints).toEqual([]);
	});
});

