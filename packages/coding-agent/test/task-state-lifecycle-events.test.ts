import { Agent } from "@theta/agent-core";
import { getModel, streamSimple } from "@theta/ai/compat";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
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

/** Collect every event that matches a predicate. Used to isolate task_state_update
 *  events from any other events the session fires during construction. */
function subscribeFiltered(session: AgentSession, predicate: (e: AgentSessionEvent) => boolean): AgentSessionEvent[] {
	const captured: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		if (predicate(event)) captured.push(event);
	});
	return captured;
}

describe("AgentSession task_state_update events", () => {
	it("setObjective emits task_state_update with mutation=objective", async () => {
		const { session } = await createSession();
		try {
			const events = subscribeFiltered(session, (e) => e.type === "task_state_update");
			session.setObjective("Investigate the regression");

			expect(events).toHaveLength(1);
			const e = events[0];
			expect(e.type).toBe("task_state_update");
			if (e.type === "task_state_update") {
				expect(e.mutation).toBe("objective");
				expect(e.taskState.objective?.text).toBe("Investigate the regression");
			}
		} finally {
			session.dispose();
		}
	});

	it("addConstraint emits task_state_update with mutation=constraint", async () => {
		const { session } = await createSession();
		try {
			const events = subscribeFiltered(session, (e) => e.type === "task_state_update");
			session.addConstraint({ text: "Stay on the audit-aligned path", source: "user" });

			expect(events).toHaveLength(1);
			if (events[0].type === "task_state_update") {
				expect(events[0].mutation).toBe("constraint");
				expect(events[0].taskState.constraints[0].text).toBe("Stay on the audit-aligned path");
			}
		} finally {
			session.dispose();
		}
	});

	it("recordDecision emits task_state_update with mutation=decision", async () => {
		const { session } = await createSession();
		try {
			const events = subscribeFiltered(session, (e) => e.type === "task_state_update");
			session.recordDecision({ text: "Use pure helpers in task-state.ts" });

			expect(events).toHaveLength(1);
			if (events[0].type === "task_state_update") {
				expect(events[0].mutation).toBe("decision");
				expect(events[0].taskState.decisions[0].text).toBe("Use pure helpers in task-state.ts");
			}
		} finally {
			session.dispose();
		}
	});

	it("markHypothesisResolved emits task_state_update with mutation=hypothesis", async () => {
		const { session, sessionManager } = await createSession();
		try {
			const { createInitialTaskState } = await import("../src/core/task-state.ts");
			const seeded = createInitialTaskState("seed-events");
			seeded.hypotheses.push({
				id: "h-events",
				text: "Open hypothesis",
				status: "open",
				madeAt: Date.now(),
			});
			sessionManager.appendTaskState(seeded);

			const events = subscribeFiltered(session, (e) => e.type === "task_state_update");
			session.markHypothesisResolved("h-events", "confirmed");

			expect(events).toHaveLength(1);
			if (events[0].type === "task_state_update") {
				expect(events[0].mutation).toBe("hypothesis");
				const h = events[0].taskState.hypotheses.find((x) => x.id === "h-events");
				expect(h?.status).toBe("confirmed");
			}
		} finally {
			session.dispose();
		}
	});

	it("markHypothesisResolved does NOT emit when the id is unknown", async () => {
		const { session } = await createSession();
		try {
			const events = subscribeFiltered(session, (e) => e.type === "task_state_update");
			session.markHypothesisResolved("does-not-exist", "refuted");
			expect(events).toHaveLength(0);
		} finally {
			session.dispose();
		}
	});

	it("recordVerification emits task_state_update with mutation=verification", async () => {
		const { session } = await createSession();
		try {
			const events = subscribeFiltered(session, (e) => e.type === "task_state_update");
			session.recordVerification({ kind: "typecheck", command: "tsgo --noEmit", passed: true });

			expect(events).toHaveLength(1);
			if (events[0].type === "task_state_update") {
				expect(events[0].mutation).toBe("verification");
				expect(events[0].taskState.verifications[0].kind).toBe("typecheck");
			}
		} finally {
			session.dispose();
		}
	});

	it("recordChange emits task_state_update with mutation=change", async () => {
		const { session } = await createSession();
		try {
			const events = subscribeFiltered(session, (e) => e.type === "task_state_update");
			session.recordChange({ path: "src/x.ts", contentHash: "h" });

			expect(events).toHaveLength(1);
			if (events[0].type === "task_state_update") {
				expect(events[0].mutation).toBe("change");
				expect(events[0].taskState.changedFiles[0].path).toBe("src/x.ts");
			}
		} finally {
			session.dispose();
		}
	});

	it("each event carries the full post-mutation TaskState", async () => {
		const { session } = await createSession();
		try {
			const events = subscribeFiltered(session, (e) => e.type === "task_state_update");

			session.setObjective("Goal");
			session.addConstraint({ text: "Rule" });
			session.recordDecision({ text: "Plan" });
			session.recordVerification({ kind: "test", passed: true });
			session.recordChange({ path: "f.ts", contentHash: "h" });

			expect(events).toHaveLength(5);
			for (const e of events) {
				if (e.type === "task_state_update") {
					// Each event's taskState must contain the mutation it advertises.
					switch (e.mutation) {
						case "objective":
							expect(e.taskState.objective?.text).toBe("Goal");
							break;
						case "constraint":
							expect(e.taskState.constraints.map((c) => c.text)).toContain("Rule");
							break;
						case "decision":
							expect(e.taskState.decisions.map((d) => d.text)).toContain("Plan");
							break;
						case "verification":
							expect(e.taskState.verifications.some((v) => v.kind === "test")).toBe(true);
							break;
						case "change":
							expect(e.taskState.changedFiles.some((f) => f.path === "f.ts")).toBe(true);
							break;
						case "hypothesis":
							// Not exercised in this scenario.
							break;
					}
				}
			}
		} finally {
			session.dispose();
		}
	});
});

