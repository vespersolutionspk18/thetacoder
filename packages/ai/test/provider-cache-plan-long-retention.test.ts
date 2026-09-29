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
		supportsLongCacheRetention: true,
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

describe("openai-completions F2 cachePlan long retention", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("emits ttl: '1h' when retention is long and the model supports long retention", async () => {
		const timestamp = Date.now();
		const plan = buildPlan("long", ["system", "last-tool", "last-message"]);
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
			{ apiKey: "test-key", cacheRetention: "long" },
		).result();

		const params = mockState.lastParams;
		expect(params).toBeDefined();
		if (!params) throw new Error("Expected payload to be captured");

		const expected = { type: "ephemeral" as const, ttl: "1h" as const };

		// system
		const instruction = params.messages.find((m) => m.role === "system" || m.role === "developer");
		expect((instruction?.content as TextPart[])[0]?.cache_control).toEqual(expected);

		// last-tool
		expect(params.tools?.[0]?.cache_control).toEqual(expected);

		// last-message
		const lastMessage = params.messages[params.messages.length - 1];
		expect((lastMessage.content as TextPart[])[0]?.cache_control).toEqual(expected);
	});
});

