/**
 * F2 cache markers — OpenAI provider deep integration.
 *
 * Exercises the full F2 wire-in pipeline end-to-end through the
 * `openai-completions` provider adapter, in the same order the SDK
 * runs them in production:
 *
 *   compileContext  →  annotateCacheMarkers  →  attachCachePlanToMessages
 *     →  checkEvidenceFreshness  →  annotateStaleness
 *     →  validateProviderProtocol
 *     →  openai-completions stream
 *
 * What this test covers that the Wave 17 end-to-end test does not:
 *
 *  - `compileContext` runs first, so the projection is the same
 *    shape the SDK ships to the adapter. (Wave 17 hand-rolls the
 *    `CompiledContext` to keep `packages/ai` decoupled from
 *    `compileContext`.)
 *  - `checkEvidenceFreshness` + `annotateStaleness` run between the
 *    cache wire-in and the protocol validator. The projection can
 *    therefore carry a `customType: "freshness-warning"` message at
 *    the head, and the validator still has to walk the result.
 *  - `validateProviderProtocol` runs last and may insert a synthetic
 *    user/assistant bridge (e.g. when the conversation starts with
 *    an assistant message). The cache plan must still be honoured
 *    after the validator rewrites the array.
 *
 * Mocking: `vi.mock("openai")` captures the wire payload and serves
 * a minimal SSE-like iterator. The provider sees a real
 * `Message[]` produced by the full F2 wire-in.
 */

import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Message, Model } from "../src/types.ts";
import {
	buildF2Projection,
	makeAssistantText,
	makeAssistantWithToolCall,
	makeToolResult,
	makeUser,
} from "./_f2-deep-integration-helpers.ts";

// ---------------------------------------------------------------------------
// Mock OpenAI client — captures the wire payload
// ---------------------------------------------------------------------------

interface CacheControl {
	type: "ephemeral";
	ttl?: string;
}

interface TextPart {
	type: string;
	text?: string;
	cache_control?: CacheControl;
}

interface ToolWithCacheControl {
	type: string;
	cache_control?: CacheControl;
}

interface CapturedParams {
	messages: Array<{
		role: string;
		content: string | TextPart[] | null;
	}>;
	tools?: ToolWithCacheControl[];
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedParams | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: CapturedParams) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-f2-deep",
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

// ---------------------------------------------------------------------------
// Model + adapter driver
// ---------------------------------------------------------------------------

const baseModel: Model<"openai-completions"> = {
	id: "custom-qwen",
	name: "Custom Qwen",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://example.com/v1",
	reasoning: true,
	input: ["text"],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	contextWindow: 128000,
	maxTokens: 32000,
	compat: {
		cacheControlFormat: "anthropic",
	},
};

