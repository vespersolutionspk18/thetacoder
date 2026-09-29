import {
	type Api,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxProvider,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type UserMessage,
} from "@theta/ai";
import { InMemoryTelemetryContext } from "@theta/telemetry";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, withTelemetryContext } from "../../src/harness/context.ts";
import { streamHarnessAssistant } from "../../src/harness/execution/assistant.ts";
import type { AgentMessage } from "../../src/types.ts";

function usage() {
	return {
		input: 7,
		output: 11,
		cacheRead: 3,
		cacheWrite: 5,
		reasoning: 2,
		totalTokens: 26,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.25 },
	};
}

function model(): Model<Api> {
	return {
		id: "model",
		name: "Model",
		api: "test",
		provider: "provider",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function toProviderMessages(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message): message is Message =>
			message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

describe("theta.ai.request span", () => {
	it("records usage, response id, stop reason, and chunk count after a faux stream", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const context = withTelemetryContext(telemetry, BACKGROUND_CONTEXT);

		const faux = fauxProvider({ tokenSize: { min: 1, max: 1 } });
		const fauxModel = faux.getModel();
		faux.setResponses([fauxAssistantMessage("hello", { responseId: "resp-1", stopReason: "stop" })]);

		const seenOptions: SimpleStreamOptions[] = [];
		await streamHarnessAssistant(
			[user("prompt")],
			{
				model: fauxModel,
				systemPrompt: "system",
				thinkingLevel: "off",
				streamOptions: {},
				toProviderMessages,
				request: (requestContext, options) => {
					seenOptions.push(options);
					return faux.provider.streamSimple(fauxModel, requestContext, options);
				},
				observer: {
					start() {},
					update() {},
					end() {},
				},
			},
			context,
		);

		const spans = telemetry.getSpans();
		const aiSpans = spans.filter((span) => span.name === "theta.ai.request");
		expect(aiSpans.length).toBeGreaterThanOrEqual(1);

		const aiSpan = aiSpans[0];
		expect(aiSpan.attributes["theta.ai.operation"]).toBe("stream");
		expect(aiSpan.attributes["theta.ai.provider"]).toBe(fauxModel.provider);
		expect(aiSpan.attributes["theta.ai.model"]).toBe(fauxModel.id);
		expect(aiSpan.attributes["theta.ai.api"]).toBe(fauxModel.api);
		expect(aiSpan.attributes["theta.ai.streaming"]).toBe(true);

		expect(aiSpan.attributes["theta.ai.response.id"]).toBe("resp-1");
		expect(aiSpan.attributes["theta.ai.response.stop_reason"]).toBe("stop");
		expect(typeof aiSpan.attributes["theta.ai.usage.input_tokens"]).toBe("number");
		expect(typeof aiSpan.attributes["theta.ai.usage.output_tokens"]).toBe("number");
		expect(typeof aiSpan.attributes["theta.ai.usage.cache_read_tokens"]).toBe("number");
		expect(typeof aiSpan.attributes["theta.ai.usage.cache_write_tokens"]).toBe("number");
		expect(typeof aiSpan.attributes["theta.ai.usage.total_tokens"]).toBe("number");
		expect(typeof aiSpan.attributes["theta.ai.usage.cost"]).toBe("number");
		expect(typeof aiSpan.attributes["theta.ai.stream.chunk_count"]).toBe("number");
		expect(seenOptions.length).toBeGreaterThanOrEqual(1);
	});

	it("captures HTTP status, error type, and deferred flag", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const context = withTelemetryContext(telemetry, BACKGROUND_CONTEXT);

		const final = {
			role: "assistant" as const,
			content: [],
			api: "test" as const,
			provider: "provider",
			model: "model",
			usage: usage(),
			stopReason: "error" as const,
			errorMessage: "rate limit exceeded",
			timestamp: 2,
		};

		await streamHarnessAssistant(
			[user("prompt")],
			{
				model: model(),
				systemPrompt: "system",
				thinkingLevel: "off",
				streamOptions: { deferred: { window: "1h" } },
				toProviderMessages,
				request: async (_requestContext, options) => {
					await options.onResponse?.({ status: 429, headers: {} }, model());
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => stream.push({ type: "error", reason: "error", error: final }));
					return stream;
				},
				observer: {
					start() {},
					update() {},
					end() {},
				},
			},
			context,
		);

		const spans = telemetry.getSpans();
		const aiSpan = spans.find((span) => span.name === "theta.ai.request");
		expect(aiSpan).toBeDefined();
		if (aiSpan === undefined) return;

		expect(aiSpan.attributes["theta.ai.http.status_code"]).toBe(429);
		expect(aiSpan.attributes["theta.ai.response.stop_reason"]).toBe("error");
		expect(aiSpan.attributes["theta.ai.error.type"]).toBe("rate_limit");
		expect(aiSpan.attributes["theta.ai.deferred"]).toBe(true);
	});
});

