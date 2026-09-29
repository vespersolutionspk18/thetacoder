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

describe("AgentSession.setObjective", () => {
	it("records the objective on the current TaskState", async () => {
		const { session } = await createSession();
		try {
			expect(session.getCurrentTaskState()).toBeUndefined();

			session.setObjective("Find the bug");

			const state = session.getCurrentTaskState();
			expect(state).toBeDefined();
			expect(state?.objective?.text).toBe("Find the bug");
			expect(state?.objective?.sourceRequestId).toBeUndefined();
		} finally {
			session.dispose();
		}
	});

	it("replaces any prior objective", async () => {
		const { session } = await createSession();
		try {
			session.setObjective("First objective");
			session.setObjective("Second objective");

			const state = session.getCurrentTaskState();
			expect(state?.objective?.text).toBe("Second objective");
		} finally {
			session.dispose();
		}
	});

	it("stores sourceRequestId when provided", async () => {
		const { session } = await createSession();
		try {
			session.setObjective("Patch the API", "user-msg-7");

			const state = session.getCurrentTaskState();
			expect(state?.objective?.text).toBe("Patch the API");
			expect(state?.objective?.sourceRequestId).toBe("user-msg-7");
		} finally {
			session.dispose();
		}
	});
});

