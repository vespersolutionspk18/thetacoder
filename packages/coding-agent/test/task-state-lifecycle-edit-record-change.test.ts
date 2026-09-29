/**
 * F2 TaskState lifecycle — `edit` tool → `recordChange` wiring.
 *
 * The session's `afterToolCall` hook bridges every successful tool
 * call into the F2 TaskState. For `edit` and `write` the bridge
 * reads `result.details.contentIdentity` and the validated `args.path`
 * and calls `recordChange({ path, contentHash, toolCallId })`. The
 * change only lands in the TaskState when `contentIdentity` is set
 * (the tool either omitted it or attached `undefined`), so the test
 * exercises the success path directly through the agent-core hook
 * that `_installAgentToolHooks` installs.
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

describe("AgentSession afterToolCall hook — edit/write → recordChange", () => {
	it("records a change when an edit tool result carries a contentIdentity", async () => {
		const { session } = await createSession();
		try {
			const toolCall: AgentToolCall = {
				type: "toolCall",
				id: "edit-1",
				name: "edit",
				arguments: { path: "src/parser.ts" },
			};
			const result: AgentToolResult<unknown> = {
				content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/parser.ts." }],
				details: {
					diff: "...",
					patch: "...",
					contentIdentity: "sha256:abc123",
				},
			};

			await session.agent.afterToolCall!({
				assistantMessage: createFakeAssistantMessage(),
				toolCall,
				args: { path: "src/parser.ts" },
				result,
				isError: false,
				context: createFakeAgentContext(),
			});

			const state = session.getCurrentTaskState();
			expect(state).toBeDefined();
			expect(state?.changedFiles).toHaveLength(1);
			expect(state?.changedFiles[0].path).toBe("src/parser.ts");
			expect(state?.changedFiles[0].contentHash).toBe("sha256:abc123");
			expect(state?.changedFiles[0].toolCallId).toBe("edit-1");
		} finally {
			session.dispose();
		}
	});

	it("records a change for `write` tool calls with a contentIdentity", async () => {
		const { session } = await createSession();
		try {
			const toolCall: AgentToolCall = {
				type: "toolCall",
				id: "write-1",
				name: "write",
				arguments: { path: "README.md", content: "hello" },
			};
			const result: AgentToolResult<unknown> = {
				content: [{ type: "text", text: "Successfully wrote to README.md" }],
				details: { contentIdentity: "sha256:def456" },
			};

			await session.agent.afterToolCall!({
				assistantMessage: createFakeAssistantMessage(),
				toolCall,
				args: { path: "README.md", content: "hello" },
				result,
				isError: false,
				context: createFakeAgentContext(),
			});

			const state = session.getCurrentTaskState();
			expect(state?.changedFiles).toHaveLength(1);
			expect(state?.changedFiles[0].path).toBe("README.md");
			expect(state?.changedFiles[0].contentHash).toBe("sha256:def456");
			expect(state?.changedFiles[0].toolCallId).toBe("write-1");
		} finally {
			session.dispose();
		}
	});

	it("does not record a change when the edit result has no contentIdentity", async () => {
		const { session } = await createSession();
		try {
			const toolCall: AgentToolCall = {
				type: "toolCall",
				id: "edit-2",
				name: "edit",
				arguments: { path: "src/parser.ts" },
			};
			const result: AgentToolResult<unknown> = {
				content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/parser.ts." }],
				details: { diff: "...", patch: "..." },
			};

			await session.agent.afterToolCall!({
				assistantMessage: createFakeAssistantMessage(),
				toolCall,
				args: { path: "src/parser.ts" },
				result,
				isError: false,
				context: createFakeAgentContext(),
			});

			const state = session.getCurrentTaskState();
			expect(state?.changedFiles ?? []).toHaveLength(0);
		} finally {
			session.dispose();
		}
	});
});

