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

describe("AgentSession.recordChange", () => {
	it("appends a changed file with the observed content hash", async () => {
		const { session } = await createSession();
		try {
			session.recordChange({
				path: "src/parser.ts",
				contentHash: "sha256:deadbeef",
				toolCallId: "tool-1",
			});

			const state = session.getCurrentTaskState();
			expect(state?.changedFiles).toHaveLength(1);
			expect(state?.changedFiles[0].path).toBe("src/parser.ts");
			expect(state?.changedFiles[0].contentHash).toBe("sha256:deadbeef");
			expect(state?.changedFiles[0].toolCallId).toBe("tool-1");
			expect(state?.changedFiles[0].changedAt).toBeTypeOf("number");
		} finally {
			session.dispose();
		}
	});

	it("appends each observation (same path can be re-recorded)", async () => {
		const { session } = await createSession();
		try {
			session.recordChange({ path: "src/parser.ts", contentHash: "h1" });
			session.recordChange({ path: "src/parser.ts", contentHash: "h2" });

			const state = session.getCurrentTaskState();
			expect(state?.changedFiles).toHaveLength(2);
			expect(state?.changedFiles.map((f) => f.contentHash)).toEqual(["h1", "h2"]);
		} finally {
			session.dispose();
		}
	});

	it("works without a toolCallId", async () => {
		const { session } = await createSession();
		try {
			session.recordChange({ path: "README.md", contentHash: "h" });
			const f = session.getCurrentTaskState()?.changedFiles[0];
			expect(f?.toolCallId).toBeUndefined();
		} finally {
			session.dispose();
		}
	});
});

