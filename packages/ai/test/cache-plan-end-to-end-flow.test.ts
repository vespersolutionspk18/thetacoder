/**
 * F2 cache plan end-to-end flow through the openai-completions adapter.
 *
 * Exercises the F2 wire-in pipeline in `packages/coding-agent/src/core/sdk.ts`
 * step by step:
 *   1. Build a real conversation as `AgentMessage[]`.
 *   2. Run `annotateCacheMarkers` to compute a `CachePlan`.
 *   3. Run `attachCachePlanToMessages` (the F2 wire-in helper) to attach the
 *      plan to the last user/assistant message's `details`.
 *   4. Call the openai-completions provider with a mocked HTTP layer
 *      (`vi.mock("openai")`) and assert the wire payload carries
 *      `cache_control` at every position the plan declared.
 *
 * This test complements `f2-cache-plan-end-to-end.test.ts` (which mirrors
 * the wire-in by hand to keep `packages/ai` independent of
 * `packages/coding-agent`). This one uses the real F2 helpers so a future
 * change to either side of the wire-in is caught by the same assertion.
 */

import type { AgentMessage } from "@theta/agent-core";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	annotateCacheMarkers,
	attachCachePlanToMessages,
	type CachePlan,
} from "../../coding-agent/src/core/cache-rendering.ts";
import type { CompiledContext } from "../../coding-agent/src/core/context-compiler.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessage, Message, Model, ToolResultMessage, UserMessage } from "../src/types.ts";

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

const zeroAccounting: CompiledContext["accounting"] = {
	keptUserMessages: 0,
	keptAssistantMessages: 0,
	keptToolResults: 0,
	keptCompactionSummaries: 0,
	keptCustomMessages: 0,
	droppedByBudget: 0,
	droppedByDedup: 0,
	droppedByCompactionBoundary: 0,
	taskStateInjectedMessages: 0,
};

function makeUser(text: string, ts: number): AgentMessage & UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

function makeAssistantWithToolCall(name: string, args: unknown, ts: number): AgentMessage & AssistantMessage {
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
		api: "openai-completions",
		provider: "openrouter",
		model: baseModel.id,
		timestamp: ts,
	};
}

function makeAssistantText(text: string, ts: number): AgentMessage & AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		api: "openai-completions",
		provider: "openrouter",
		model: baseModel.id,
		timestamp: ts,
	};
}

function makeToolResult(toolCallId: string, text: string, ts: number): AgentMessage & ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: ts,
	};
}

// ---------------------------------------------------------------------------
// Pipeline driver — mirrors what `sdk.ts` does in the `compile` callback
// ---------------------------------------------------------------------------

interface RenderOptions {
	format: "anthropic" | "openai";
	retention: "short" | "long";
	systemPrompt: boolean;
	lastTool: boolean;
	lastMessage: boolean;
}

/**
 * Run the F2 wire-in pipeline:
 *   annotateCacheMarkers → attachCachePlanToMessages
 * The returned array is the projection the provider adapter sees (with the
 * `cachePlan` and per-position `cacheMarkers` attached to the appropriate
 * messages). The plan is returned alongside for assertions.
 */
function runF2WireIn(messages: AgentMessage[], options: RenderOptions): { messages: AgentMessage[]; plan: CachePlan } {
	const compiled: CompiledContext = {
		messages,
		droppedCount: 0,
		keptTokens: 0,
		budgetUsed: 0,
		accounting: zeroAccounting,
	};
	const annotated = annotateCacheMarkers(compiled, options);
	if (!annotated.cachePlan) {
		throw new Error("Expected annotateCacheMarkers to produce a cachePlan for this conversation shape");
	}
	const projected = attachCachePlanToMessages(annotated.messages, annotated.cachePlan);
	return { messages: projected, plan: annotated.cachePlan };
}

