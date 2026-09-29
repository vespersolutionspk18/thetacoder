/**
 * F2 stable-rendering — long retention (1h TTL).
 *
 * Verifies that `retention: "long"` produces a `ttl: "1h"` field on
 * every marker.
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

describe("F2 stable-rendering — long retention", () => {
	it("emits ttl: '1h' on every marker when retention is 'long'", () => {
		const state = createInitialTaskState("s");
		const withState = { ...state, objective: { text: "Goal", createdAt: 1 } };
		const messages: AgentMessage[] = [makeUser("hi", 1)];
		const compiled = compileContext(messages, withState, { tokenBudget: 1_000_000 });

		const annotated = annotateCacheMarkers(compiled, {
			format: "anthropic",
			retention: "long",
			systemPrompt: true,
			lastTool: true,
			lastMessage: true,
		});

		const plan = annotated.cachePlan!;
		expect(plan.retention).toBe("long");
		expect(plan.markers.length).toBeGreaterThan(0);
		for (const { marker } of plan.markers) {
			expect(marker.ttl).toBe("1h");
		}
	});
});

