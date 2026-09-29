import { Agent } from "@theta/agent-core";
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

describe("AgentSession.recordDecision", () => {
	it("appends a decision with rationale and returns its id", async () => {
		const { session } = await createSession();
		try {
			const id = session.recordDecision({
				text: "Use SQLite for the queue",
				rationale: "Single binary, no external services.",
			});

			expect(typeof id).toBe("string");
			expect(id.length).toBeGreaterThan(0);

			const state = session.getCurrentTaskState();
			expect(state?.decisions).toHaveLength(1);
			expect(state?.decisions[0].id).toBe(id);
			expect(state?.decisions[0].text).toBe("Use SQLite for the queue");
			expect(state?.decisions[0].rationale).toBe("Single binary, no external services.");
		} finally {
			session.dispose();
		}
	});

	it("preserves evidenceRefs when provided", async () => {
		const { session } = await createSession();
		try {
			session.recordDecision({
				text: "Move validation to a new module",
				evidenceRefs: ["decision-0", "constraint-1"],
			});

			const state = session.getCurrentTaskState();
			expect(state?.decisions[0].evidenceRefs).toEqual(["decision-0", "constraint-1"]);
		} finally {
			session.dispose();
		}
	});

	it("accumulates multiple decisions", async () => {
		const { session } = await createSession();
		try {
			session.recordDecision({ text: "first" });
			session.recordDecision({ text: "second" });

			const state = session.getCurrentTaskState();
			expect(state?.decisions.map((d) => d.text)).toEqual(["first", "second"]);
		} finally {
			session.dispose();
		}
	});
});