async function runOpenAIStream(messages: AgentMessage[]): Promise<CapturedParams> {
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

describe("F2 cache plan end-to-end flow (annotateCacheMarkers → attachCachePlanToMessages → openai-completions)", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("attaches the plan via the real wire-in and emits cache_control at every position the plan declares", async () => {
		const ts = Date.now();
		const conversation: AgentMessage[] = [
			makeUser("Read the file", ts),
			makeAssistantWithToolCall("read", { path: "README.md" }, ts + 1),
			makeToolResult(`call-${ts + 1}`, "file contents", ts + 2),
			makeUser("Thanks", ts + 3),
		];

		const { messages, plan } = runF2WireIn(conversation, {
			format: "anthropic",
			retention: "short",
			systemPrompt: true,
			lastTool: true,
			lastMessage: true,
		});

		// The plan covers all three positions.
		const positions = new Set(plan.markers.map((m) => m.marker.position));
		expect(positions).toEqual(new Set(["system", "last-tool", "last-message"]));

		// The wire-in attached the plan to the last user message's `details`.
		const lastUser = messages[3]! as AgentMessage & { details?: { cachePlan?: CachePlan } };
		expect(lastUser.role).toBe("user");
		expect(lastUser.details?.cachePlan).toBe(plan);

		const params = await runOpenAIStream(messages);

		// system marker → instruction message in the converted payload.
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

	it("only emits cache_control at the positions the F2 plan enables (last-message only)", async () => {
		const ts = Date.now();
		const conversation: AgentMessage[] = [
			makeUser("Hi", ts),
			makeAssistantText("Hello", ts + 1),
			makeUser("Bye", ts + 2),
		];

		const { messages, plan } = runF2WireIn(conversation, {
			format: "anthropic",
			retention: "short",
			systemPrompt: false,
			lastTool: false,
			lastMessage: true,
		});

		// The plan only includes the last-message position.
		const positions = new Set(plan.markers.map((m) => m.marker.position));
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

	it("adds ttl: 1h on the wire when the F2 plan's retention is long", async () => {
		const ts = Date.now();
		const conversation: AgentMessage[] = [
			makeUser("Read", ts),
			makeAssistantWithToolCall("read", { path: "x" }, ts + 1),
			makeToolResult(`call-${ts + 1}`, "ok", ts + 2),
			makeUser("Done", ts + 3),
		];

		const { messages } = runF2WireIn(conversation, {
			format: "anthropic",
			retention: "long",
			systemPrompt: true,
			lastTool: true,
			lastMessage: true,
		});

		const params = await runOpenAIStream(messages);

		const instruction = params.messages.find((m) => m.role === "system" || m.role === "developer");
		expect((instruction?.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

		const lastTool = params.tools?.[(params.tools?.length ?? 1) - 1];
		expect(lastTool?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

		const lastMessage = params.messages[params.messages.length - 1];
		expect((lastMessage.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	it("the wire-in attaches the plan structurally and the adapter reads it (no manual withCachePlan step)", async () => {
		// This test is the strict proof that the wire-in does the right
		// thing: it directly inspects the message produced by
		// `attachCachePlanToMessages` (without any further mutation) and
		// confirms the structural shape the adapter depends on. If the
		// wire-in regresses, this test fails before the network mock is
		// even touched.
		const ts = Date.now();
		const conversation: AgentMessage[] = [makeUser("q", ts), makeUser("q2", ts + 1)];

		const { messages } = runF2WireIn(conversation, {
			format: "anthropic",
			retention: "short",
			systemPrompt: true,
			lastTool: false,
			lastMessage: true,
		});

		const last = messages[messages.length - 1]! as AgentMessage & {
			details?: { cachePlan?: CachePlan; cacheMarkers?: unknown[] };
		};
		expect(last.role).toBe("user");
		// The plan is attached structurally.
		expect(last.details).toBeDefined();
		expect(last.details?.cachePlan).toBeDefined();
		expect(Array.isArray(last.details?.cachePlan?.markers)).toBe(true);
		expect(
			last.details?.cachePlan?.markers.some(
				(m: { marker: { position: string } }) => m.marker.position === "last-message",
			),
		).toBe(true);

		// The per-position `cacheMarkers` array is also attached on the
		// last user message so the adapter can short-circuit on it
		// without re-deriving positions from the plan.
		expect(last.details?.cacheMarkers).toBeDefined();
		expect(last.details?.cacheMarkers?.some((m: { position?: string }) => m.position === "last-message")).toBe(true);
	});
});

