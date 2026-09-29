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

describe("AgentSession.addConstraint", () => {
	it("appends a constraint with default source and returns its id", async () => {
		const { session } = await createSession();
		try {
			const id = session.addConstraint({ text: "No new dependencies" });

			expect(typeof id).toBe("string");
			expect(id.length).toBeGreaterThan(0);

			const state = session.getCurrentTaskState();
			expect(state?.constraints).toHaveLength(1);
			expect(state?.constraints[0].id).toBe(id);
			expect(state?.constraints[0].text).toBe("No new dependencies");
			expect(state?.constraints[0].source).toBe("model");
		} finally {
			session.dispose();
		}
	});

	it("honours explicit source and evidenceRefs", async () => {
		const { session } = await createSession();
		try {
			session.addConstraint({
				text: "Use the new auth provider",
				source: "user",
				evidenceRefs: ["user-msg-1"],
			});

			const state = session.getCurrentTaskState();
			expect(state?.constraints[0].source).toBe("user");
			expect(state?.constraints[0].evidenceRefs).toEqual(["user-msg-1"]);
		} finally {
			session.dispose();
		}
	});

	it("accumulates multiple constraints with distinct ids", async () => {
		const { session } = await createSession();
		try {
			const id1 = session.addConstraint({ text: "first" });
			const id2 = session.addConstraint({ text: "second", source: "user" });

			expect(id1).not.toBe(id2);

			const state = session.getCurrentTaskState();
			expect(state?.constraints.map((c) => c.text)).toEqual(["first", "second"]);
		} finally {
			session.dispose();
		}
	});
});

