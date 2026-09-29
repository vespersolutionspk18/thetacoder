/**
 * F2 TaskState lifecycle — `bash` tool → `recordVerification` wiring.
 *
 * The session's `afterToolCall` hook classifies bash commands and
 * records the run as an F2 verification. The classification is
 * intentionally narrow (only `test`, `lint`, and `typecheck`
 * patterns land as verifications) so the F2 state is not flooded
 * with arbitrary shell commands. The test exercises the success
 * path through the agent-core hook that `_installAgentToolHooks`
 * installs.
 */

import type { AgentContext, AgentToolCall, AgentToolResult } from "@theta/agent-core";
import { Agent } from "@theta/agent-core";
import type { AssistantMessage } from "@theta/ai";
import { getModel, streamSimple } from "@theta/ai/compat";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

async function createSession() {
	const settingsManager = SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			streamFn: streamSimple,
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
	});
	return { session, sessionManager };
}

function createFakeAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
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
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createFakeAgentContext(): AgentContext {
	return {
		systemPrompt: "test",
		messages: [],
		tools: [],
	};
}

describe("AgentSession afterToolCall hook — bash → recordVerification", () => {
	it("records a passing test verification when bash runs `npm test`", async () => {
		const { session } = await createSession();
		try {
			const toolCall: AgentToolCall = {
				type: "toolCall",
				id: "bash-1",
				name: "bash",
				arguments: { command: "npm test" },
			};
			const result: AgentToolResult<unknown> = {
				content: [{ type: "text", text: "All tests passed." }],
				details: { exitCode: 0 },
			};

			await session.agent.afterToolCall!({
				assistantMessage: createFakeAssistantMessage(),
				toolCall,
				args: { command: "npm test" },
				result,
				isError: false,
				context: createFakeAgentContext(),
			});

			const state = session.getCurrentTaskState();
			expect(state).toBeDefined();
			expect(state?.verifications).toHaveLength(1);
			expect(state?.verifications[0].kind).toBe("test");
			expect(state?.verifications[0].command).toBe("npm test");
			expect(state?.verifications[0].passed).toBe(true);
		} finally {
			session.dispose();
		}
	});

	it("records a failing test verification when the bash tool reports an error", async () => {
		const { session } = await createSession();
		try {
			const toolCall: AgentToolCall = {
				type: "toolCall",
				id: "bash-2",
				name: "bash",
				arguments: { command: "npm test" },
			};
			const result: AgentToolResult<unknown> = {
				content: [{ type: "text", text: "1 test failed." }],
				details: { exitCode: 1 },
			};

			await session.agent.afterToolCall!({
				assistantMessage: createFakeAssistantMessage(),
				toolCall,
				args: { command: "npm test" },
				result,
				isError: true,
				context: createFakeAgentContext(),
			});

			const state = session.getCurrentTaskState();
			expect(state?.verifications).toHaveLength(1);
			expect(state?.verifications[0].kind).toBe("test");
			expect(state?.verifications[0].passed).toBe(false);
		} finally {
			session.dispose();
		}
	});

	it("records a lint verification when bash runs `npm run lint`", async () => {
		const { session } = await createSession();
		try {
			const toolCall: AgentToolCall = {
				type: "toolCall",
				id: "bash-3",
				name: "bash",
				arguments: { command: "npm run lint" },
			};
			const result: AgentToolResult<unknown> = {
				content: [{ type: "text", text: "no issues" }],
				details: { exitCode: 0 },
			};

			await session.agent.afterToolCall!({
				assistantMessage: createFakeAssistantMessage(),
				toolCall,
				args: { command: "npm run lint" },
				result,
				isError: false,
				context: createFakeAgentContext(),
			});

			const state = session.getCurrentTaskState();
			expect(state?.verifications).toHaveLength(1);
			expect(state?.verifications[0].kind).toBe("lint");
			expect(state?.verifications[0].passed).toBe(true);
		} finally {
			session.dispose();
		}
	});

	it("records a typecheck verification when bash runs `npm run typecheck`", async () => {
		const { session } = await createSession();
		try {
			const toolCall: AgentToolCall = {
				type: "toolCall",
				id: "bash-4",
				name: "bash",
				arguments: { command: "npm run typecheck" },
			};
			const result: AgentToolResult<unknown> = {
				content: [{ type: "text", text: "tsc ok" }],
				details: { exitCode: 0 },
			};

			await session.agent.afterToolCall!({
				assistantMessage: createFakeAssistantMessage(),
				toolCall,
				args: { command: "npm run typecheck" },
				result,
				isError: false,
				context: createFakeAgentContext(),
			});

			const state = session.getCurrentTaskState();
			expect(state?.verifications).toHaveLength(1);
			expect(state?.verifications[0].kind).toBe("typecheck");
			expect(state?.verifications[0].passed).toBe(true);
		} finally {
			session.dispose();
		}
	});

	it("does not record a verification for non-verification bash commands", async () => {
		const { session } = await createSession();
		try {
			const toolCall: AgentToolCall = {
				type: "toolCall",
				id: "bash-5",
				name: "bash",
				arguments: { command: "ls -la" },
			};
			const result: AgentToolResult<unknown> = {
				content: [{ type: "text", text: "..." }],
				details: { exitCode: 0 },
			};

			await session.agent.afterToolCall!({
				assistantMessage: createFakeAssistantMessage(),
				toolCall,
				args: { command: "ls -la" },
				result,
				isError: false,
				context: createFakeAgentContext(),
			});

			const state = session.getCurrentTaskState();
			expect(state?.verifications ?? []).toHaveLength(0);
		} finally {
			session.dispose();
		}
	});
});

