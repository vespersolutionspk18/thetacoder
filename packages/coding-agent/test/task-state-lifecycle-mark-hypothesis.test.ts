import { Agent } from "@theta/agent-core";
import { getModel, streamSimple } from "@theta/ai/compat";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInitialTaskState } from "../src/core/task-state.ts";
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

/**
 * Seed a TaskState that contains an open hypothesis with a known id. The
 * lifecycle methods persist via SessionManager.appendTaskState, so seeding
 * through the same path is the natural round-trip — the test does not need
 * to depend on any private agent-session details.
 */
function seedOpenHypothesis(
	sessionManager: SessionManager,
	hypothesisId: string,
	text: string,
	createdAt: number,
): void {
	const seeded = createInitialTaskState(`seed-${hypothesisId}`);
	seeded.hypotheses.push({
		id: hypothesisId,
		text,
		status: "open",
		madeAt: createdAt,
	});
	sessionManager.appendTaskState(seeded);
}

describe("AgentSession.markHypothesisResolved", () => {
	it("no-ops on an unknown id when no state exists", async () => {
		const { session } = await createSession();
		try {
			session.markHypothesisResolved("does-not-exist", "confirmed");
			expect(session.getCurrentTaskState()).toBeUndefined();
		} finally {
			session.dispose();
		}
	});

	it("changes the status of a known open hypothesis to confirmed", async () => {
		const { session, sessionManager } = await createSession();
		try {
			const hId = "h-1";
			seedOpenHypothesis(sessionManager, hId, "The bug is in parser.ts", Date.now());

			session.markHypothesisResolved(hId, "confirmed");

			const state = session.getCurrentTaskState();
			const h = state?.hypotheses.find((x) => x.id === hId);
			expect(h).toBeDefined();
			expect(h?.status).toBe("confirmed");
			expect(typeof h?.resolvedAt).toBe("number");
		} finally {
			session.dispose();
		}
	});

	it("changes the status of a known open hypothesis to refuted", async () => {
		const { session, sessionManager } = await createSession();
		try {
			const hId = "h-2";
			seedOpenHypothesis(sessionManager, hId, "Cache is stale", Date.now());

			session.markHypothesisResolved(hId, "refuted");

			const h = session.getCurrentTaskState()?.hypotheses.find((x) => x.id === hId);
			expect(h?.status).toBe("refuted");
			expect(typeof h?.resolvedAt).toBe("number");
		} finally {
			session.dispose();
		}
	});

	it("does not touch a hypothesis that is already resolved", async () => {
		const { session, sessionManager } = await createSession();
		try {
			const hId = "h-3";
			// Seed with a hypothesis that is already confirmed.
			const seeded = createInitialTaskState(`seed-${hId}`);
			seeded.hypotheses.push({
				id: hId,
				text: "Already confirmed",
				status: "confirmed",
				madeAt: 1000,
				resolvedAt: 2000,
			});
			sessionManager.appendTaskState(seeded);

			// Resolving again should be a no-op (the pure helper only acts on
			// `status === "open"`), so the snapshot must not be re-persisted.
			const before = session.sessionManager.getBranch().length;
			session.markHypothesisResolved(hId, "refuted");
			const after = session.sessionManager.getBranch().length;
			expect(after).toBe(before);

			const h = session.getCurrentTaskState()?.hypotheses.find((x) => x.id === hId);
			expect(h?.status).toBe("confirmed");
			expect(h?.resolvedAt).toBe(2000);
		} finally {
			session.dispose();
		}
	});
});

