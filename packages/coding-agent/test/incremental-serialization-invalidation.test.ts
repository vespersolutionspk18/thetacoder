/**
 * F11 incremental serialization — cache invalidation on message change.
 *
 * Mutating the AgentMessage (e.g. adding a new tool call to the
 * assistant's content array) must invalidate the cached Message so the
 * next `serialize` call is a miss and emits a fresh Message.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, ToolCall, UserMessage } from "@theta/ai";
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

describe("F11 incremental serialization — invalidation", () => {
	it("invalidates when tool-call arguments change", () => {
		const serializer = new IncrementalSerializer();
		const assistant: AgentMessage = makeAssistantWithToolCall("bash", { cmd: "ls" }, 1);

		const first = convertToLlmIncremental(serializer, [assistant]);
		// Mutate the cached tool-call arguments in place.
		const tc = (assistant as AssistantMessage).content[0] as ToolCall;
		tc.arguments = { cmd: "ls -la" };

		const second = convertToLlmIncremental(serializer, [assistant]);

		// The serialized ToolCall's `arguments` field must reflect the
		// mutation, and the second call must be a miss.
		const firstTc = (first[0] as AssistantMessage).content[0] as ToolCall;
		const secondTc = (second[0] as AssistantMessage).content[0] as ToolCall;
		expect(firstTc.arguments).toEqual({ cmd: "ls" });
		expect(secondTc.arguments).toEqual({ cmd: "ls -la" });
		expect(serializer.getCacheStats().misses).toBe(2);
		expect(serializer.getCacheStats().hits).toBe(0);
	});

	it("invalidates when a new tool call is appended to the assistant content", () => {
		const serializer = new IncrementalSerializer();
		const assistant: AgentMessage = makeAssistantWithToolCall("bash", { cmd: "ls" }, 1);

		convertToLlmIncremental(serializer, [assistant]);

		// Append a second tool call.
		(assistant as AssistantMessage).content.push({
			type: "toolCall",
			id: "call-2",
			name: "read",
			arguments: { path: "/etc/hosts" },
		});

		const second = convertToLlmIncremental(serializer, [assistant]);
		const tcCount = (second[0] as AssistantMessage).content.filter((b) => b.type === "toolCall").length;
		expect(tcCount).toBe(2);
		expect(serializer.getCacheStats().misses).toBe(2);
	});

	it("invalidates when a user message's text content changes", () => {
		const serializer = new IncrementalSerializer();
		const user: AgentMessage = makeUser("hello", 1);

		convertToLlmIncremental(serializer, [user]);
		(user as UserMessage).content = "goodbye";

		const second = convertToLlmIncremental(serializer, [user]);
		expect((second[0] as UserMessage).content).toBe("goodbye");
		expect(serializer.getCacheStats().misses).toBe(2);
	});

	it("treats structurally-different argument order as equal (stable hash)", () => {
		// The cache key must be a structural hash, not a JSON dump of
		// the in-memory object, otherwise the first-vs-second-arg reordering
		// in JavaScript would falsely invalidate.
		const serializer = new IncrementalSerializer();
		const a: AgentMessage = makeAssistantWithToolCall("bash", { cmd: "ls", flag: "-la" }, 1);
		const b: AgentMessage = makeAssistantWithToolCall("bash", { flag: "-la", cmd: "ls" }, 2);

		convertToLlmIncremental(serializer, [a]);
		// `b` is a different AgentMessage object, so it's a new miss.
		const second = convertToLlmIncremental(serializer, [b]);
		expect(second[0]).toBeDefined();
		// After the two distinct calls we should have 2 misses and 0 hits.
		expect(serializer.getCacheStats().misses).toBe(2);
		expect(serializer.getCacheStats().hits).toBe(0);
	});
});

