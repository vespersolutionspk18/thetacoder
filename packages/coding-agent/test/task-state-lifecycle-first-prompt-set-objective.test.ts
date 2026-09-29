/**
 * F2 TaskState lifecycle — first user prompt → `setObjective` wiring.
 *
 * The first real user prompt of a session is the natural moment to
 * seed the F2 TaskState objective: the user has stated what they
 * want, no model turns have happened yet, and no other
 * lifecycle-aware event can have observed the request. The
 * `AgentSession.prompt()` method handles the wiring: right after
 * the preflight gates pass, it inspects the current TaskState and
 * calls `setObjective(expandedText)` when no objective has been
 * recorded yet.
 *
 * This test exercises the wiring end-to-end through the
 * `AgentSession.prompt()` entry point. The underlying LLM call is
 * intercepted with a synthetic stream that produces a final
 * `stop` assistant message so the agent loop completes without
 * hitting a real provider.
 */

import { Agent, type StreamFn } from "@theta/agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@theta/ai";
import { EventStream } from "@theta/ai";
import { getModel, streamSimple } from "@theta/ai/compat";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

/**
 * Synthetic stream that produces a single `done` event with a
 * final assistant message. The agent loop iterates the events,
 * emits a `message_end` for the assistant message, then a
 * `turn_end` and `agent_end`, and the `Agent.prompt()` call
 * resolves. Used to drive `AgentSession.prompt()` in tests
 * without a real LLM provider.
 */
class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
		queueMicrotask(() => {
			this.push({ type: "done", reason: "stop", message });
		});
	}
}

function createFinalAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function createSession(
	options: { streamFn?: StreamFn; onFirstUserPrompt?: (capture: { text: string }) => void } = {},
) {
	const settingsManager = SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			streamFn: options.streamFn ?? streamSimple,
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "high",
			},
		}),
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
		resourceLoader: createTestResourceLoader(),
		onFirstUserPrompt: options.onFirstUserPrompt,
	});
	return { session, sessionManager };
}

describe("AgentSession.prompt — first prompt sets the objective", () => {
	it("sets the objective from the first user prompt when no objective is recorded", async () => {
		const streamFn: StreamFn = () => new MockAssistantStream(createFinalAssistantMessage());
		const { session } = await createSession({ streamFn });
		try {
			expect(session.getCurrentTaskState()).toBeUndefined();

			await session.prompt("Find the bug in the parser");

			const state = session.getCurrentTaskState();
			expect(state).toBeDefined();
			expect(state?.objective?.text).toBe("Find the bug in the parser");
		} finally {
			session.dispose();
		}
	});

	it("invokes the onFirstUserPrompt observer exactly once on the first user prompt", async () => {
		const streamFn: StreamFn = () => new MockAssistantStream(createFinalAssistantMessage());
		const observed: string[] = [];
		const onFirstUserPrompt = (capture: { text: string }): void => {
			observed.push(capture.text);
		};
		const { session } = await createSession({ streamFn, onFirstUserPrompt });
		try {
			await session.prompt("Refactor the cache layer");
			// Second prompt: observer must not fire again, even though
			// the prompt itself is processed.
			await session.prompt("Now write tests for the cache");

			expect(observed).toEqual(["Refactor the cache layer"]);
		} finally {
			session.dispose();
		}
	});
});

