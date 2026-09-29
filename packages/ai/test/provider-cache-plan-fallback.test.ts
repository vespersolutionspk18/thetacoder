import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Message, Model } from "../src/types.ts";

interface CacheControl {
	type: "ephemeral";
	ttl?: string;
}

interface TextPart {
	type: "text";
	text: string;
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
								id: "chatcmpl-test",
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

describe("openai-completions F2 cachePlan fallback", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("falls back to the positional walker when no cachePlan is present", async () => {
		const timestamp = Date.now();
		const messages: Message[] = [
			{ role: "user", content: "Read the file", timestamp },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } }],
				api: "openai-completions",
				provider: "openrouter",
				model: baseModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp,
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text", text: "file contents" }],
				isError: false,
				timestamp,
			},
			{ role: "user", content: "Thanks", timestamp },
		];

		await streamOpenAICompletions(
			baseModel,
			{
				systemPrompt: "System prompt",
				messages,
				tools: [
					{
						name: "read",
						description: "Read a file",
						parameters: Type.Object({
							path: Type.String(),
						}),
					},
				],
			},
			{ apiKey: "test-key" },
		).result();

		const params = mockState.lastParams;
		expect(params).toBeDefined();
		if (!params) throw new Error("Expected payload to be captured");

		// system → first instruction message
		const instruction = params.messages.find((m) => m.role === "system" || m.role === "developer");
		expect(instruction).toBeDefined();
		expect(Array.isArray(instruction?.content)).toBe(true);
		expect((instruction?.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });

		// last-tool → last tool definition
		expect(params.tools).toHaveLength(1);
		expect(params.tools?.[0]?.cache_control).toEqual({ type: "ephemeral" });

		// last-message → last user/assistant/tool message
		const lastMessage = params.messages[params.messages.length - 1];
		expect(lastMessage.role).toBe("user");
		expect(Array.isArray(lastMessage.content)).toBe(true);
		expect((lastMessage.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });
	});

	it("falls back to the positional walker when the last user message has no cachePlan in details", async () => {
		const timestamp = Date.now();
		const messages: Message[] = [
			{ role: "user", content: "Hello", timestamp },
			// Last message has `details` but no `cachePlan` → fallback
			{ role: "user", content: "Followup", timestamp, details: { unrelated: true } } as Message,
		];

		await streamOpenAICompletions(
			baseModel,
			{
				systemPrompt: "System prompt",
				messages,
			},
			{ apiKey: "test-key" },
		).result();

		const params = mockState.lastParams;
		expect(params).toBeDefined();
		if (!params) throw new Error("Expected payload to be captured");

		// Positional walker should still mark the system message
		const instruction = params.messages.find((m) => m.role === "system" || m.role === "developer");
		expect(instruction).toBeDefined();
		expect((instruction?.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });

		// And the last conversation message
		const lastMessage = params.messages[params.messages.length - 1];
		expect(lastMessage.role).toBe("user");
		expect((lastMessage.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });
	});
});

