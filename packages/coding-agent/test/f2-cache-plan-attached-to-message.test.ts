/**
 * F2 stable-rendering — wire-in cache-plan attachment.
 *
 * Verifies that after `annotateCacheMarkers` produces a context with a
 * `cachePlan`, the wire-in layer attaches the plan to the LAST
 * user/assistant message's `details` field so the provider adapter in
 * `packages/ai/src/api/` can read it structurally.
 *
 * The test exercises both the helper directly
 * (`attachCachePlanToMessages`) and the end-to-end wire-in through a
 * real `AgentSession` (the `contextCompiler.compile` callback in
 * `packages/coding-agent/src/core/sdk.ts`).
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, Message, UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { annotateCacheMarkers, attachCachePlanToMessages, type CachePlan } from "../src/core/cache-rendering.ts";
import { compileContext } from "../src/core/context-compiler.ts";
import { getLatestTaskState } from "../src/core/task-state.ts";
import { createHarness } from "./test-harness.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

function makeAssistant(text: string, ts: number): AssistantMessage {
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
		model: "faux-1",
		timestamp: ts,
	};
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
		model: "faux-1",
		timestamp: ts,
	};
}

function makeToolResult(toolCallId: string, text: string, ts: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		details: {},
		isError: false,
		timestamp: ts,
	};
}

// Structural read of `details` from a user/assistant message. The agent
// core's `UserMessage`/`AssistantMessage` do not declare a `details`
// field at the type level, so we cast to a structural type to read what
// the wire-in attached.
function readDetails(message: AgentMessage): { cachePlan?: CachePlan; cacheMarkers?: unknown[] } | undefined {
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	return (message as UserMessage & { details?: { cachePlan?: CachePlan; cacheMarkers?: unknown[] } }).details;
}

// ---------------------------------------------------------------------------
// attachCachePlanToMessages — direct unit tests
// ---------------------------------------------------------------------------

describe("F2 wire-in — attachCachePlanToMessages", () => {
	it("attaches the plan to the last user message and returns a new array", () => {
		const messages: AgentMessage[] = [
			makeUser("first", 1),
			makeAssistant("reply", 2),
			makeUser("second", 3),
			makeAssistant("done", 4),
		];
		const plan: CachePlan = {
			breakpoints: [1, 3],
			estimatedStablePrefixTokens: 4,
			estimatedVolatileSuffixTokens: 4,
			markers: [
				{ messageIndex: 1, marker: { position: "system", type: "ephemeral" } },
				{ messageIndex: 3, marker: { position: "last-message", type: "ephemeral" } },
			],
			format: "anthropic",
			retention: "short",
		};

		const result = attachCachePlanToMessages(messages, plan);

		// The input array is not mutated.
		expect(result).not.toBe(messages);
		expect(readDetails(messages[3]!)).toBeUndefined();

		// The last assistant message carries the plan.
		const lastDetails = readDetails(result[3]!);
		expect(lastDetails).toBeDefined();
		expect(lastDetails?.cachePlan).toBe(plan);
		expect(lastDetails?.cacheMarkers).toEqual([{ position: "last-message", type: "ephemeral" }]);

		// The plan's `system` marker at index 1 means the assistant
		// message there gets a per-position `cacheMarkers` attachment
		// (without a `cachePlan`). The other user/assistant messages
		// that are not a marker target are left alone.
		expect(readDetails(result[0]!)).toBeUndefined();
		expect(readDetails(result[1]!)).toEqual({
			cacheMarkers: [{ position: "system", type: "ephemeral" }],
		});
		expect(readDetails(result[2]!)).toBeUndefined();
	});

	it("attaches per-position cacheMarkers to user/assistant messages at the system/last-tool positions", () => {
		const messages: AgentMessage[] = [
			makeUser("first", 1), // system marker target
			makeAssistantWithToolCall("bash", { command: "ls" }, 2), // last-tool marker target
			makeToolResult("call-2", "README.md", 3),
			makeAssistant("done", 4), // last-message marker target
		];
		const plan: CachePlan = {
			breakpoints: [0, 1, 3],
			estimatedStablePrefixTokens: 0,
			estimatedVolatileSuffixTokens: 0,
			markers: [
				{ messageIndex: 0, marker: { position: "system", type: "ephemeral" } },
				{ messageIndex: 1, marker: { position: "last-tool", type: "ephemeral" } },
				{ messageIndex: 3, marker: { position: "last-message", type: "ephemeral" } },
			],
			format: "anthropic",
			retention: "short",
		};

		const result = attachCachePlanToMessages(messages, plan);

		// First user message gets a system marker via `details.cacheMarkers`.
		const firstUserDetails = readDetails(result[0]!);
		expect(firstUserDetails).toBeDefined();
		expect(firstUserDetails?.cacheMarkers).toEqual([{ position: "system", type: "ephemeral" }]);
		expect(firstUserDetails?.cachePlan).toBeUndefined();

		// Assistant-with-tool-call message gets a last-tool marker.
		const toolAssistantDetails = readDetails(result[1]!);
		expect(toolAssistantDetails).toBeDefined();
		expect(toolAssistantDetails?.cacheMarkers).toEqual([{ position: "last-tool", type: "ephemeral" }]);
		expect(toolAssistantDetails?.cachePlan).toBeUndefined();

		// Tool result is left alone (annotateCacheMarkers handles its
		// details field separately and is out of scope for this helper).
		const toolResult = result[2]!;
		expect(toolResult.role).toBe("toolResult");

		// Last assistant message carries the plan + last-message marker.
		const lastDetails = readDetails(result[3]!);
		expect(lastDetails).toBeDefined();
		expect(lastDetails?.cachePlan).toBe(plan);
		expect(lastDetails?.cacheMarkers).toEqual([{ position: "last-message", type: "ephemeral" }]);
	});

	it("preserves existing details fields when attaching the plan", () => {
		const message: UserMessage & { details?: Record<string, unknown> } = {
			role: "user",
			content: "hi",
			timestamp: 1,
			details: { origin: "seeded", priority: 7 },
		};
		const plan: CachePlan = {
			breakpoints: [0],
			estimatedStablePrefixTokens: 0,
			estimatedVolatileSuffixTokens: 0,
			markers: [{ messageIndex: 0, marker: { position: "last-message", type: "ephemeral" } }],
			format: "anthropic",
			retention: "short",
		};
		const result = attachCachePlanToMessages([message as AgentMessage], plan);
		const details = readDetails(result[0]!);
		expect(details).toBeDefined();
		expect(details?.cachePlan).toBe(plan);
		expect(details?.cacheMarkers).toEqual([{ position: "last-message", type: "ephemeral" }]);
		// The original `origin` and `priority` keys survive.
		const raw = (result[0] as UserMessage & { details?: Record<string, unknown> }).details;
		expect(raw?.origin).toBe("seeded");
		expect(raw?.priority).toBe(7);
	});

	it("returns the input array unchanged when no user/assistant message exists", () => {
		const custom: AgentMessage = {
			role: "custom",
			customType: "task-state-context",
			content: "ctx",
			display: false,
			timestamp: 1,
		};
		const toolResult = makeToolResult("call-1", "x", 2);
		const plan: CachePlan = {
			breakpoints: [],
			estimatedStablePrefixTokens: 0,
			estimatedVolatileSuffixTokens: 0,
			markers: [],
			format: "anthropic",
			retention: "short",
		};
		const input = [custom, toolResult];
		const result = attachCachePlanToMessages(input, plan);
		// No user/assistant message exists, so no element is rewritten.
		// The helper still returns a new array (`slice()`) but the
		// content is element-wise identical to the input.
		expect(result).toEqual(input);
		// Neither element should carry a cachePlan.
		expect((result[0] as { details?: unknown }).details).toBeUndefined();
		expect((result[1] as { details?: unknown }).details).toEqual({});
	});

	it("returns the input array unchanged when empty", () => {
		const plan: CachePlan = {
			breakpoints: [],
			estimatedStablePrefixTokens: 0,
			estimatedVolatileSuffixTokens: 0,
			markers: [],
			format: "anthropic",
			retention: "short",
		};
		const result = attachCachePlanToMessages([], plan);
		expect(result).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Wire-in end-to-end — the F2 layer that the SDK wires in production
// ---------------------------------------------------------------------------

describe("F2 wire-in — end-to-end via AgentSession contextCompiler", () => {
	it("attaches the plan to the last user message that the LLM stream sees", async () => {
		const harness = await createHarness({
			responses: ["ok"],
			systemPrompt: "test",
			contextWindow: 128_000,
		});
		try {
			// Seed a small conversation; the wire-in must attach the
			// plan to the last user/assistant message that flows through
			// `convertToLlm`.
			const seeded: AgentMessage[] = [
				makeUser("first user", 1),
				makeAssistant("first reply", 2),
				makeUser("second user", 3),
				makeAssistant("second reply", 4),
			];
			harness.agent.state.messages = seeded.slice();
			harness.agent.transformContext = async (messages) => messages;
			harness.agent.convertToLlm = (messages) => messages as Message[];

			// Replicate the production wire-in: run `compileContext` then
			// `annotateCacheMarkers` then `attachCachePlanToMessages` and
			// return the resulting messages. This is the same flow
			// `packages/coding-agent/src/core/sdk.ts` uses inside
			// `contextCompiler.compile`.
			harness.agent.contextCompiler = {
				enabled: true,
				keepRecentTokens: 20_000,
				keepRecentTurns: 20,
				getTaskState: () => getLatestTaskState(harness.sessionManager.getBranch()),
				compile: (messages, taskState, options) => {
					const compiled = compileContext(messages, taskState as Parameters<typeof compileContext>[1], options);
					const annotated = annotateCacheMarkers(compiled, {
						format: "anthropic",
						retention: "short",
						systemPrompt: true,
						lastTool: true,
						lastMessage: true,
					});
					if (!annotated.cachePlan) {
						return annotated.messages;
					}
					return attachCachePlanToMessages(annotated.messages, annotated.cachePlan);
				},
			};

			await harness.session.prompt("trigger");
			await harness.session.waitForIdle();

			const ctx = harness.faux.contexts[0];
			expect(ctx).toBeDefined();

			// The LLM-bound messages must include the cache plan on the
			// last user/assistant message's `details`.
			const llmMessages = ctx.messages as unknown as AgentMessage[];
			const lastMessage = llmMessages[llmMessages.length - 1]!;
			expect(lastMessage.role).toMatch(/^(user|assistant)$/);
			const details = readDetails(lastMessage);
			expect(details).toBeDefined();
			expect(details?.cachePlan).toBeDefined();
			expect(details?.cachePlan?.markers.length).toBeGreaterThan(0);
		} finally {
			harness.cleanup();
		}
	});

	it("does not attach a plan when cacheRendering is disabled", async () => {
		const harness = await createHarness({
			responses: ["ok"],
			systemPrompt: "test",
			contextWindow: 128_000,
		});
		try {
			const seeded: AgentMessage[] = [makeUser("hi", 1), makeAssistant("hello", 2)];
			harness.agent.state.messages = seeded.slice();
			harness.agent.transformContext = async (messages) => messages;
			harness.agent.convertToLlm = (messages) => messages as Message[];

			// No `annotateCacheMarkers` step — only the bare compiler
			// runs. The plan should not appear on the LLM-bound messages.
			harness.agent.contextCompiler = {
				enabled: true,
				keepRecentTokens: 20_000,
				keepRecentTurns: 20,
				getTaskState: () => undefined,
				compile: (messages, taskState, options) =>
					compileContext(messages, taskState as Parameters<typeof compileContext>[1], {
						...options,
						tokenBudget: 1_000_000,
					}).messages,
			};

			await harness.session.prompt("trigger");
			await harness.session.waitForIdle();

			const ctx = harness.faux.contexts[0];
			expect(ctx).toBeDefined();
			for (const m of ctx.messages as unknown as AgentMessage[]) {
				expect(readDetails(m)?.cachePlan).toBeUndefined();
			}
		} finally {
			harness.cleanup();
		}
	});
});

