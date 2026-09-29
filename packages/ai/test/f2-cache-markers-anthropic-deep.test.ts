/**
 * F2 cache markers — Anthropic provider deep integration.
 *
 * Exercises the full F2 wire-in pipeline end-to-end through the
 * `anthropic-messages` provider adapter, in the same order the SDK
 * runs them in production:
 *
 *   compileContext  →  annotateCacheMarkers  →  attachCachePlanToMessages
 *     →  checkEvidenceFreshness  →  annotateStaleness
 *     →  validateProviderProtocol
 *     →  anthropic-messages stream
 *
 * This is the Anthropic counterpart of `f2-cache-markers-openai-deep.test.ts`.
 * It covers everything the Wave 18 end-to-end test does, plus:
 *
 *  - `compileContext` runs first, so the projection is the same
 *    shape the SDK ships to the adapter.
 *  - `checkEvidenceFreshness` + `annotateStaleness` run between the
 *    cache wire-in and the protocol validator.
 *  - `validateProviderProtocol` runs last and may insert a synthetic
 *    user/assistant bridge.
 *
 * Mocking: `vi.mock("@anthropic-ai/sdk")` captures the wire payload
 * and returns a minimal SSE response via `asResponse()`.
 */

import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Message, Model } from "../src/types.ts";
import {
	buildF2Projection,
	makeAssistantText,
	makeAssistantWithToolCall,
	makeToolResult,
	makeUser,
} from "./_f2-deep-integration-helpers.ts";

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
				id: "msg_f2_deep",
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
// Model + adapter driver
// ---------------------------------------------------------------------------

const baseModel: Model<"anthropic-messages"> = {
	id: "claude-f2-deep",
	name: "Claude F2 Deep",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
	compat: {
		supportsLongCacheRetention: true,
	},
};

async function runAnthropicStream(messages: import("@theta/agent-core").AgentMessage[]): Promise<CapturedParams> {
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

describe("F2 cache markers — Anthropic deep integration (full wire-in through anthropic-messages)", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("runs compileContext + cache wire-in + freshness + protocol validation and emits cache_control at every F2 plan position", async () => {
		const ts = Date.now();
		const conversation = [
			makeUser("Read the file", ts),
			makeAssistantWithToolCall("read", { path: "README.md" }, ts + 1, "anthropic-messages"),
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
			provider: "anthropic",
		});

		// 1. The plan covers all three positions.
		const positions = new Set(cachePlan.markers.map((m) => m.marker.position));
		expect(positions).toEqual(new Set(["system", "last-tool", "last-message"]));

		// 2. The freshness step ran with no TaskState, so the report
		//    is empty and no freshness-warning was prepended.
		expect(freshness.checks).toEqual([]);

		// 3. The protocol validator may report a
		//    `role-sequence-mismatch` issue for the `toolResult → user`
		//    pattern (Anthropic wants `toolResult → assistant` and
		//    the validator inserts a synthetic assistant bridge) —
		//    what we care about is that the projection still ends up
		//    with the plan attached, the bridge fix is applied, and
		//    the adapter still emits cache_control at the plan
		//    positions.
		expect(validation.fixedCount).toBeGreaterThan(0);
		expect(validation.issues.some((i) => i.rule === "role-sequence-mismatch")).toBe(true);

		// 4. The plan is attached to the last user message's details.
		const last = messages[messages.length - 1]! as Message & {
			details?: { cachePlan?: unknown };
		};
		expect(last.role).toBe("user");
		expect(last.details?.cachePlan).toBe(cachePlan);

		// 5. The adapter emits cache_control at every plan position.
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
			expect.fail("Expected last message content to be an array after F2 plan application");
		}
	});

	it("emits cache_control only at the positions the F2 plan enables (last-message only)", async () => {
		const ts = Date.now();
		const conversation = [
			makeUser("Hi", ts),
			makeAssistantText("Hello", ts + 1, "anthropic-messages"),
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
			provider: "anthropic",
		});

		// The plan only covers the last-message position.
		const positions = new Set(cachePlan.markers.map((m) => m.marker.position));
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

	it("adds ttl: 1h on the wire when the F2 plan's retention is long and the model supports it", async () => {
		const ts = Date.now();
		const conversation = [
			makeUser("Read", ts),
			makeAssistantWithToolCall("read", { path: "x" }, ts + 1, "anthropic-messages"),
			makeToolResult(`call-${ts + 1}`, "ok", ts + 2),
			makeUser("Done", ts + 3),
		];

		const { messages } = buildF2Projection({
			conversation,
			render: {
				format: "anthropic",
				retention: "long",
				systemPrompt: true,
				lastTool: true,
				lastMessage: true,
			},
			provider: "anthropic",
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

	it("survives a synthetic bridge inserted by validateProviderProtocol and still emits cache_control at the F2 plan positions", async () => {
		// Conversation starts with an assistant message, which the
		// Anthropic protocol validator must fix by inserting a
		// synthetic user bridge (via the `alternating-roles` rule).
		// The F2 plan's `system` marker pointed at message index 0 in
		// the original projection; after the validator inserts a
		// bridge, the plan's `last-message` marker is still at the
		// new tail. The adapter must follow the plan, not the
		// original index.
		const ts = Date.now();
		const conversation = [
			makeAssistantText("I have already started", ts, "anthropic-messages"),
			makeAssistantWithToolCall("read", { path: "x" }, ts + 1, "anthropic-messages"),
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
			provider: "anthropic",
		});

		// The validator should have inserted at least one synthetic
		// bridge to satisfy the `alternating-roles` rule (Anthropic
		// requires strict user/assistant alternation, and the
		// conversation has two adjacent assistant messages at
		// indices 0 and 1 in the original projection). The bridge is
		// a `custom` message (`customType: "synthetic-bridge"`)
		// tagged with `details.synthetic: true` and
		// `details.targetRole: "user"`; the provider adapter renders
		// it as the target role on the wire.
		expect(validation.fixedCount).toBeGreaterThan(0);
		expect(validation.issues.some((i) => i.rule === "alternating-roles")).toBe(true);
		const bridge = messages.find(
			(m) =>
				m.role === "custom" &&
				(m as unknown as Message & { details?: { synthetic?: boolean } }).details?.synthetic === true,
		) as unknown as (Message & { details?: { synthetic?: boolean; targetRole?: string } }) | undefined;
		expect(bridge).toBeDefined();
		expect(bridge?.details?.synthetic).toBe(true);
		expect(bridge?.details?.targetRole).toBe("user");

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

		const params = await runAnthropicStream(messages);

		// system marker → system blocks in the converted payload.
		expect(params.system).toBeDefined();
		for (const block of params.system ?? []) {
			expect(block.cache_control).toEqual({ type: "ephemeral" });
		}

		// last-message marker → last user message in the converted payload.
		const lastMessage = params.messages[params.messages.length - 1];
		expect(lastMessage.role).toBe("user");
		if (Array.isArray(lastMessage.content)) {
			const blocks = lastMessage.content as MessageBlock[];
			expect(blocks.some((b) => b.cache_control?.type === "ephemeral")).toBe(true);
		} else {
			expect.fail("Expected last message content to be an array after F2 plan application");
		}
	});
});

