/**
 * F2 cache-plan end-to-end through the openai-completions adapter.
 *
 * Simulates the F2 wire-in done by `packages/coding-agent/src/core/sdk.ts`:
 * after `annotateCacheMarkers` produces a `CachePlan`, the wire-in
 * attaches the plan to the last user/assistant message's `details`.
 * This test feeds a request through the openai-completions adapter with
 * the plan attached the way the SDK now does it, and asserts the wire
 * payload carries `cache_control` at every position the plan declared.
 *
 * The test does not import the F2 wire-in helper directly — instead it
 * mirrors its effect by hand to keep `packages/ai` independent of
 * `packages/coding-agent` and verify only the contract the adapter
 * relies on (a `cachePlan` shape on `message.details`).
 */

import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Message, Model } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Structural mirrors of the F2 plan shape
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mock OpenAI client
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fixtures
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

/**
 * Build a plan with the given positions. `messageIndex` is informational
 * only — the adapter reads positions from each marker and walks the
 * converted messages; we use sequential indices that match the order
 * the adapter will see them in.
 */
function buildPlan(retention: "short" | "long", positions: PlanPosition[]): CachePlan {
	return {
		breakpoints: [],
		estimatedStablePrefixTokens: 0,
		estimatedVolatileSuffixTokens: 0,
		markers: positions.map((position, i) => ({
			messageIndex: i,
			marker: { position, type: "ephemeral" },
		})),
		format: "anthropic",
		retention,
	};
}

/**
 * Mirror of the F2 wire-in: attach the plan to a user/assistant
 * message's `details` field. The provider adapter reads the plan
 * structurally from `details.cachePlan`.
 */
function withCachePlan(message: Message, plan: CachePlan): Message {
	return { ...message, details: { cachePlan: plan } } as Message;
}

async function capturePayload(
	model: Model<"openai-completions">,
	messages: Message[],
	options?: { cacheRetention?: "none" | "short" | "long" },
): Promise<CapturedParams> {
	await streamOpenAICompletions(
		model,
		{
			systemPrompt: "System prompt",
			messages,
			tools: [
				{
					name: "read",
					description: "Read a file",
					parameters: Type.Object({ path: Type.String() }),
				},
			],
		},
		{ apiKey: "test-key", ...options },
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

describe("F2 cache-plan end-to-end through openai-completions", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("emits cache_control at every position the F2 plan declares (full plan)", async () => {
		const timestamp = Date.now();
		const plan = buildPlan("short", ["system", "last-tool", "last-message"]);
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
			withCachePlan({ role: "user", content: "Thanks", timestamp }, plan),
		];

		const params = await capturePayload(baseModel, messages);

		// system marker → first instruction message in the converted payload
		const instruction = params.messages.find((m) => m.role === "system" || m.role === "developer");
		expect(instruction).toBeDefined();
		expect(Array.isArray(instruction?.content)).toBe(true);
		expect((instruction?.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });

		// last-tool marker → last tool definition
		expect(params.tools).toBeDefined();
		expect((params.tools ?? []).length).toBeGreaterThan(0);
		const lastTool = params.tools?.[(params.tools?.length ?? 1) - 1];
		expect(lastTool?.cache_control).toEqual({ type: "ephemeral" });

		// last-message marker → last user/assistant/tool message
		const lastMessage = params.messages[params.messages.length - 1];
		expect(lastMessage.role).toBe("user");
		expect(Array.isArray(lastMessage.content)).toBe(true);
		expect((lastMessage.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });
	});

	it("only emits cache_control at the positions the plan enables (last-message only)", async () => {
		const timestamp = Date.now();
		const plan = buildPlan("short", ["last-message"]);
		const messages: Message[] = [
			{ role: "user", content: "Hi", timestamp },
			withCachePlan({ role: "user", content: "Bye", timestamp }, plan),
		];

		const params = await capturePayload(baseModel, messages);

		// The plan does NOT include the system or last-tool positions,
		// so neither should be marked on the wire.
		const instruction = params.messages.find((m) => m.role === "system" || m.role === "developer");
		expect(instruction).toBeDefined();
		expect((instruction?.content as TextPart[])[0]?.cache_control).toBeUndefined();
		expect((params.tools ?? []).every((t) => t.cache_control === undefined)).toBe(true);

		// last-message marker → last user message
		const lastMessage = params.messages[params.messages.length - 1];
		expect(lastMessage.role).toBe("user");
		expect((lastMessage.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });
	});

	it("adds ttl: 1h when retention is long and the model supports it", async () => {
		const timestamp = Date.now();
		const plan = buildPlan("long", ["system", "last-tool", "last-message"]);
		const messages: Message[] = [
			{ role: "user", content: "Read", timestamp },
			withCachePlan({ role: "user", content: "Done", timestamp }, plan),
		];

		const params = await capturePayload(baseModel, messages, { cacheRetention: "long" });

		const instruction = params.messages.find((m) => m.role === "system" || m.role === "developer");
		expect((instruction?.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

		const lastTool = params.tools?.[(params.tools?.length ?? 1) - 1];
		expect(lastTool?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

		const lastMessage = params.messages[params.messages.length - 1];
		expect((lastMessage.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	it("does not add ttl when retention is short even on a long-capable model", async () => {
		const timestamp = Date.now();
		const plan = buildPlan("short", ["last-message"]);
		const messages: Message[] = [
			{ role: "user", content: "Read", timestamp },
			withCachePlan({ role: "user", content: "Done", timestamp }, plan),
		];

		const params = await capturePayload(baseModel, messages, { cacheRetention: "long" });

		const lastMessage = params.messages[params.messages.length - 1];
		expect((lastMessage.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });
	});

	it("falls back to the positional walker when no user/assistant message carries a cachePlan", async () => {
		const timestamp = Date.now();
		// No plan on the last user message → adapter falls back to the
		// legacy positional walker.
		const messages: Message[] = [
			{ role: "user", content: "Hi", timestamp },
			{ role: "user", content: "Followup", timestamp },
		];

		const params = await capturePayload(baseModel, messages);

		const instruction = params.messages.find((m) => m.role === "system" || m.role === "developer");
		expect((instruction?.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });

		const lastMessage = params.messages[params.messages.length - 1];
		expect((lastMessage.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });
	});
});

