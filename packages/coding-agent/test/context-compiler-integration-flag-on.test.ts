/**
 * F2 context-compiler integration — flag on.
 *
 * When `contextCompiler.enabled` is `true` and a `compile` callback is
 * supplied, the agent loop must route the `transformContext` output through
 * `compileContext` before handing the result to `convertToLlm`. The agent
 * loop is unaware of the F2 module — it computes the per-request token
 * budget from the model metadata and forwards the messages and the latest
 * TaskState to the consumer-supplied `compile` callback. This test
 * exercises that wire end-to-end through a real `AgentSession` and asserts
 * the LLM call receives the `compileContext` projection.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, Message, UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { compileContext } from "../src/core/context-compiler.ts";
import { getLatestTaskState } from "../src/core/task-state.ts";
import { createHarness } from "./test-harness.ts";

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

describe("F2 context compiler integration — flag on", () => {
	it("replaces transformContext output with the compileContext projection when enabled", async () => {
		const harness = await createHarness({
			responses: ["ok"],
			systemPrompt: "test",
			// Faux model is 128_000 context / 16_384 max tokens; budget is
			// 128_000 - 20_000 - 16_384 = 91_616. That is more than enough
			// to keep a handful of short messages, so the projection should
			// be identical to the input for this test.
			contextWindow: 128_000,
		});
		try {
			// Seed a small conversation that is comfortably inside the
			// budget so the projection is identity.
			const seeded: AgentMessage[] = [
				makeUser("first user", 1),
				makeAssistant("first reply", 2),
				makeUser("second user", 3),
				makeAssistant("second reply", 4),
			];
			harness.agent.state.messages = seeded.slice();

			// transformContext passes the seeded messages through; the
			// marker lets us prove the compiler runs *after* this hook.
			const transformMarker: AgentMessage = {
				role: "user",
				content: "TRANSFORM_MARKER",
				timestamp: 9999,
			};
			harness.agent.transformContext = async (messages) => [...messages, transformMarker];

			// Build the same `contextCompiler` config the SDK wires in
			// production (close over the live `sessionManager` and call
			// the real F2 module).
			harness.agent.contextCompiler = {
				enabled: true,
				keepRecentTokens: 20_000,
				keepRecentTurns: 20,
				getTaskState: () => getLatestTaskState(harness.sessionManager.getBranch()),
				compile: (messages, taskState, options) => {
					return compileContext(messages, taskState as Parameters<typeof compileContext>[1], options).messages;
				},
			};

			// Keep every AgentMessage in the LLM stream so we can compare.
			harness.agent.convertToLlm = (messages) => messages as Message[];

			await harness.session.prompt("trigger");
			await harness.session.waitForIdle();

			// Recompute the expected projection independently from the F2
			// module against the same input the agent loop would have
			// produced. The agent loop's `transformContext` runs on
			// `currentContext.messages` (which already includes the prompt
			// message), so the projection input is `[...seeded, prompt,
			// transformMarker]` in that order.
			//
			// The prompt message has a `Date.now()` timestamp assigned by
			// the agent session, so we cannot match the timestamp exactly.
			// Instead, we re-run the F2 module on a structurally identical
			// input (only the timestamp differs by a few ms) and compare
			// the output structurally with timestamps ignored.
			const inputAfterTransform: AgentMessage[] = [
				...seeded,
				{
					role: "user",
					content: [{ type: "text", text: "trigger" }],
					timestamp: Date.now(),
				},
				transformMarker,
			];
			const taskState = getLatestTaskState(harness.sessionManager.getBranch());
			const expected = compileContext(inputAfterTransform, taskState, {
				tokenBudget: 128_000 - 20_000 - 16_384,
				keepRecentTurns: 20,
			});

			const ctx = harness.faux.contexts[0];
			expect(ctx).toBeDefined();

			// LLM-bound messages must equal `compileContext(...).messages`
			// structurally (ignoring timestamps, which we cannot pin
			// exactly because the agent session assigns `Date.now()`).
			const llmMessages = ctx.messages as unknown as AgentMessage[];
			const stripTimestamp = (m: AgentMessage): AgentMessage => ({ ...m, timestamp: 0 });
			expect(llmMessages.map(stripTimestamp)).toEqual(expected.messages.map(stripTimestamp));
		} finally {
			harness.cleanup();
		}
	});

	it("resolves the latest TaskState from the session branch on each assistant turn", async () => {
		const harness = await createHarness({
			responses: ["ok"],
			systemPrompt: "test",
			contextWindow: 128_000,
		});
		try {
			harness.agent.state.messages = [makeUser("hi", 1), makeAssistant("hello", 2)];

			// Track every TaskState the agent loop resolves.
			const observedTaskStates: unknown[] = [];
			harness.agent.contextCompiler = {
				enabled: true,
				getTaskState: () => {
					const ts = getLatestTaskState(harness.sessionManager.getBranch());
					observedTaskStates.push(ts);
					return ts;
				},
				compile: (messages, taskState, options) => {
					// Pass-through projection so the LLM still gets messages.
					return compileContext(messages, taskState as Parameters<typeof compileContext>[1], {
						...options,
						keepRecentTurns: 20,
						tokenBudget: 1_000_000,
					}).messages;
				},
			};
			harness.agent.transformContext = async (messages) => messages;
			harness.agent.convertToLlm = (messages) => messages as Message[];

			await harness.session.prompt("first prompt");
			await harness.session.waitForIdle();

			// The F2 first-prompt lifecycle seeds an objective on the very
			// first user prompt, so the agent loop now observes a TaskState
			// (not undefined) on the first turn that runs the F2 callback.
			// Subsequent turns also resolve to the same seeded state.
			expect(observedTaskStates.length).toBeGreaterThan(0);
			for (const observed of observedTaskStates) {
				expect(observed).toBeDefined();
				expect((observed as { objective?: { text: string } }).objective?.text).toBe("first prompt");
			}
		} finally {
			harness.cleanup();
		}
	});

	it("derives the token budget from model.contextWindow - keepRecentTokens - maxTokens", async () => {
		const harness = await createHarness({
			responses: ["ok"],
			systemPrompt: "test",
			contextWindow: 50_000,
		});
		try {
			harness.agent.state.messages = [makeUser("hi", 1)];

			const seenOptions: { tokenBudget: number; keepRecentTurns: number }[] = [];
			harness.agent.contextCompiler = {
				enabled: true,
				keepRecentTokens: 5_000,
				keepRecentTurns: 7,
				getTaskState: () => undefined,
				compile: (messages, _taskState, options) => {
					seenOptions.push(options);
					// Identity projection so the test focuses on the budget math.
					return messages;
				},
			};
			harness.agent.transformContext = async (messages) => messages;
			harness.agent.convertToLlm = (messages) => messages as Message[];

			await harness.session.prompt("trigger");
			await harness.session.waitForIdle();

			// Faux model: contextWindow=50_000, maxTokens=16_384. Expected:
			// tokenBudget = max(0, 50_000 - 5_000 - 16_384) = 28_616.
			expect(seenOptions.length).toBeGreaterThan(0);
			expect(seenOptions[0]?.tokenBudget).toBe(28_616);
			expect(seenOptions[0]?.keepRecentTurns).toBe(7);
		} finally {
			harness.cleanup();
		}
	});
});

