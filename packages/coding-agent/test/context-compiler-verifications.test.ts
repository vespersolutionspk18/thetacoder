import type { AgentMessage } from "@theta/agent-core";
import type { UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { compileContext } from "../src/core/context-compiler.ts";
import { createInitialTaskState, recordVerification } from "../src/core/task-state.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

function findFailedVerificationsMessage(messages: AgentMessage[]): string | undefined {
	for (const m of messages) {
		if (m.role === "custom" && m.customType === "task-state-context") {
			const content = typeof m.content === "string" ? m.content : "";
			if (content.includes("Failed verifications")) return content;
		}
	}
	return undefined;
}

describe("compileContext — failed verifications", () => {
	it("includes a failed verification in the projection when includeVerifications=true (default)", () => {
		let state = createInitialTaskState("s");
		state = recordVerification(state, { kind: "test", command: "npm test", passed: false });
		const out = compileContext([makeUser("hi", 1)], state, { tokenBudget: 1_000_000 });

		const body = findFailedVerificationsMessage(out.messages);
		expect(body).toBeDefined();
		expect(body).toContain("test");
		expect(body).toContain("npm test");
		expect(body).toContain("passed=false");
	});

	it("lists multiple failed verifications", () => {
		let state = createInitialTaskState("s");
		state = recordVerification(state, { kind: "test", command: "npm test", passed: false });
		state = recordVerification(state, { kind: "lint", command: "npm run lint", passed: false });
		state = recordVerification(state, { kind: "typecheck", passed: false });
		const out = compileContext([makeUser("hi", 1)], state, { tokenBudget: 1_000_000 });

		const body = findFailedVerificationsMessage(out.messages);
		expect(body).toBeDefined();
		expect(body).toContain("npm test");
		expect(body).toContain("npm run lint");
		expect(body).toContain("typecheck");
	});

	it("does not surface passed verifications", () => {
		let state = createInitialTaskState("s");
		state = recordVerification(state, { kind: "test", command: "npm test", passed: true });
		const out = compileContext([makeUser("hi", 1)], state, { tokenBudget: 1_000_000 });

		expect(findFailedVerificationsMessage(out.messages)).toBeUndefined();
	});

	it("includeVerifications=false suppresses the failed-verifications message", () => {
		let state = createInitialTaskState("s");
		state = recordVerification(state, { kind: "test", command: "npm test", passed: false });
		const out = compileContext([makeUser("hi", 1)], state, {
			tokenBudget: 1_000_000,
			includeVerifications: false,
		});

		expect(findFailedVerificationsMessage(out.messages)).toBeUndefined();
	});

	it("a false-success flag is reflected in the rendered verification", () => {
		let state = createInitialTaskState("s");
		state = recordVerification(state, { kind: "test", command: "npm test", passed: false, falseSuccess: true });
		const out = compileContext([makeUser("hi", 1)], state, { tokenBudget: 1_000_000 });

		const body = findFailedVerificationsMessage(out.messages);
		expect(body).toBeDefined();
		expect(body).toContain("false success");
	});
});

