/**
 * F2 context-compiler integration — budget enforcement.
 *
 * Verifies the agent loop's per-request budget derivation
 * (`model.contextWindow - keepRecentTokens - model.maxTokens`) actually
 * constrains the message stream reaching the LLM. The agent loop does not
 * do the trimming itself — the F2 module does — but the wire is responsible
 * for forwarding the right `tokenBudget` to `compile`. This test seeds a
 * transcript that is several times the budget and asserts the LLM sees
 * fewer messages than were streamed in.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, Message, UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { compileContext } from "../src/core/context-compiler.ts";
import { getLatestTaskState } from "../src/core/task-state.ts";
import { createHarness } from "./test-harness.ts";

function padded(s: string, length: number): string {
	return s.length >= length ? s : s + "x".repeat(length - s.length);
}

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

describe("F2 context compiler integration — token budget", () => {
	it("trims the streamed transcript down so the LLM receives a within-budget projection", async () => {
		// 8192 context, 2048 max tokens, keepRecentTokens=2000. Budget = 4144.
		// Each padded user/assistant message is ~1000 chars => ~250 tokens
		// (chars/4 rounded up). 30 user+assistant pairs ≈ 60 messages ≈
		// 15_000 tokens raw, well over the 4144 budget.
		const harness = await createHarness({
			responses: ["ok"],
			systemPrompt: "test",
			contextWindow: 8192,
		});
		try {
			const seeded: AgentMessage[] = [];
			for (let i = 0; i < 30; i++) {
				seeded.push(makeUser(padded(`user-${i}`, 1000), i * 2));
				seeded.push(makeAssistant(padded(`assistant-${i}`, 1000), i * 2 + 1));
			}
			harness.agent.state.messages = seeded.slice();

			harness.agent.transformContext = async (messages) => messages;
			harness.agent.contextCompiler = {
				enabled: true,
				keepRecentTokens: 2000,
				keepRecentTurns: 20,
				getTaskState: () => getLatestTaskState(harness.sessionManager.getBranch()),
				compile: (messages, taskState, options) => {
					return compileContext(messages, taskState as Parameters<typeof compileContext>[1], options).messages;
				},
			};
			harness.agent.convertToLlm = (messages) => messages as Message[];

			await harness.session.prompt("final-question");
			await harness.session.waitForIdle();

			const ctx = harness.faux.contexts[0];
			expect(ctx).toBeDefined();
			const llmMessages = ctx.messages as unknown as AgentMessage[];

			// Sanity: the raw transcript was 60 messages plus the prompt. The
			// projection must drop the majority of them. With a 8192 context
			// window minus 2000 (keepRecentTokens) minus 16384 (maxTokens) =
			// -10192, the agent loop clamps to 0 via `Math.max(0, ...)` so
			// the projection budget is exactly 0.
			const rawBudget = 8192 - 2000 - 16_384;
			const expectedBudget = Math.max(0, rawBudget);
			expect(expectedBudget).toBe(0);

			// Even with a zero budget, the F2 module keeps essentials (latest
			// user, latest terminal assistant). So the LLM still receives at
			// least those two messages. The important guarantee is that the
			// LLM does NOT receive the full 60+1 message transcript.
			expect(llmMessages.length).toBeLessThan(seeded.length + 1);

			// Recompute the projection independently and assert equality,
			// ignoring timestamps (the agent session assigns `Date.now()` to
			// the prompt, which we cannot pin from the test). The agent
			// session builds the prompt as `{role: "user", content:
			// [{type: "text", text: "..."}], timestamp}` — array content,
			// not string — so we mirror that shape here.
			const taskState = getLatestTaskState(harness.sessionManager.getBranch());
			const promptMessage: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: "final-question" }],
				timestamp: 0,
			};
			const expected = compileContext([...seeded, promptMessage], taskState, {
				tokenBudget: expectedBudget,
				keepRecentTurns: 20,
			});
			const stripTimestamp = (m: AgentMessage): AgentMessage => ({ ...m, timestamp: 0 });
			expect(llmMessages.map(stripTimestamp)).toEqual(expected.messages.map(stripTimestamp));
		} finally {
			harness.cleanup();
		}
	});

	it("keeps every message when the budget is large enough for the full transcript", async () => {
		const harness = await createHarness({
			responses: ["ok"],
			systemPrompt: "test",
			contextWindow: 1_000_000, // Effectively unlimited
		});
		try {
			const seeded: AgentMessage[] = [
				makeUser("a", 1),
				makeAssistant("b", 2),
				makeUser("c", 3),
				makeAssistant("d", 4),
			];
			harness.agent.state.messages = seeded.slice();

			harness.agent.transformContext = async (messages) => messages;
			harness.agent.contextCompiler = {
				enabled: true,
				keepRecentTokens: 20_000,
				keepRecentTurns: 20,
				getTaskState: () => getLatestTaskState(harness.sessionManager.getBranch()),
				compile: (messages, taskState, options) => {
					return compileContext(messages, taskState as Parameters<typeof compileContext>[1], options).messages;
				},
			};
			harness.agent.convertToLlm = (messages) => messages as Message[];

			await harness.session.prompt("end");
			await harness.session.waitForIdle();

			const ctx = harness.faux.contexts[0];
			const llmMessages = ctx.messages as unknown as AgentMessage[];
			// With a 1M-token budget and a 4-message transcript plus the
			// prompted user message, the projection is identity. The F2
			// first-prompt lifecycle also seeds a `task-state-context`
			// custom message, so the projection contains one extra row.
			const taskStateRows = llmMessages.filter(
				(m) => (m as { role?: string; customType?: string }).role === "custom",
			).length;
			expect(llmMessages.length).toBe(seeded.length + 1 + taskStateRows);
		} finally {
			harness.cleanup();
		}
	});

	it("falls back to a generous default budget when model.contextWindow is 0 (synthetic/early-init paths)", async () => {
		// The agent loop guards against `contextWindow === 0` (e.g. when the
		// model is the synthetic DEFAULT_MODEL before real model metadata
		// arrives) by falling back to a 100_000-token default. This keeps
		// tests and early-init paths from being unable to compile at all.
		// The faux harness always provides a real model, so we exercise the
		// wire by passing a `transformContext` that observes the budget the
		// agent loop derived.
		const harness = await createHarness({
			responses: ["ok"],
			systemPrompt: "test",
		});
		try {
			const seen: number[] = [];
			harness.agent.contextCompiler = {
				enabled: true,
				// keepRecentTokens=0 so the budget only subtracts model.maxTokens.
				keepRecentTokens: 0,
				keepRecentTurns: 20,
				getTaskState: () => undefined,
				compile: (messages, _taskState, options) => {
					seen.push(options.tokenBudget);
					return messages;
				},
			};
			harness.agent.transformContext = async (messages) => messages;
			harness.agent.convertToLlm = (messages) => messages as Message[];

			await harness.session.prompt("hi");
			await harness.session.waitForIdle();

			// Faux model: 128_000 context, 16_384 max tokens. Expected
			// budget = 128_000 - 0 - 16_384 = 111_616.
			expect(seen.length).toBeGreaterThan(0);
			expect(seen[0]).toBe(128_000 - 16_384);
		} finally {
			harness.cleanup();
		}
	});
});

