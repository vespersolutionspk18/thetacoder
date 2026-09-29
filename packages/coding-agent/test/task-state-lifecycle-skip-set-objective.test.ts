/**
 * F2 TaskState lifecycle — first user prompt does NOT override an
 * existing objective.
 *
 * When the session already has an objective recorded (set through
 * `setObjective`, persisted from a prior branch, or otherwise
 * produced before the first prompt), the first-prompt wiring in
 * `AgentSession.prompt()` must leave the objective alone. The audit
 * framing was that the F2 state is durable and the model is not
 * allowed to silently re-author it through a routine user prompt.
 *
 * The test exercises this end-to-end through `AgentSession.prompt()`
 * with a synthetic stream that completes the turn immediately.
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

describe("AgentSession.prompt — first prompt does not overwrite a pre-set objective", () => {
	it("leaves the pre-existing objective intact when a prior session.setObjective() was called", async () => {
		const streamFn: StreamFn = () => new MockAssistantStream(createFinalAssistantMessage());
		const { session } = await createSession({ streamFn });
		try {
			session.setObjective("Initial objective from the host");

			await session.prompt("User prompt that should NOT become the objective");

			const state = session.getCurrentTaskState();
			expect(state).toBeDefined();
			expect(state?.objective?.text).toBe("Initial objective from the host");
		} finally {
			session.dispose();
		}
	});

	it("still fires the onFirstUserPrompt observer even when the objective is skipped", async () => {
		const streamFn: StreamFn = () => new MockAssistantStream(createFinalAssistantMessage());
		const observed: string[] = [];
		const onFirstUserPrompt = (capture: { text: string }): void => {
			observed.push(capture.text);
		};
		const { session } = await createSession({ streamFn, onFirstUserPrompt });
		try {
			session.setObjective("Pre-set objective");

			await session.prompt("User prompt text");

			expect(observed).toEqual(["User prompt text"]);
			const state = session.getCurrentTaskState();
			expect(state?.objective?.text).toBe("Pre-set objective");
		} finally {
			session.dispose();
		}
	});
});

