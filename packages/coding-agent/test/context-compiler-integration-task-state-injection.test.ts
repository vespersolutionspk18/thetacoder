/**
 * F2 context-compiler integration — TaskState injection.
 *
 * Verifies that when the context compiler is enabled, the latest TaskState
 * snapshot appended to the session branch is injected into the projected
 * message stream. The audit considers the active constraints and failed
 * verifications "always visible" context — they survive budget trimming
 * because the F2 module marks them as essential. This test seeds a
 * TaskState with constraints, sets the context compiler, and asserts the
 * LLM-bound message stream contains the constraint text as a
 * `task-state-context` custom message at the head of the output.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, Message, UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { compileContext } from "../src/core/context-compiler.ts";
import { addConstraint, createInitialTaskState, setObjective } from "../src/core/task-state.ts";
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

function taskStateContextTexts(messages: AgentMessage[]): string[] {
	const out: string[] = [];
	for (const m of messages) {
		if (m.role === "custom" && m.customType === "task-state-context") {
			out.push(typeof m.content === "string" ? m.content : "");
		}
	}
	return out;
}

describe("F2 context compiler integration — TaskState injection", () => {
	it("injects active constraints from the latest TaskState snapshot as custom messages", async () => {
		const harness = await createHarness({
			responses: ["ok"],
			systemPrompt: "test",
			contextWindow: 128_000,
		});
		try {
			// Seed a small conversation so the agent loop has something to
			// project.
			harness.agent.state.messages = [makeUser("first", 1), makeAssistant("reply", 2)];

			// Append a TaskState snapshot with constraints to the session
			// branch before the agent runs. The agent loop's `getTaskState`
			// callback will resolve this on each turn.
			let state = createInitialTaskState("test");
			state = setObjective(state, { text: "Refactor the auth module", createdAt: 100 });
			state = addConstraint(state, { text: "No new dependencies", source: "user" });
			state = addConstraint(state, { text: "Keep the public API stable", source: "model" });
			harness.sessionManager.appendTaskState(state);

			harness.agent.transformContext = async (messages) => messages;
			harness.agent.contextCompiler = {
				enabled: true,
				keepRecentTokens: 20_000,
				keepRecentTurns: 20,
				getTaskState: () => {
					// Walk the live session branch so we pick up the snapshot
					// we just appended.
					const branch = harness.sessionManager.getBranch();
					for (let i = branch.length - 1; i >= 0; i--) {
						const entry = branch[i];
						if (entry && entry.type === "task_state") {
							return entry.taskState;
						}
					}
					return undefined;
				},
				compile: (messages, taskState, options) => {
					return compileContext(messages, taskState as Parameters<typeof compileContext>[1], options).messages;
				},
			};
			harness.agent.convertToLlm = (messages) => messages as Message[];

			await harness.session.prompt("trigger");
			await harness.session.waitForIdle();

			const ctx = harness.faux.contexts[0];
			expect(ctx).toBeDefined();
			const llmMessages = ctx.messages as unknown as AgentMessage[];

			// The projection must contain the task-state-context custom
			// messages for objective, active constraints, and decisions.
			const injectedTexts = taskStateContextTexts(llmMessages);
			expect(injectedTexts.length).toBeGreaterThan(0);
			expect(injectedTexts.some((t) => t.includes("Refactor the auth module"))).toBe(true);
			expect(injectedTexts.some((t) => t.includes("No new dependencies"))).toBe(true);
			expect(injectedTexts.some((t) => t.includes("Keep the public API stable"))).toBe(true);

			// The constraints message must appear at the head of the
			// projection, ahead of the conversation turns.
			const firstInjectedIndex = llmMessages.findIndex(
				(m) => m.role === "custom" && m.customType === "task-state-context",
			);
			const firstUserIndex = llmMessages.findIndex((m) => m.role === "user");
			expect(firstInjectedIndex).toBeGreaterThanOrEqual(0);
			expect(firstInjectedIndex).toBeLessThan(firstUserIndex);
		} finally {
			harness.cleanup();
		}
	});

	it("does not inject anything when the session has no TaskState snapshot", async () => {
		const harness = await createHarness({
			responses: ["ok"],
			systemPrompt: "test",
			contextWindow: 128_000,
		});
		try {
			harness.agent.state.messages = [makeUser("a", 1), makeAssistant("b", 2)];

			// No appendTaskState call — the branch has no TaskState entries.
			harness.agent.transformContext = async (messages) => messages;
			harness.agent.contextCompiler = {
				enabled: true,
				keepRecentTokens: 20_000,
				keepRecentTurns: 20,
				getTaskState: () => {
					const branch = harness.sessionManager.getBranch();
					for (let i = branch.length - 1; i >= 0; i--) {
						const entry = branch[i];
						if (entry && entry.type === "task_state") {
							return entry.taskState;
						}
					}
					return undefined;
				},
				compile: (messages, taskState, options) => {
					return compileContext(messages, taskState as Parameters<typeof compileContext>[1], options).messages;
				},
			};
			harness.agent.convertToLlm = (messages) => messages as Message[];

			await harness.session.prompt("trigger");
			await harness.session.waitForIdle();

			const ctx = harness.faux.contexts[0];
			const llmMessages = ctx.messages as unknown as AgentMessage[];
			const injectedTexts = taskStateContextTexts(llmMessages);
			expect(injectedTexts).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("reads the *latest* TaskState when several snapshots exist on the branch", async () => {
		// `getLatestTaskState` walks the branch from the tip and returns
		// the most recent snapshot. The agent loop must do the same so
		// superseded TaskState constraints do not leak into the projection.
		const harness = await createHarness({
			responses: ["ok"],
			systemPrompt: "test",
			contextWindow: 128_000,
		});
		try {
			harness.agent.state.messages = [makeUser("first", 1), makeAssistant("reply", 2)];

			// First snapshot: "old constraint" only.
			const first = createInitialTaskState("v1");
			const firstWithConstraint = addConstraint(first, {
				text: "old constraint",
				source: "user",
			});
			harness.sessionManager.appendTaskState(firstWithConstraint);

			// Second snapshot: "new constraint" only.
			const second = createInitialTaskState("v2");
			const secondWithConstraint = addConstraint(second, {
				text: "new constraint",
				source: "user",
			});
			harness.sessionManager.appendTaskState(secondWithConstraint);

			harness.agent.transformContext = async (messages) => messages;
			harness.agent.contextCompiler = {
				enabled: true,
				keepRecentTokens: 20_000,
				keepRecentTurns: 20,
				getTaskState: () => {
					const branch = harness.sessionManager.getBranch();
					for (let i = branch.length - 1; i >= 0; i--) {
						const entry = branch[i];
						if (entry && entry.type === "task_state") {
							return entry.taskState;
						}
					}
					return undefined;
				},
				compile: (messages, taskState, options) => {
					return compileContext(messages, taskState as Parameters<typeof compileContext>[1], options).messages;
				},
			};
			harness.agent.convertToLlm = (messages) => messages as Message[];

			await harness.session.prompt("trigger");
			await harness.session.waitForIdle();

			const ctx = harness.faux.contexts[0];
			const llmMessages = ctx.messages as unknown as AgentMessage[];
			const injectedTexts = taskStateContextTexts(llmMessages);

			expect(injectedTexts.some((t) => t.includes("new constraint"))).toBe(true);
			expect(injectedTexts.some((t) => t.includes("old constraint"))).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});

