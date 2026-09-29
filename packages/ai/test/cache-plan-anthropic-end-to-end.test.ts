/**
 * F2 cache plan end-to-end flow through the anthropic-messages adapter.
 *
 * Mirrors `cache-plan-end-to-end-flow.test.ts` (OpenAI) for the Anthropic
 * provider. Exercises the F2 wire-in pipeline in
 * `packages/coding-agent/src/core/sdk.ts` step by step:
 *   1. Build a real conversation as `AgentMessage[]`.
 *   2. Run `annotateCacheMarkers` to compute a `CachePlan`.
 *   3. Run `attachCachePlanToMessages` (the F2 wire-in helper) to attach the
 *      plan to the last user/assistant message's `details`.
 *   4. Call the anthropic-messages provider with a mocked SDK
 *      (`vi.mock("@anthropic-ai/sdk")`) and assert the wire payload carries
 *      `cache_control: { type: "ephemeral" }` at every position the plan
 *      declared.
 *
 * This is the Anthropic counterpart of the Wave 17 OpenAI end-to-end test.
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
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { AssistantMessage, Message, Model, ToolResultMessage, UserMessage } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Mock Anthropic SDK — captures the wire payload
// ---------------------------------------------------------------------------

interface CacheControl {
	type: "ephemeral";
	ttl?: string;
}

interface SystemBlock {
	type: "text";
	text: string;
	cache_control?: CacheControl;
}

interface MessageBlock {
	type: string;
	text?: string;
	cache_control?: CacheControl;
}

interface ToolWithCacheControl {
	name: string;
	cache_control?: CacheControl;
}

interface AnthropicMessage {
	role: string;
	content: string | MessageBlock[];
}

interface CapturedParams {
	system?: SystemBlock[];
	messages: AnthropicMessage[];
	tools?: ToolWithCacheControl[];
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedParams | undefined,
}));

function createSseResponse(): Response {
	const body = [
		`event: message_start\ndata: ${JSON.stringify({
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
		})}\n`,
		`event: content_block_start\ndata: ${JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		})}\n`,
		`event: content_block_delta\ndata: ${JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "Hello" },
		})}\n`,
		`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n`,
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 12,
				output_tokens: 5,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		})}\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
	].join("\n");

	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

vi.mock("@anthropic-ai/sdk", () => {
	class FakeAnthropic {
		beta = {
			messages: {
				create: (params: CapturedParams) => {
					mockState.lastParams = params;
					return {
						asResponse: async () => createSseResponse(),
					};
				},
			},
		};
	}
	return { default: FakeAnthropic };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
		api: "anthropic-messages",
		provider: "anthropic",
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
		api: "anthropic-messages",
		provider: "anthropic",
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

async function runAnthropicStream(messages: AgentMessage[]): Promise<CapturedParams> {
	// `AgentMessage` is structurally compatible with `Message` for the
	// user/assistant/toolResult roles. The `details` field is preserved
	// through the cast (TypeScript does not see it, but the runtime
	// object still carries it for the provider adapter to read).
	await streamAnthropic(
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

describe("F2 cache plan end-to-end flow (annotateCacheMarkers → attachCachePlanToMessages → anthropic-messages)", () => {
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

		const params = await runAnthropicStream(messages);

		// system marker → every system block.
		expect(params.system).toBeDefined();
		expect((params.system ?? []).length).toBeGreaterThan(0);
		for (const block of params.system ?? []) {
			expect(block.cache_control).toEqual({ type: "ephemeral" });
		}

		// last-tool marker → last tool definition.
		expect(params.tools).toBeDefined();
		const lastTool = params.tools?.[(params.tools?.length ?? 1) - 1];
		expect(lastTool?.cache_control).toEqual({ type: "ephemeral" });

		// last-message marker → last user message in the converted payload.
		const lastMessage = params.messages[params.messages.length - 1];
		expect(lastMessage.role).toBe("user");
		if (Array.isArray(lastMessage.content)) {
			const blocks = lastMessage.content as MessageBlock[];
			expect(blocks.some((b) => b.cache_control?.type === "ephemeral")).toBe(true);
		} else {
			// String content is converted by `applyCachePlanMarkers` to a
			// single text block carrying `cache_control` — when that path
			// does not run, the test should still observe the marker
			// somewhere. We accept this case only when the legacy walker
			// pre-converted the message; in practice the F2 walker always
			// turns it into an array.
			expect.fail("Expected last message content to be an array after F2 plan application");
		}
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

		const params = await runAnthropicStream(messages);

		// system / last-tool must NOT be marked.
		expect(params.system).toBeDefined();
		for (const block of params.system ?? []) {
			expect(block.cache_control).toBeUndefined();
		}
		expect((params.tools ?? []).every((t) => t.cache_control === undefined)).toBe(true);

		// last-message marker → last user message.
		const lastMessage = params.messages[params.messages.length - 1];
		expect(lastMessage.role).toBe("user");
		if (Array.isArray(lastMessage.content)) {
			const blocks = lastMessage.content as MessageBlock[];
			expect(blocks.some((b) => b.cache_control?.type === "ephemeral")).toBe(true);
		} else {
			expect.fail("Expected last message content to be an array after F2 plan application");
		}
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

		const params = await runAnthropicStream(messages);

		expect(params.system).toBeDefined();
		for (const block of params.system ?? []) {
			expect(block.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		}

		const lastTool = params.tools?.[(params.tools?.length ?? 1) - 1];
		expect(lastTool?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

		const lastMessage = params.messages[params.messages.length - 1];
		if (Array.isArray(lastMessage.content)) {
			const blocks = lastMessage.content as MessageBlock[];
			expect(blocks.some((b) => b.cache_control?.type === "ephemeral" && b.cache_control?.ttl === "1h")).toBe(true);
		} else {
			expect.fail("Expected last message content to be an array after F2 plan application");
		}
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

