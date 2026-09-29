import { InMemoryTelemetryContext } from "@theta/telemetry";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, withTelemetryContext } from "../../src/harness/context.ts";
import { createGate } from "../../src/harness/execution/effect-gate.ts";
import {
	applyBeforeToolDecision,
	type ClearedToolCall,
	executeToolCall,
	prepareToolCall,
} from "../../src/harness/execution/tools.ts";
import type { AgentHarnessTool, AgentHarnessToolInvocation } from "../../src/harness/types.ts";
import type { AgentToolCall } from "../../src/types.ts";

const parameters = Type.Object({ value: Type.String() });

function call(arguments_: Record<string, unknown> = { value: "input" }): AgentToolCall {
	return { type: "toolCall", id: "call-1", name: "echo", arguments: arguments_ };
}

function tool(
	overrides: Partial<AgentHarnessTool<undefined, typeof parameters, { value: string }>> = {},
): AgentHarnessTool<undefined, typeof parameters, { value: string }> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo input",
		parameters,
		async execute(_toolCallId, args) {
			return {
				content: [{ type: "text", text: args.value }],
				details: { value: args.value },
			};
		},
		...overrides,
	};
}

function isImmediate(
	value: ReturnType<typeof prepareToolCall> | ReturnType<typeof applyBeforeToolDecision>,
): value is
	| Extract<ReturnType<typeof prepareToolCall>, { kind: "immediate" }>
	| Extract<ReturnType<typeof applyBeforeToolDecision>, { kind: "immediate" }> {
	return "kind" in value;
}

function clearPrepared(callToClear: ReturnType<typeof prepareToolCall>): ClearedToolCall<undefined> {
	if (isImmediate(callToClear)) throw new Error("expected prepared call");
	const cleared = applyBeforeToolDecision(callToClear, undefined);
	if (isImmediate(cleared)) throw new Error("expected cleared call");
	return cleared;
}

const invocation: AgentHarnessToolInvocation = {
	invocationId: "result-1",
	operationId: "operation-1",
	turnId: "turn-1",
	getMemo: async () => undefined,
	setMemo: async () => {},
};

describe("theta.harness.tool span", () => {
	it("records tool name, call id, lane, operation, and is_error=false on success", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const context = withTelemetryContext(telemetry, BACKGROUND_CONTEXT);
		const cleared = clearPrepared(prepareToolCall(call(), [tool()]));
		const { gate } = createGate();

		const result = await executeToolCall(cleared, gate, () => {}, undefined, invocation, context, {
			lane: "main",
			operationId: "operation-1",
			turnId: "turn-1",
			recovery: false,
		});

		expect(result.isError).toBe(false);

		const spans = telemetry.getSpans();
		const toolSpan = spans.find((span) => span.name === "theta.harness.tool");
		expect(toolSpan).toBeDefined();
		if (toolSpan === undefined) return;

		expect(toolSpan.attributes["theta.tool.name"]).toBe("echo");
		expect(toolSpan.attributes["theta.tool.call_id"]).toBe("call-1");
		expect(toolSpan.attributes["theta.lane.name"]).toBe("main");
		expect(toolSpan.attributes["theta.operation.id"]).toBe("operation-1");
		expect(toolSpan.attributes["theta.turn.id"]).toBe("turn-1");
		expect(toolSpan.attributes["theta.tool.recovery"]).toBe(false);
		expect(toolSpan.attributes["theta.tool.replay"]).toBe("never");
		expect(toolSpan.attributes["theta.tool.is_error"]).toBe(false);
	});

	it("records theta.tool.is_error=true and tool.recovery=true when the tool throws under recovery", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const context = withTelemetryContext(telemetry, BACKGROUND_CONTEXT);

		const failingExecute = vi.fn(async () => {
			throw new Error("tool failed");
		});
		const cleared = clearPrepared(prepareToolCall(call(), [tool({ execute: failingExecute })]));
		const { gate } = createGate();

		const result = await executeToolCall(cleared, gate, () => {}, undefined, invocation, context, {
			lane: "main",
			operationId: "operation-1",
			turnId: "turn-1",
			recovery: true,
		});

		expect(result.isError).toBe(true);
		expect(failingExecute).toHaveBeenCalledOnce();

		const spans = telemetry.getSpans();
		const toolSpan = spans.find((span) => span.name === "theta.harness.tool");
		expect(toolSpan).toBeDefined();
		if (toolSpan === undefined) return;

		expect(toolSpan.attributes["theta.tool.is_error"]).toBe(true);
		expect(toolSpan.attributes["theta.tool.recovery"]).toBe(true);
		expect(toolSpan.attributes["theta.tool.call_id"]).toBe("call-1");
	});

	it("omits the span when no telemetry context is supplied", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const cleared = clearPrepared(prepareToolCall(call(), [tool()]));
		const { gate } = createGate();

		const result = await executeToolCall(
			cleared,
			gate,
			() => {},
			undefined,
			invocation,
			withTelemetryContext(telemetry, BACKGROUND_CONTEXT),
		);

		expect(result.isError).toBe(false);
		expect(telemetry.getSpans()).toHaveLength(0);
	});
});