async function runOpenAIStream(messages: import("@theta/agent-core").AgentMessage[]): Promise<CapturedParams> {
	// `AgentMessage` is structurally compatible with `Message` for the
	// user/assistant/toolResult roles. The `details` field is preserved
	// through the cast (TypeScript does not see it, but the runtime
	// object still carries it for the provider adapter to read).
	await streamOpenAICompletions(
		baseModel,
		{
			systemPrompt: "System prompt",
			messages: messages as Message[],
			tools: [
				{
					name: "read",
					description: "Read a file",
					parameters: Type.Object({ path: Type.String() }),
				},
			],
		},
		{ apiKey: "test-key" },
	).result();

	const params = mockState.lastParams;
	if (!params) {
		throw new Error("Expected payload to be captured");
	}
	return params;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("F2 cache markers — OpenAI deep integration (full wire-in through openai-completions)", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("runs compileContext + cache wire-in + freshness + protocol validation and emits cache_control at every F2 plan position", async () => {
		const ts = Date.now();
		const conversation = [
			makeUser("Read the file", ts),
			makeAssistantWithToolCall("read", { path: "README.md" }, ts + 1, "openai-completions"),
			makeToolResult(`call-${ts + 1}`, "file contents", ts + 2),
			makeUser("Thanks", ts + 3),
		];

		const { messages, cachePlan, validation, freshness } = buildF2Projection({
			conversation,
			render: {
				format: "anthropic",
				retention: "short",
				systemPrompt: true,
				lastTool: true,
				lastMessage: true,
			},
			provider: "openai",
		});

		// 1. The plan covers all three positions.
		const positions = new Set(cachePlan.markers.map((m) => m.marker.position));
		expect(positions).toEqual(new Set(["system", "last-tool", "last-message"]));

		// 2. The freshness step ran. No TaskState was supplied, so the
		//    report is empty and no freshness-warning was prepended.
		expect(freshness.checks).toEqual([]);
		expect(freshness.freshCount).toBe(0);

		// 3. The protocol validator passed (the conversation starts
		//    with a user message, so no synthetic bridge is needed).
		expect(validation.ok).toBe(true);
		expect(validation.fixedCount).toBe(0);

		// 4. The plan is attached to the last user message's details
		//    — the structural read the provider adapter depends on.
		const last = messages[messages.length - 1]! as Message & {
			details?: { cachePlan?: unknown };
		};
		expect(last.role).toBe("user");
		expect(last.details?.cachePlan).toBe(cachePlan);

		// 5. The adapter emits cache_control at every plan position.
		const params = await runOpenAIStream(messages);

		// system marker → first system/developer instruction message.
		const instruction = params.messages.find((m) => m.role === "system" || m.role === "developer");
		expect(instruction).toBeDefined();
		expect(Array.isArray(instruction?.content)).toBe(true);
		expect((instruction?.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });

		// last-tool marker → last tool definition.
		expect(params.tools).toBeDefined();
		const lastTool = params.tools?.[(params.tools?.length ?? 1) - 1];
		expect(lastTool?.cache_control).toEqual({ type: "ephemeral" });

		// last-message marker → last user message in the converted payload.
		const lastMessage = params.messages[params.messages.length - 1];
		expect(lastMessage.role).toBe("user");
		expect(Array.isArray(lastMessage.content)).toBe(true);
		expect((lastMessage.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });
	});

	it("emits cache_control only at the positions the F2 plan enables (last-message only)", async () => {
		const ts = Date.now();
		const conversation = [
			makeUser("Hi", ts),
			makeAssistantText("Hello", ts + 1, "openai-completions"),
			makeUser("Bye", ts + 2),
		];

		const { messages, cachePlan } = buildF2Projection({
			conversation,
			render: {
				format: "anthropic",
				retention: "short",
				systemPrompt: false,
				lastTool: false,
				lastMessage: true,
			},
			provider: "openai",
		});

		// The plan only covers the last-message position.
		const positions = new Set(cachePlan.markers.map((m) => m.marker.position));
		expect(positions).toEqual(new Set(["last-message"]));

		const params = await runOpenAIStream(messages);

		// system / last-tool must NOT be marked.
		const instruction = params.messages.find((m) => m.role === "system" || m.role === "developer");
		expect(instruction).toBeDefined();
		expect((instruction?.content as TextPart[])[0]?.cache_control).toBeUndefined();
		expect((params.tools ?? []).every((t) => t.cache_control === undefined)).toBe(true);

		// last-message marker → last user message.
		const lastMessage = params.messages[params.messages.length - 1];
		expect(lastMessage.role).toBe("user");
		expect((lastMessage.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });
	});

	it("adds ttl: 1h on the wire when the F2 plan's retention is long and the provider supports it", async () => {
		const ts = Date.now();
		const conversation = [
			makeUser("Read", ts),
			makeAssistantWithToolCall("read", { path: "x" }, ts + 1, "openai-completions"),
			makeToolResult(`call-${ts + 1}`, "ok", ts + 2),
			makeUser("Done", ts + 3),
		];

		// Note: the OpenAI provider in this test is configured with
		// `compat.cacheControlFormat: "anthropic"`. Long-retention TTL
		// is honoured at the format level (Anthropic-style `ttl: "1h"`)
		// even though OpenAI would not normally act on it. The adapter
		// is expected to pass the TTL through when `supportsLongCacheRetention`
		// is set; here we assert the structural form.
		const { messages } = buildF2Projection({
			conversation,
			render: {
				format: "anthropic",
				retention: "long",
				systemPrompt: true,
				lastTool: true,
				lastMessage: true,
			},
			provider: "openai",
		});

		const params = await runOpenAIStream(messages);

		const instruction = params.messages.find((m) => m.role === "system" || m.role === "developer");
		expect((instruction?.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

		const lastTool = params.tools?.[(params.tools?.length ?? 1) - 1];
		expect(lastTool?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

		const lastMessage = params.messages[params.messages.length - 1];
		expect((lastMessage.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	it("survives a synthetic bridge inserted by validateProviderProtocol and still emits cache_control at the F2 plan positions", async () => {
		// Conversation starts with an assistant message, which the
		// OpenAI protocol validator must fix by prepending a synthetic
		// user message. The F2 plan's `system` marker points at message
		// index 0 in the original projection; after the validator
		// inserts a bridge, the plan's `last-message` marker is still
		// at the new tail. The adapter must follow the plan, not the
		// original index.
		const ts = Date.now();
		const conversation = [
			makeAssistantText("I have already started", ts, "openai-completions"),
			makeAssistantWithToolCall("read", { path: "x" }, ts + 1, "openai-completions"),
			makeToolResult(`call-${ts + 1}`, "ok", ts + 2),
			makeUser("Continue", ts + 3),
		];

		const { messages, cachePlan, validation } = buildF2Projection({
			conversation,
			render: {
				format: "anthropic",
				retention: "short",
				systemPrompt: true,
				lastTool: true,
				lastMessage: true,
			},
			provider: "openai",
		});

		// The validator should have inserted at least one synthetic
		// bridge to satisfy the "first message must be user" rule.
		// The bridge is a `custom` message (`customType: "synthetic-bridge"`)
		// tagged with `details.synthetic: true` and `details.targetRole: "user"`;
		// the provider adapter renders it as the target role on the wire.
		// `validation.ok` may still be false because the validator
		// records the rule violation as an error before applying the
		// fix; what we care about is that the fix was actually applied.
		expect(validation.fixedCount).toBeGreaterThan(0);
		expect(validation.issues.some((i) => i.rule === "first-message-must-be-user")).toBe(true);
		const firstMessage = messages[0]! as Message & {
			details?: { synthetic?: boolean; targetRole?: string };
		};
		expect(firstMessage.role).toBe("custom");
		expect(firstMessage.details?.synthetic).toBe(true);
		expect(firstMessage.details?.targetRole).toBe("user");

		// The plan still covers all three positions.
		const positions = new Set(cachePlan.markers.map((m) => m.marker.position));
		expect(positions).toEqual(new Set(["system", "last-tool", "last-message"]));

		// The plan is still attached to the last user message after
		// the validator's bridge insertion.
		const last = messages[messages.length - 1]! as Message & {
			details?: { cachePlan?: unknown };
		};
		expect(last.role).toBe("user");
		expect(last.details?.cachePlan).toBe(cachePlan);

		const params = await runOpenAIStream(messages);

		// system marker → instruction message in the converted payload.
		const instruction = params.messages.find((m) => m.role === "system" || m.role === "developer");
		expect(instruction).toBeDefined();
		expect((instruction?.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });

		// last-message marker → last user message in the converted payload.
		const lastMessage = params.messages[params.messages.length - 1];
		expect(lastMessage.role).toBe("user");
		expect((lastMessage.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });
	});
});

