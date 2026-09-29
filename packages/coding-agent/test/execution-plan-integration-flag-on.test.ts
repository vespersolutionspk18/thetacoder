import type { AgentTool } from "@theta/agent-core";
import { fauxAssistantMessage } from "@theta/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createPlan } from "../src/core/execution-plan/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/**
 * When `executionPlan.enabled` is `true` AND the assistant message carries
 * an `executionPlan` envelope, the agent loop MUST route the plan
 * through the F6 `executePlan` runtime. The natural `executeToolCalls`
 * path is bypassed for the plan-bearing message.
 *
 * The marker: no natural tool call is made for the plan-bearing message.
 * Instead, per-step tool calls appear in the conversation as
 * `toolResult` messages, one per plan step, with tool names derived from
 * the step's `kind`.
 */
describe("AgentSession F6 executionPlan routing — flag on", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("routes a plan-bearing assistant message through the F6 executor", async () => {
		const readCalls: Array<{ path: string }> = [];
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: Type.Object({ path: Type.String() }),
			execute: async (_toolCallId, params) => {
				const path = typeof params === "object" && params !== null && "path" in params ? String(params.path) : "";
				readCalls.push({ path });
				return {
					content: [{ type: "text", text: `contents of ${path}` }],
					details: { path, content: "x" },
				};
			},
		};

		const harness = await createHarness({
			tools: [readTool],
			settings: { executionPlan: { enabled: true, concurrency: 1 } },
		});
		harnesses.push(harness);

		const plan = createPlan("flag-on-plan")
			.step({ id: "r1", kind: "read", operation: "read a", target: "src/a.ts" })
			.step({ id: "r2", kind: "read", operation: "read b", target: "src/b.ts" })
			.build();

		const assistantWithPlan = fauxAssistantMessage(
			// No natural tool call; only the plan envelope.
			[],
			{ stopReason: "stop" },
		);
		(assistantWithPlan as { executionPlan?: unknown }).executionPlan = {
			plan,
			steps: plan.steps,
		};

		harness.setResponses([assistantWithPlan, fauxAssistantMessage("done")]);

		await harness.session.prompt("start");

		// The F6 step runner dispatched each plan step through the read
		// tool. No "natural" tool call was made (the model did not emit
		// a tool call on this turn), so we expect exactly two read
		// invocations — one per plan step — with the plan's targets.
		expect(readCalls).toEqual([{ path: "src/a.ts" }, { path: "src/b.ts" }]);

		// Conversation: user, assistant (plan envelope), two toolResults
		// (one per step), then a final assistant.
		const roles = harness.session.messages.map((message) => message.role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "toolResult", "assistant"]);

		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(2);
		// Each tool result belongs to a read step mapped to the read tool.
		for (const message of toolResults) {
			expect(message.role).toBe("toolResult");
			if (message.role === "toolResult") {
				expect(message.toolName).toBe("read");
			}
		}
	});
});

