/**
 * F2 stable-rendering — stable/volatile split boundary.
 *
 * Verifies that the stable/volatile split happens between the
 * TaskState-injected messages and the volatile tail: the
 * `system` marker lands on the first message after the TaskState
 * run, and the `estimatedStablePrefixTokens` accounts for exactly
 * the TaskState-injected messages.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { annotateCacheMarkers } from "../src/core/cache-rendering.ts";
import { compileContext } from "../src/core/context-compiler.ts";
import { addConstraint, createInitialTaskState, recordDecision } from "../src/core/task-state.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

function makeAssistantText(text: string, ts: number): AssistantMessage {
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

function findTaskStateContextIndices(messages: AgentMessage[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i]!;
		if (m.role === "custom" && m.customType === "task-state-context") {
			out.push(i);
		}
	}
	return out;
}

describe("F2 stable-rendering — stable/volatile split", () => {
	it("the system marker lands on the first message AFTER the TaskState run", () => {
		let state = createInitialTaskState("s");
		state = { ...state, objective: { text: "Goal", createdAt: 1 } };
		state = addConstraint(state, { text: "No new deps", source: "user" });
		state = recordDecision(state, { text: "Use SQLite" });

		const messages: AgentMessage[] = [
			makeUser("first user", 1),
			makeAssistantText("first reply", 2),
			makeUser("second user", 3),
			makeAssistantText("second reply", 4),
		];
		const compiled = compileContext(messages, state, { tokenBudget: 1_000_000 });
		const annotated = annotateCacheMarkers(compiled, {
			format: "anthropic",
			retention: "short",
			systemPrompt: true,
			lastTool: true,
			lastMessage: true,
		});

		const taskStateIndices = findTaskStateContextIndices(annotated.messages);
		expect(taskStateIndices.length).toBeGreaterThan(0);

		// The TaskState-injected messages form a contiguous run at the head
		// of the projection.
		for (let i = 0; i < taskStateIndices.length; i++) {
			expect(taskStateIndices[i]).toBe(i);
		}

		const systemMarker = annotated.cachePlan!.markers.find((m) => m.marker.position === "system");
		expect(systemMarker).toBeDefined();

		// The system marker is the first index AFTER the TaskState run,
		// which is `taskStateIndices.length` for a contiguous head run.
		const firstNonTaskStateIndex = taskStateIndices.length;
		expect(systemMarker!.messageIndex).toBe(firstNonTaskStateIndex);
		// And the message at that index is a user message (the first
		// conversational message).
		expect(annotated.messages[firstNonTaskStateIndex]?.role).toBe("user");
	});

	it("stable token count covers only the TaskState-injected messages", () => {
		let state = createInitialTaskState("s");
		// 40-char objective wrapped in `## Objective\n${text}` -> 53
		// chars total body -> 14 tokens (ceil(53/4)).
		state = { ...state, objective: { text: "x".repeat(40), createdAt: 1 } };
		// 80-char volatile user message -> 20 tokens.
		const messages: AgentMessage[] = [makeUser("y".repeat(80), 1)];

		const compiled = compileContext(messages, state, { tokenBudget: 1_000_000 });
		const annotated = annotateCacheMarkers(compiled, {
			format: "anthropic",
			retention: "short",
			systemPrompt: true,
			lastTool: true,
			lastMessage: true,
		});

		const plan = annotated.cachePlan!;
		// One TaskState-injected message (objective) and one user message.
		expect(plan.estimatedStablePrefixTokens).toBe(14);
		expect(plan.estimatedVolatileSuffixTokens).toBe(20);
	});

	it("with no TaskState context, everything is volatile", () => {
		const messages: AgentMessage[] = [
			makeUser("first", 1),
			makeAssistantText("first reply", 2),
			makeUser("second", 3),
		];
		const compiled = compileContext(messages, undefined, { tokenBudget: 1_000_000 });
		const annotated = annotateCacheMarkers(compiled, {
			format: "anthropic",
			retention: "short",
			systemPrompt: true,
			lastTool: true,
			lastMessage: true,
		});

		const plan = annotated.cachePlan!;
		expect(plan.estimatedStablePrefixTokens).toBe(0);
		expect(plan.estimatedVolatileSuffixTokens).toBeGreaterThan(0);

		// The system marker is at index 0 because there is no stable prefix
		// to push it past.
		const systemMarker = plan.markers.find((m) => m.marker.position === "system");
		expect(systemMarker!.messageIndex).toBe(0);
	});
});

