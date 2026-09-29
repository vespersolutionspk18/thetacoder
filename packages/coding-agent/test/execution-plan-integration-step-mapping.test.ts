import type { AgentTool } from "@theta/agent-core";
import { fauxAssistantMessage } from "@theta/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createPlan } from "../src/core/execution-plan/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/**
 * The F6 `StepRunner` maps a plan step's `kind` and `target` to a
 * concrete tool call. The mapping is:
 *   - kind "read"  → read({ path: target })
 *   - kind "bash"  → bash({ command: <operation or target> })
 *   - kind "edit"  → edit({ path: target })
 *   - kind "write" → write({ path: target })
 *   - kind "grep"  → grep({ path: target })
 *   - kind "find"  → find({ path: target })
 *
 * This test exercises the read and bash mappings end-to-end and asserts
 * that the runner invokes the right tool with the right arguments.
 */
describe("AgentSession F6 executionPlan step -> tool mapping", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("maps kind:read to the read tool with the plan target as the path", async () => {
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
					content: [{ type: "text", text: `read:${path}` }],
					details: { path, content: "" },
				};
			},
		};

		const harness = await createHarness({
			tools: [readTool],
			settings: { executionPlan: { enabled: true } },
		});
		harnesses.push(harness);

		const plan = createPlan("read-mapping")
			.step({ id: "r1", kind: "read", operation: "read input", target: "src/plan-input.ts" })
			.build();

		const assistantWithPlan = fauxAssistantMessage([], { stopReason: "stop" });
		(assistantWithPlan as { executionPlan?: unknown }).executionPlan = {
			plan,
			steps: plan.steps,
		};

		harness.setResponses([assistantWithPlan, fauxAssistantMessage("done")]);

		await harness.session.prompt("start");

		expect(readCalls).toEqual([{ path: "src/plan-input.ts" }]);
	});

	it("maps kind:bash to the bash tool with the plan operation as the command", async () => {
		const bashCalls: Array<{ command: string }> = [];
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Run a shell command",
			parameters: Type.Object({ command: Type.String() }),
			execute: async (_toolCallId, params) => {
				const command =
					typeof params === "object" && params !== null && "command" in params ? String(params.command) : "";
				bashCalls.push({ command });
				return {
					content: [{ type: "text", text: `bash:${command}` }],
					details: { command, exitStatus: 0 },
				};
			},
		};

		const harness = await createHarness({
			tools: [bashTool],
			settings: { executionPlan: { enabled: true } },
		});
		harnesses.push(harness);

		const plan = createPlan("bash-mapping")
			.step({
				id: "b1",
				kind: "bash",
				operation: "echo hello",
				target: "echo hello",
			})
			.build();

		const assistantWithPlan = fauxAssistantMessage([], { stopReason: "stop" });
		(assistantWithPlan as { executionPlan?: unknown }).executionPlan = {
			plan,
			steps: plan.steps,
		};

		harness.setResponses([assistantWithPlan, fauxAssistantMessage("done")]);

		await harness.session.prompt("start");

		expect(bashCalls).toEqual([{ command: "echo hello" }]);
	});
});

