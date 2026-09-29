import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Message, Model } from "../src/types.ts";

// Structural mirrors of the F2 plan shape. The provider adapter reads them
// duck-typed from `details.cachePlan` on the last user/assistant message.
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

interface SystemBlock {
	type: "text";
	text: string;
	cache_control?: { type: "ephemeral"; ttl?: string };
}

interface AnthropicTool {
	name: string;
	cache_control?: { type: "ephemeral"; ttl?: string };
}

interface AnthropicMessageBlock {
	type: string;
	cache_control?: { type: "ephemeral"; ttl?: string };
}

interface AnthropicMessage {
	role: string;
	content: string | AnthropicMessageBlock[];
}

interface CapturedParams {
	system?: SystemBlock[];
	messages: AnthropicMessage[];
	tools?: AnthropicTool[];
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedParams | undefined,
}));

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const minimalAnthropicEvents = [
	{
		event: "message_start",
		data: JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_test",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		}),
	},
	{
		event: "content_block_start",
		data: JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
	},
	{
		event: "content_block_delta",
		data: JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "Hello" },
		}),
	},
	{
		event: "content_block_stop",
		data: JSON.stringify({ type: "content_block_stop", index: 0 }),
	},
	{
		event: "message_delta",
		data: JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 12,
				output_tokens: 5,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		}),
	},
	{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
];

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		beta: {
			messages: {
				create: (params: CapturedParams) => {
					mockState.lastParams = params;
					return {
						asResponse: async () => response,
					};
				},
			},
		},
	} as unknown as Anthropic;
}

const baseModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
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

async function capturePayload(
	model: Model<"anthropic-messages">,
	messages: Message[],
	options?: { cacheRetention?: "none" | "short" | "long" },
): Promise<CapturedParams> {
	const response = createSseResponse(minimalAnthropicEvents);
	await streamAnthropic(
		model,
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
		{ client: createFakeAnthropicClient(response), ...options },
	).result();

	if (!mockState.lastParams) {
		throw new Error("Expected payload to be captured");
	}

	return mockState.lastParams;
}

describe("anthropic-messages F2 cachePlan consumption", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("honours a full cachePlan (system + last-tool + last-message)", async () => {
		const timestamp = Date.now();
		const plan = buildPlan("short", ["system", "last-tool", "last-message"]);
		const messages: Message[] = [
			{ role: "user", content: "Read the file", timestamp },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } }],
				api: "anthropic-messages",
				provider: "anthropic",
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
			withCachePlan({ role: "user", content: "Thanks", timestamp }, plan),
		];

		const params = await capturePayload(baseModel, messages);

		// system marker → every system block
		expect(params.system).toBeDefined();
		expect(params.system?.length).toBeGreaterThan(0);
		for (const block of params.system ?? []) {
			expect(block.cache_control).toEqual({ type: "ephemeral" });
		}

		// last-tool marker → last tool definition
		expect(params.tools).toBeDefined();
		expect((params.tools ?? []).length).toBeGreaterThan(0);
		const lastTool = params.tools?.[(params.tools?.length ?? 1) - 1];
		expect(lastTool?.cache_control).toEqual({ type: "ephemeral" });

		// last-message marker → last user message
		const lastMessage = params.messages[params.messages.length - 1];
		expect(lastMessage.role).toBe("user");
		if (Array.isArray(lastMessage.content)) {
			const lastBlock = lastMessage.content[lastMessage.content.length - 1];
			expect(lastBlock?.cache_control).toEqual({ type: "ephemeral" });
		} else {
			expect.fail("Expected last message content to be an array");
		}
	});
});

