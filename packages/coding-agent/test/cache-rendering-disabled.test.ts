/**
 * F2 stable-rendering — no markers when all 3 flags are false.
 *
 * Verifies that `annotateCacheMarkers` produces an empty plan when
 * `systemPrompt`, `lastTool`, and `lastMessage` are all disabled. The
 * `cachePlan` is still attached (for uniform shape) but the marker and
 * breakpoint arrays are empty.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { annotateCacheMarkers } from "../src/core/cache-rendering.ts";
import { compileContext } from "../src/core/context-compiler.ts";
import { createInitialTaskState } from "../src/core/task-state.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

describe("F2 stable-rendering — disabled", () => {
	it("produces no markers when all three flags are false", () => {
		const state = createInitialTaskState("s");
		const withState = { ...state, objective: { text: "Goal", createdAt: 1 } };
		const messages: AgentMessage[] = [makeUser("hi", 1)];
		const compiled = compileContext(messages, withState, { tokenBudget: 1_000_000 });

		const annotated = annotateCacheMarkers(compiled, {
			format: "anthropic",
			retention: "short",
			systemPrompt: false,
			lastTool: false,
			lastMessage: false,
		});

		expect(annotated.cachePlan).toBeDefined();
		expect(annotated.cachePlan!.markers).toEqual([]);
		expect(annotated.cachePlan!.breakpoints).toEqual([]);
	});

	it("does not write details.cacheMarkers onto toolResult messages when disabled", () => {
		const state = createInitialTaskState("s");
		const withState = { ...state, objective: { text: "Goal", createdAt: 1 } };
		const toolResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "x",
			toolName: "bash",
			content: [{ type: "text", text: "out" }],
			details: {},
			isError: false,
			timestamp: 2,
		};
		const compiled = compileContext([makeUser("hi", 1), toolResult], withState, { tokenBudget: 1_000_000 });

		const annotated = annotateCacheMarkers(compiled, {
			format: "anthropic",
			retention: "short",
			systemPrompt: false,
			lastTool: false,
			lastMessage: false,
		});

		for (const m of annotated.messages) {
			if (m.role === "custom" || m.role === "toolResult") {
				const details = (m as { details?: { cacheMarkers?: unknown } }).details;
				if (details) {
					expect(details.cacheMarkers).toBeUndefined();
				}
			}
		}
	});
});

