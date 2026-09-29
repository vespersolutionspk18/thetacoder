import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Message, Model } from "../src/types.ts";

// Structural mirrors of the F2 plan shape.
type PlanPosition = "system" | "last-tool" | "last-message";

interface PlanMarker {
	position: PlanPosition;
	type: "ephemeral";
	ttl?: "1h";
}

interface CachePlan {
	breakpoints: number[];
	estimatedStablePrefixTokens: number;
	estimatedVolatileSuffixTokens: number;
	markers: Array<{ messageIndex: number; marker: PlanMarker }>;
	format: "anthropic" | "openai";
	retention: "short" | "long";
}

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

function buildPlan(retention: "short" | "long", positions: PlanPosition[]): CachePlan {
	const markers: PlanMarker[] = positions.map((position) => ({ position, type: "ephemeral" }));
	return {
		breakpoints: [],
		estimatedStablePrefixTokens: 0,
		estimatedVolatileSuffixTokens: 0,
		markers: markers.map((marker, i) => ({ messageIndex: i, marker })),
		format: "anthropic",
		retention,
	};
}

function withCachePlan(message: Message, plan: CachePlan): Message {
	return { ...message, details: { cachePlan: plan } } as Message;
}

describe("openai-completions F2 cachePlan system-only", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("applies cache_control only to the system message when the plan only contains a system marker", async () => {
		const timestamp = Date.now();
		const plan = buildPlan("short", ["system"]);
		const messages: Message[] = [
			{ role: "user", content: "Hi", timestamp },
			withCachePlan({ role: "user", content: "Bye", timestamp }, plan),
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

		// system marker IS present → system gets cache_control
		const instruction = params.messages.find((m) => m.role === "system" || m.role === "developer");
		expect(instruction).toBeDefined();
		expect(Array.isArray(instruction?.content)).toBe(true);
		expect((instruction?.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });

		// last-tool marker is NOT in the plan → no cache_control on tools
		expect(params.tools?.[0]?.cache_control).toBeUndefined();

		// last-message marker is NOT in the plan → no cache_control on last message.
		// The walker would have set the last text content to a string in this case
		// (since no cache_control is added, no conversion to a parts array happens).
		const lastMessage = params.messages[params.messages.length - 1];
		if (Array.isArray(lastMessage.content)) {
			const lastPart = lastMessage.content[lastMessage.content.length - 1] as TextPart;
			expect(lastPart.cache_control).toBeUndefined();
		} else {
			// String content → no cache_control was set
			expect(typeof lastMessage.content).toBe("string");
		}
	});
});

