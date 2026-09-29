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

describe("AgentSession.recordVerification", () => {
	it("appends a passing test verification and returns its id", async () => {
		const { session } = await createSession();
		try {
			const id = session.recordVerification({
				kind: "test",
				command: "npm test",
				passed: true,
			});

			expect(typeof id).toBe("string");
			expect(id.length).toBeGreaterThan(0);

			const state = session.getCurrentTaskState();
			expect(state?.verifications).toHaveLength(1);
			expect(state?.verifications[0].id).toBe(id);
			expect(state?.verifications[0].kind).toBe("test");
			expect(state?.verifications[0].command).toBe("npm test");
			expect(state?.verifications[0].passed).toBe(true);
			expect(state?.verifications[0].observedAt).toBeTypeOf("number");
		} finally {
			session.dispose();
		}
	});

	it("records a failed verification with snapshot hash and falseSuccess flag", async () => {
		const { session } = await createSession();
		try {
			session.recordVerification({
				kind: "snapshot",
				passed: false,
				falseSuccess: true,
				snapshotHash: "sha256:abc",
			});

			const v = session.getCurrentTaskState()?.verifications[0];
			expect(v?.kind).toBe("snapshot");
			expect(v?.passed).toBe(false);
			expect(v?.falseSuccess).toBe(true);
			expect(v?.snapshotHash).toBe("sha256:abc");
		} finally {
			session.dispose();
		}
	});

	it("accepts all verification kinds", async () => {
		const { session } = await createSession();
		try {
			const kinds = ["test", "lint", "typecheck", "snapshot", "manual", "user-accepted"] as const;
			for (const kind of kinds) {
				session.recordVerification({ kind, passed: true });
			}
			const seen = session.getCurrentTaskState()?.verifications.map((v) => v.kind) ?? [];
			expect(seen).toEqual([...kinds]);
		} finally {
			session.dispose();
		}
	});
});

