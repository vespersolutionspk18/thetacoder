/**
 * F7 — `theta.ai.request` telemetry span on the normal agent loop.
 *
 * The audit calls for all inference paths to report request lineage
 * ("Requests: logical inferences, transport attempts, retries,
 * purpose"). The harness path already opens a `theta.ai.request` span;
 * this test pins the normal-loop equivalent: when the loop config
 * carries a `telemetryContext`, each assistant request must produce
 * one span with the provider/model attributes and usage end
 * attributes. Without a telemetry context, the loop must behave
 * exactly as before (no spans, no errors).
 */
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	fauxAssistantMessage,
	type Model,
	type UserMessage,
} from "@theta/ai";
import { InMemoryTelemetryContext } from "@theta/telemetry";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

function identityConverter(messages: AgentMessage[]): import("@theta/ai").Message[] {
	return messages.filter(
		(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
	) as import("@theta/ai").Message[];
}

function mockStreamFn() {
	return () => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: "stop",
				message: createAssistantMessage([{ type: "text", text: "ok" }]),
			});
		});
		return stream;
	};
}

describe("agentLoop — theta.ai.request telemetry span (F7)", () => {
	it("opens one span per assistant request when a telemetryContext is configured", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			telemetryContext: telemetry,
		};

		const stream = agentLoop([createUserMessage("Hello")], context, config, undefined, mockStreamFn());
		await stream.result();

		const spans = telemetry.getSpans();
		expect(spans.length).toBe(1);
		const span = spans[0];
		expect(span.name).toBe("theta.ai.request");
		expect(span.attributes["theta.ai.provider"]).toBe("openai");
		expect(span.attributes["theta.ai.model"]).toBe("mock");
		expect(span.attributes["theta.ai.operation"]).toBe("stream");
		expect(span.attributes["theta.ai.usage.input_tokens"]).toBe(100);
		expect(span.attributes["theta.ai.usage.output_tokens"]).toBe(20);
		expect(span.attributes["theta.ai.response.stop_reason"]).toBe("stop");
	});

	it("records an error status when the assistant message settles with an error", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			telemetryContext: telemetry,
		};

		const errorStreamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "error",
					reason: "error",
					error: fauxAssistantMessage([], {
						stopReason: "error",
						errorMessage: "provider exploded",
					}),
				});
			});
			return stream;
		};

		const stream = agentLoop([createUserMessage("Hello")], context, config, undefined, errorStreamFn);
		await stream.result();

		const spans = telemetry.getSpans();
		expect(spans.length).toBe(1);
		expect(spans[0].status).toEqual({
			status: "error",
			error: { name: "provider_error", message: "provider exploded" },
		});
	});

	it("produces no spans when no telemetryContext is configured", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const stream = agentLoop([createUserMessage("Hello")], context, config, undefined, mockStreamFn());
		const messages = await stream.result();
		expect(messages.length).toBeGreaterThan(0);
	});
});

