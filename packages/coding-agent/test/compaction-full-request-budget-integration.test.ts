/**
 * F3 — full-request compaction budgeting (integration).
 *
 * On the estimate-only path (no provider usage in the message
 * history), the compaction threshold check must count the system
 * prompt and tool schemas in addition to the message tokens. A
 * session whose messages alone fit under the reserve but whose
 * messages + prefix overflow must trigger compaction.
 */

import { Agent } from "@theta/agent-core";
import type { AssistantMessage, Model } from "@theta/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

// Synthetic small-context model: the threshold is
// `contextWindow - reserveTokens`, so a 20k window with a 10k reserve
// fires at >10k tokens. A real catalog model's 200k window would need
// ~190k tokens of content to exercise the same path.
const model: Model<"anthropic-messages"> = {
	id: "small-context-test",
	name: "small-context-test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 20_000,
	maxTokens: 4_096,
};

let session: AgentSession | undefined;

afterEach(() => {
	session?.dispose();
	session = undefined;
});

function makeZeroUsageAssistant(): AssistantMessage {
	// Zero usage and a non-error stop reason route `_checkCompaction`
	// onto the estimate path (no provider usage to consult).
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: model.provider,
		model: model.id,
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

async function createSessionWith(systemPrompt: string): Promise<AgentSession> {
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true, reserveTokens: 10_000, keepRecentTokens: 1 },
	});
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);

	return new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			streamFn: () => {
				throw new Error("not called in this test");
			},
			initialState: {
				model,
				systemPrompt,
				tools: [],
				thinkingLevel: "high",
			},
		}),
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
	});
}

describe("compaction threshold — request prefix budgeting", () => {
	it("triggers compaction when messages + system prompt + tool schemas exceed the reserve", async () => {
		session = await createSessionWith("initial");
		// The constructor's initial `_buildRuntime` rebuilds the system
		// prompt; wait for it so the override below is not clobbered.
		await session.whenReady();

		// System prompt: ~24k chars ≈ 6k tokens of prefix the
		// message-only estimate would miss.
		const longSystemPrompt = "system guidance. ".repeat(1_500);
		const agentState = (
			session as unknown as {
				agent: { state: { messages: unknown[]; systemPrompt: string } };
			}
		).agent.state;
		agentState.systemPrompt = longSystemPrompt;

		// Messages alone total ~5k tokens (20k chars) — under the 10k
		// threshold of the 20k window. The ~6k-token prefix must push
		// the effective total past the threshold and trigger
		// compaction.
		const filler = "x".repeat(20_000);
		agentState.messages = [{ role: "user", content: filler, timestamp: Date.now() }];

		let compactTriggered = false;
		const sessionInternals = session as unknown as {
			_runAutoCompaction: (reason: string, willRetry: boolean) => Promise<boolean>;
		};
		const original = sessionInternals._runAutoCompaction.bind(sessionInternals);
		sessionInternals._runAutoCompaction = async (reason: string, willRetry: boolean) => {
			compactTriggered = true;
			// Record the trigger without actually summarizing (no model
			// calls in this test).
			void reason;
			void willRetry;
			return false;
		};

		try {
			await (session as unknown as { _checkCompaction: (m: AssistantMessage) => Promise<boolean> })._checkCompaction(
				makeZeroUsageAssistant(),
			);
		} finally {
			sessionInternals._runAutoCompaction = original;
		}

		expect(compactTriggered).toBe(true);
	});

	it("does not trigger compaction when messages + prefix fit under the reserve", async () => {
		session = await createSessionWith("short prompt");

		const agentState = (session as unknown as { agent: { state: { messages: unknown[] } } }).agent.state;
		agentState.messages = [{ role: "user", content: "x".repeat(4_000), timestamp: Date.now() }];

		let compactTriggered = false;
		const sessionInternals = session as unknown as {
			_runAutoCompaction: (reason: string, willRetry: boolean) => Promise<boolean>;
		};
		const original = sessionInternals._runAutoCompaction.bind(sessionInternals);
		sessionInternals._runAutoCompaction = async (reason: string, willRetry: boolean) => {
			compactTriggered = true;
			void reason;
			void willRetry;
			return false;
		};

		try {
			await (session as unknown as { _checkCompaction: (m: AssistantMessage) => Promise<boolean> })._checkCompaction(
				makeZeroUsageAssistant(),
			);
		} finally {
			sessionInternals._runAutoCompaction = original;
		}

		expect(compactTriggered).toBe(false);
	});
});

