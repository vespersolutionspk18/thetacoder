/**
 * F11 incremental serialization — basic cache-hit behavior.
 *
 * Verifies that converting the same AgentMessage twice via the
 * `IncrementalSerializer` produces the same Message both times and
 * that the second call is a cache hit (no re-serialization).
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, Message, UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { convertToLlmIncremental, IncrementalSerializer } from "../src/core/incremental-serialization.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

function makeAssistantWithToolCall(name: string, args: unknown, ts: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `call-${ts}`, name, arguments: args as Record<string, unknown> }],
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

describe("F11 incremental serialization — basic cache hit", () => {
	it("returns the same Message object on a second convert of the same AgentMessage", () => {
		const serializer = new IncrementalSerializer();
		const assistant: AgentMessage = makeAssistantWithToolCall("bash", { cmd: "ls" }, 1);

		const first = convertToLlmIncremental(serializer, [assistant]);
		const second = convertToLlmIncremental(serializer, [assistant]);

		expect(first).toHaveLength(1);
		expect(second).toHaveLength(1);
		// Cache hit: same object reference, not a freshly built Message.
		expect(second[0]).toBe(first[0]);

		const stats = serializer.getCacheStats();
		expect(stats.misses).toBe(1);
		expect(stats.hits).toBe(1);
	});

	it("caches user messages too", () => {
		const serializer = new IncrementalSerializer();
		const user: AgentMessage = makeUser("hello", 1);

		const first = convertToLlmIncremental(serializer, [user]);
		const second = convertToLlmIncremental(serializer, [user]);

		expect(second[0]).toBe(first[0]);
		expect(serializer.getCacheStats().hits).toBe(1);
	});

	it("caches per-message across a multi-message array", () => {
		const serializer = new IncrementalSerializer();
		const a = makeUser("first", 1);
		const b: AgentMessage = makeAssistantWithToolCall("read", { path: "/tmp/x" }, 2);
		const c = makeUser("third", 3);

		const first = convertToLlmIncremental(serializer, [a, b, c]);
		const second = convertToLlmIncremental(serializer, [a, b, c]);

		expect(first.map((m: Message) => m)).toEqual(second);
		// Every entry in the second call is a cache hit.
		const stats = serializer.getCacheStats();
		expect(stats.hits).toBe(3);
		expect(stats.misses).toBe(3);
		expect(stats.size).toBe(3);
	});
});

