/**
 * F2 stable-rendering — Anthropic format.
 *
 * Verifies that `format: "anthropic"` produces markers of `type:
 * "ephemeral"` for every position.
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

describe("F2 stable-rendering — anthropic format", () => {
	it("uses type 'ephemeral' for every marker when format is anthropic", () => {
		const state = createInitialTaskState("s");
		const withState = { ...state, objective: { text: "Goal", createdAt: 1 } };
		const messages: AgentMessage[] = [makeUser("hi", 1)];
		const compiled = compileContext(messages, withState, { tokenBudget: 1_000_000 });

		const annotated = annotateCacheMarkers(compiled, {
			format: "anthropic",
			retention: "short",
			systemPrompt: true,
			lastTool: true,
			lastMessage: true,
		});

		const plan = annotated.cachePlan!;
		expect(plan.format).toBe("anthropic");
		// With the simple message set, systemPrompt and lastMessage both
		// land on the same user message (the first/only non-TaskState
		// message); lastTool falls back to the same position.
		expect(plan.markers.length).toBeGreaterThan(0);
		for (const { marker } of plan.markers) {
			expect(marker.type).toBe("ephemeral");
		}
	});

	it("still uses type 'ephemeral' for openai format (only ttl differs)", () => {
		const state = createInitialTaskState("s");
		const withState = { ...state, objective: { text: "Goal", createdAt: 1 } };
		const messages: AgentMessage[] = [makeUser("hi", 1)];
		const compiled = compileContext(messages, withState, { tokenBudget: 1_000_000 });

		const annotated = annotateCacheMarkers(compiled, {
			format: "openai",
			retention: "short",
			systemPrompt: true,
			lastTool: true,
			lastMessage: true,
		});

		const plan = annotated.cachePlan!;
		expect(plan.format).toBe("openai");
		for (const { marker } of plan.markers) {
			// Type stays "ephemeral" — only the `ttl` field is format-sensitive
			// (and only Anthropic supports it). The marker type does not
			// change with format.
			expect(marker.type).toBe("ephemeral");
		}
	});
});

