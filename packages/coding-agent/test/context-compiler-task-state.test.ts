import type { AgentMessage } from "@theta/agent-core";
import type { UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { compileContext } from "../src/core/context-compiler.ts";
import { addConstraint, createInitialTaskState, recordDecision } from "../src/core/task-state.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

function findTaskStateContextMessages(
	messages: AgentMessage[],
): { content: string; display?: boolean; customType: string }[] {
	const out: { content: string; display?: boolean; customType: string }[] = [];
	for (const m of messages) {
		if (m.role === "custom" && m.customType === "task-state-context") {
			const content = typeof m.content === "string" ? m.content : "";
			out.push({ content, display: m.display, customType: m.customType });
		}
	}
	return out;
}

describe("compileContext — TaskState injection", () => {
	it("injects the objective as a task-state-context message", () => {
		let state = createInitialTaskState("s");
		state = { ...state, objective: { text: "Refactor the auth module", createdAt: 1 } };
		const out = compileContext([makeUser("hi", 1)], state, { tokenBudget: 1_000_000 });

		const injected = findTaskStateContextMessages(out.messages);
		expect(injected.length).toBeGreaterThan(0);
		expect(injected.some((m) => m.content.includes("Refactor the auth module"))).toBe(true);
		expect(injected.every((m) => m.display === false)).toBe(true);
	});

	it("injects active constraints as a task-state-context message", () => {
		let state = createInitialTaskState("s");
		state = addConstraint(state, { text: "No new deps", source: "user" });
		state = addConstraint(state, { text: "Keep public API stable", source: "model" });
		const out = compileContext([makeUser("hi", 1)], state, { tokenBudget: 1_000_000 });

		const injected = findTaskStateContextMessages(out.messages);
		const constraintsMsg = injected.find((m) => m.content.includes("Active constraints"));
		expect(constraintsMsg).toBeDefined();
		expect(constraintsMsg?.content).toContain("No new deps");
		expect(constraintsMsg?.content).toContain("Keep public API stable");
	});

	it("injects unresolved decisions as a task-state-context message", () => {
		let state = createInitialTaskState("s");
		state = recordDecision(state, { text: "Use SQLite for storage" });
		state = recordDecision(state, { text: "Skip typecheck for tests" });
		const out = compileContext([makeUser("hi", 1)], state, { tokenBudget: 1_000_000 });

		const injected = findTaskStateContextMessages(out.messages);
		const decisionsMsg = injected.find((m) => m.content.includes("Use SQLite for storage"));
		expect(decisionsMsg).toBeDefined();
		expect(decisionsMsg?.content).toContain("Skip typecheck for tests");
	});

	it("TaskState messages are inserted at the head of the output", () => {
		let state = createInitialTaskState("s");
		state = { ...state, objective: { text: "Goal", createdAt: 1 } };
		const out = compileContext([makeUser("first", 1), makeUser("second", 2)], state, { tokenBudget: 1_000_000 });

		// The very first message must be a task-state-context message.
		expect(out.messages[0]?.role).toBe("custom");
		if (out.messages[0]?.role === "custom") {
			expect(out.messages[0].customType).toBe("task-state-context");
		}
		// And the original messages come after.
		expect(out.messages[1]?.role).toBe("user");
	});

	it("includeConstraints=false suppresses the constraints message", () => {
		let state = createInitialTaskState("s");
		state = addConstraint(state, { text: "No new deps", source: "user" });
		const out = compileContext([makeUser("hi", 1)], state, {
			tokenBudget: 1_000_000,
			includeConstraints: false,
		});

		const injected = findTaskStateContextMessages(out.messages);
		expect(injected.every((m) => !m.content.includes("Active constraints"))).toBe(true);
	});

	it("a TaskState with no objective/constraints/decisions/verifications produces no injected messages", () => {
		const state = createInitialTaskState("s");
		const out = compileContext([makeUser("hi", 1)], state, { tokenBudget: 1_000_000 });

		expect(findTaskStateContextMessages(out.messages)).toHaveLength(0);
		expect(out.accounting.taskStateInjectedMessages).toBe(0);
	});

	it("TaskState messages are marked essential and survive an aggressive budget", () => {
		let state = createInitialTaskState("s");
		state = { ...state, objective: { text: "Goal X", createdAt: 1 } };
		state = addConstraint(state, { text: "Constraint Y", source: "user" });
		const out = compileContext([makeUser("hi", 1)], state, { tokenBudget: 1 });

		// The task-state-context message(s) should still be present even
		// though the budget is impossibly small.
		const injected = findTaskStateContextMessages(out.messages);
		expect(injected.length).toBeGreaterThan(0);
		expect(injected.some((m) => m.content.includes("Goal X"))).toBe(true);
	});

	it("records the count of TaskState-derived injected messages", () => {
		let state = createInitialTaskState("s");
		state = { ...state, objective: { text: "O", createdAt: 1 } };
		state = addConstraint(state, { text: "C", source: "user" });
		state = recordDecision(state, { text: "D" });
		const out = compileContext([makeUser("hi", 1)], state, { tokenBudget: 1_000_000 });

		// objective + constraints + decisions-hypotheses = 3 injected
		expect(out.accounting.taskStateInjectedMessages).toBe(3);
	});
});

