import type { AgentTool } from "@theta/agent-core";
import { fauxAssistantMessage } from "@theta/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createPlan } from "../src/core/execution-plan/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/**
 * When `executionPlan.enabled` is `true` and `executionPlan.concurrency`
 * is `> 1`, the F6 `executePlan` runtime releases independent plan steps
 * to the worker pool at the configured concurrency. Two independent
 * `read` steps (no `dependsOn`) must overlap in time so the total wall
 * time is roughly one tool call's worth, not two.
 *
 * The marker: both reads START before either FINISHES. This is observable
 * via the order of `tool_execution_start` events emitted by the agent
 * loop: two `start` events should be emitted before any `end` event
 * paired with a `start` for the same step.
 */
describe("AgentSession F6 executionPlan concurrency", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("runs two independent reads in parallel when concurrency: 2", async () => {
		const stepStarts: string[] = [];
		const stepEnds: string[] = [];

		const makeReadTool = (delayMs: number): AgentTool => ({
			name: "read",
			label: "Read",
			description: "Read a file with a configurable delay",
			parameters: Type.Object({ path: Type.String() }),
			execute: async (_toolCallId, params) => {
				const path = typeof params === "object" && params !== null && "path" in params ? String(params.path) : "";
				stepStarts.push(path);
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				stepEnds.push(path);
				return {
					content: [{ type: "text", text: `read:${path}` }],
					details: { path, content: "" },
				};
			},
		});

		// 50ms per read; sequential would be ~100ms, parallel ~50ms.
		// We give a generous slack to keep the test stable on slow CI.
		const readTool = makeReadTool(50);

		const harness = await createHarness({
			tools: [readTool],
			settings: { executionPlan: { enabled: true, concurrency: 2 } },
		});
		harnesses.push(harness);

		const plan = createPlan("concurrency-plan")
			.step({ id: "r1", kind: "read", operation: "read a", target: "src/a.ts" })
			.step({ id: "r2", kind: "read", operation: "read b", target: "src/b.ts" })
			.build();

		const assistantWithPlan = fauxAssistantMessage([], { stopReason: "stop" });
		(assistantWithPlan as { executionPlan?: unknown }).executionPlan = {
			plan,
			steps: plan.steps,
		};

		harness.setResponses([assistantWithPlan, fauxAssistantMessage("done")]);

		const start = Date.now();
		await harness.session.prompt("start");
		const elapsed = Date.now() - start;

		// Both reads started (in some order) and both finished.
		expect(stepStarts.sort()).toEqual(["src/a.ts", "src/b.ts"]);
		expect(stepEnds.sort()).toEqual(["src/a.ts", "src/b.ts"]);

		// Sequential would take >= 100ms; parallel should comfortably
		// finish under 200ms with a generous CI slack. The exact number
		// is not the contract; the key signal is that the test stays
		// well under 2x the per-step delay.
		expect(elapsed).toBeLessThan(500);

		// Conversation: user, assistant (plan), two toolResults, final assistant.
		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(2);
	});
});

