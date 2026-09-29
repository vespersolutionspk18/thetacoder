import type { AgentTool } from "@theta/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@theta/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createPlan } from "../src/core/execution-plan/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/**
 * When `executionPlan.enabled` is `false` (the default), the agent loop
 * MUST ignore the `executionPlan` field on an assistant message and run
 * tool calls through the natural `executeToolCalls` path byte-for-byte.
 *
 * The marker: a tool call defined in the harness is invoked exactly once
 * (the model-driven path), and the per-step executor is never touched
 * (no synthetic per-step tool calls from the F6 step runner).
 */
describe("AgentSession F6 executionPlan routing — flag off", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("does not route through the executor when the setting is off", async () => {
		const toolRuns: string[] = [];
		const probeTool: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Probe tool that records invocations",
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_toolCallId, params) => {
				const value =
					typeof params === "object" && params !== null && "value" in params ? String(params.value) : "";
				toolRuns.push(value);
				return {
					content: [{ type: "text", text: `probe:${value}` }],
					details: { value },
				};
			},
		};

		const harness = await createHarness({
			tools: [probeTool],
			// Default settings: executionPlan.enabled === false
		});
		harnesses.push(harness);

		const plan = createPlan("flag-off-plan")
			.step({ id: "s1", kind: "read", operation: "probe", target: "anywhere" })
			.build();

		// Assistant message carries an `executionPlan` envelope, but the
		// flag is off so the agent loop should treat this as a normal
		// `probe` tool call and ignore the plan envelope entirely.
		const assistantWithPlan = fauxAssistantMessage([fauxToolCall("probe", { value: "natural" })], {
			stopReason: "toolUse",
		});
		(assistantWithPlan as { executionPlan?: unknown }).executionPlan = {
			plan,
			steps: plan.steps,
		};

		harness.setResponses([assistantWithPlan, fauxAssistantMessage("done")]);

		await harness.session.prompt("start");

		// The natural `probe` tool call ran once. The F6 step runner was
		// not invoked (its read-kind step would have produced a *second*
		// tool call with the read tool, not the probe tool).
		expect(toolRuns).toEqual(["natural"]);

		// Conversation: user, assistant (with plan envelope), one
		// toolResult (from the probe tool call), then a final assistant.
		const roles = harness.session.messages.map((message) => message.role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		// The single toolResult belongs to the natural `probe` call.
		expect(toolResults[0]?.toolName).toBe("probe");
	});
});

