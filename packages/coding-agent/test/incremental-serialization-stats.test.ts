/**
 * F11 incremental serialization — getCacheStats correctness.
 *
 * `getCacheStats()` must report accurate hit, miss, and size counts
 * for typical call patterns: repeated identical calls, mixed hit/miss
 * patterns, and `resetStats()`.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, UserMessage } from "@theta/ai";
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

describe("F11 incremental serialization — getCacheStats", () => {
	it("starts at zero hits, zero misses, zero size", () => {
		const serializer = new IncrementalSerializer();
		expect(serializer.getCacheStats()).toEqual({ hits: 0, misses: 0, size: 0 });
	});

	it("counts one miss and one hit for an identical repeat call", () => {
		const serializer = new IncrementalSerializer();
		const msg: AgentMessage = makeUser("hi", 1);

		convertToLlmIncremental(serializer, [msg]);
		convertToLlmIncremental(serializer, [msg]);

		expect(serializer.getCacheStats()).toEqual({ hits: 1, misses: 1, size: 1 });
	});

	it("counts per-message, not per-call", () => {
		const serializer = new IncrementalSerializer();
		const a = makeUser("a", 1);
		const b: AgentMessage = makeAssistantWithToolCall("bash", { x: 1 }, 2);
		const c = makeUser("c", 3);

		convertToLlmIncremental(serializer, [a, b, c]); // 3 misses
		convertToLlmIncremental(serializer, [a, b, c]); // 3 hits

		expect(serializer.getCacheStats()).toEqual({ hits: 3, misses: 3, size: 3 });
	});

	it("does not double-count `size` when an existing message is re-serialized after a change", () => {
		const serializer = new IncrementalSerializer();
		const msg: AgentMessage = makeUser("v1", 1);

		convertToLlmIncremental(serializer, [msg]);
		expect(serializer.getCacheStats().size).toBe(1);

		(msg as UserMessage).content = "v2";
		convertToLlmIncremental(serializer, [msg]);

		// Same message, just a new hash; size stays at 1, misses becomes 2.
		expect(serializer.getCacheStats().size).toBe(1);
		expect(serializer.getCacheStats().misses).toBe(2);
		expect(serializer.getCacheStats().hits).toBe(0);
	});

	it("resetStats() zeroes the counters without dropping cached entries", () => {
		const serializer = new IncrementalSerializer();
		const msg: AgentMessage = makeUser("hi", 1);

		convertToLlmIncremental(serializer, [msg]);
		convertToLlmIncremental(serializer, [msg]);
		expect(serializer.getCacheStats().hits).toBe(1);
		expect(serializer.getCacheStats().misses).toBe(1);

		serializer.resetStats();
		expect(serializer.getCacheStats()).toEqual({ hits: 0, misses: 0, size: 1 });

		// Cached entry is still warm: the next call is a hit, not a miss.
		convertToLlmIncremental(serializer, [msg]);
		expect(serializer.getCacheStats()).toEqual({ hits: 1, misses: 0, size: 1 });
	});
});

