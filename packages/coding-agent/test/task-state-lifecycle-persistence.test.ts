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

async function bootstrap() {
	const settingsManager = SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	const modelRuntime = getModelRuntime(modelRegistry);
	const resourceLoader = createTestResourceLoader();

	const makeAgent = () =>
		new Agent({
			getApiKey: () => "test-key",
			streamFn: streamSimple,
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "high",
			},
		});

	return { settingsManager, sessionManager, modelRuntime, resourceLoader, makeAgent };
}

describe("AgentSession TaskState persistence", () => {
	it("round-trips TaskState through the same SessionManager across a fresh AgentSession", async () => {
		const { settingsManager, sessionManager, modelRuntime, resourceLoader, makeAgent } = await bootstrap();

		const first = new AgentSession({
			agent: makeAgent(),
			sessionManager,
			settingsManager,
			cwd: process.cwd(),
			modelRuntime,
			resourceLoader,
		});

		try {
			first.setObjective("Land the F2 lifecycle");
			first.addConstraint({ text: "No breaking changes", source: "user" });
			first.recordDecision({
				text: "Adopt JSONL snapshot persistence",
				rationale: "Reuses existing SessionManager.",
			});
			first.recordVerification({ kind: "test", command: "npm test", passed: true });
			first.recordChange({ path: "agent-session.ts", contentHash: "h1" });

			// The branch should now contain task_state entries.
			const branchBefore = sessionManager.getBranch();
			expect(branchBefore.filter((e) => e.type === "task_state").length).toBeGreaterThanOrEqual(1);
		} finally {
			first.dispose();
		}

		// Re-open with a fresh AgentSession against the same SessionManager.
		const second = new AgentSession({
			agent: makeAgent(),
			sessionManager,
			settingsManager,
			cwd: process.cwd(),
			modelRuntime,
			resourceLoader,
		});

		try {
			const state = second.getCurrentTaskState();
			expect(state).toBeDefined();
			expect(state?.objective?.text).toBe("Land the F2 lifecycle");
			expect(state?.constraints.map((c) => c.text)).toContain("No breaking changes");
			expect(state?.decisions.map((d) => d.text)).toContain("Adopt JSONL snapshot persistence");
			expect(state?.verifications.some((v) => v.kind === "test" && v.passed)).toBe(true);
			expect(state?.changedFiles.some((f) => f.path === "agent-session.ts")).toBe(true);

			// Mutating through the new session continues from the persisted snapshot.
			second.addConstraint({ text: "Persist after reopen" });
			const after = second.getCurrentTaskState();
			expect(after?.constraints.map((c) => c.text)).toEqual(["No breaking changes", "Persist after reopen"]);
		} finally {
			second.dispose();
		}
	});

	it("returns undefined from getCurrentTaskState on a fresh manager with no prior mutations", async () => {
		const { settingsManager, sessionManager, modelRuntime, resourceLoader, makeAgent } = await bootstrap();
		const session = new AgentSession({
			agent: makeAgent(),
			sessionManager,
			settingsManager,
			cwd: process.cwd(),
			modelRuntime,
			resourceLoader,
		});
		try {
			expect(session.getCurrentTaskState()).toBeUndefined();
		} finally {
			session.dispose();
		}
	});
});

