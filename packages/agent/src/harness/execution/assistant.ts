import type {
	Context as AiContext,
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Message,
	Model,
	SimpleStreamOptions,
	Tool,
} from "@theta/ai";
import type { AgentMessage, ThinkingLevel } from "../../types.ts";
import { type Context, getTelemetryContext } from "../context.ts";
import type { SettledAssistantMessage } from "../session/types.ts";
import { startAiSpan } from "../telemetry.ts";
import type { AgentHarnessStreamOptions } from "../types.ts";
import { AbortRequested } from "./effect-gate.ts";

/** HTTP response metadata captured before the provider response body is consumed. */
export interface AssistantResponseMetadata {
	status?: number;
	headers?: Record<string, string>;
}

/** Inputs required to wrap a stream consumer call in a `theta.ai.request` span. */
export interface AssistantStreamSpanContext {
	/** Selected model the request is dispatched against. */
	model: Model<Api>;
	/** Whether the request participates in deferred execution. */
	deferred: boolean;
	/** Provider HTTP response metadata captured before the body is consumed. */
	metadata: AssistantResponseMetadata;
}

/** Low-cardinality classifier for provider error messages surfaced on `theta.ai.error.type`. */
function classifyProviderError(
	status: number | undefined,
	errorMessage: string | undefined,
	stopReason: SettledAssistantMessage["stopReason"] | undefined,
): string | undefined {
	if (stopReason === "aborted") return "aborted";
	if (status === 429) return "rate_limit";
	if (status === 401 || status === 403) return "auth";
	if (status !== undefined && status >= 500) return "server";
	if (errorMessage === undefined) return undefined;
	if (/context.{0,30}(exceed|limit|maximum|overflow|long)/i.test(errorMessage)) return "context_overflow";
	if (/rate[-_ ]?limit|429/i.test(errorMessage)) return "rate_limit";
	if (/auth|unauthorized|forbidden|invalid.{0,10}(token|api[-_ ]?key)/i.test(errorMessage)) return "auth";
	if (/timeout|timed[-_ ]?out/i.test(errorMessage)) return "timeout";
	if (/network|connect|ECONN|ENOTFOUND|EHOST|fetch failed/i.test(errorMessage)) return "network";
	if (/server|500|502|503|504/i.test(errorMessage)) return "server";
	return "other";
}

/** Process-local lifecycle observer for one assistant stream. */
export interface AssistantStreamObserver {
	start(
		message: AssistantMessage,
		event: Extract<AssistantMessageEvent, { type: "start" }>,
		context: Context,
	): void | Promise<void>;
	update(message: AssistantMessage, event: AssistantMessageEvent, context: Context): void | Promise<void>;
	end(message: SettledAssistantMessage, context: Context): void | Promise<void>;
}

/** Executable inputs for one already-approved assistant provider request. */
export interface HarnessAssistantStreamConfig {
	model: Model<Api>;
	systemPrompt: string;
	tools?: Tool[];
	thinkingLevel: ThinkingLevel;
	streamOptions: AgentHarnessStreamOptions;
	transformContext?: (
		requestContext: { messages: AgentMessage[]; systemPrompt: string },
		context: Context,
	) => Promise<{ messages: AgentMessage[]; systemPrompt: string }>;
	toProviderMessages: (messages: AgentMessage[], context: Context) => Message[] | Promise<Message[]>;
	beforePayload?: (
		payload: unknown,
		model: Model<Api>,
		context: Context,
	) => unknown | undefined | Promise<unknown | undefined>;
	afterResponse?: (
		message: SettledAssistantMessage,
		metadata: AssistantResponseMetadata,
		context: Context,
	) => Promise<SettledAssistantMessage>;
	request(
		aiContext: AiContext,
		options: SimpleStreamOptions,
		context: Context,
	): AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
	observer: AssistantStreamObserver;
}

function createRequestOptions(
	config: HarnessAssistantStreamConfig,
	captureMetadata: (metadata: AssistantResponseMetadata) => void,
	context: Context,
): SimpleStreamOptions {
	const options = config.streamOptions;
	return {
		transport: options.transport,
		timeoutMs: options.timeoutMs,
		maxRetries: options.maxRetries,
		maxRetryDelayMs: options.maxRetryDelayMs,
		headers: options.headers,
		metadata: options.metadata,
		cacheRetention: options.cacheRetention,
		deferred: options.deferred,
		...(config.thinkingLevel === "off" ? {} : { reasoning: config.thinkingLevel }),
		signal: context.abortSignal,
		telemetryContext: getTelemetryContext(context),
		onPayload:
			config.beforePayload === undefined
				? undefined
				: (payload, model) => config.beforePayload?.(payload, model, context),
		onResponse: (response) => {
			captureMetadata({ status: response.status, headers: response.headers });
		},
	};
}

function isUpdateEvent(
	event: AssistantMessageEvent,
): event is Exclude<AssistantMessageEvent, { type: "start" | "done" | "error" }> {
	return event.type !== "start" && event.type !== "done" && event.type !== "error";
}

export async function consumeAssistantStream(
	stream: AssistantMessageEventStream,
	observer: AssistantStreamObserver,
	afterResponse:
		| ((message: SettledAssistantMessage, context: Context) => Promise<SettledAssistantMessage>)
		| undefined,
	context: Context,
	span: AssistantStreamSpanContext,
): Promise<SettledAssistantMessage> {
	return startAiSpan(
		"theta.ai.request",
		{
			"theta.ai.operation": "stream",
			"theta.ai.provider": span.model.provider,
			"theta.ai.model": span.model.id,
			"theta.ai.api": span.model.api,
			"theta.ai.streaming": true,
			...(span.deferred ? { "theta.ai.deferred": true } : {}),
		},
		async (aiSpan, spanContext) => {
			let started = false;
			let chunkCount = 0;
			let firstChunkTime: number | undefined;
			const requestStart = Date.now();
			for await (const event of stream) {
				if (event.type === "start") {
					if (started) throw new Error("Assistant message stream emitted more than one start event");
					started = true;
					await observer.start({ ...event.partial }, event, spanContext);
				} else if (isUpdateEvent(event)) {
					if (!started) throw new Error(`Assistant message stream emitted ${event.type} before start`);
					if (firstChunkTime === undefined) firstChunkTime = Date.now() - requestStart;
					chunkCount++;
					await observer.update({ ...event.partial }, event, spanContext);
				} else if (event.type === "done" && !started) {
					throw new Error("Assistant message stream emitted done before start");
				}
			}

			const settled = (await stream.result()) as SettledAssistantMessage;
			let finalMessage = settled;
			if (afterResponse !== undefined) {
				try {
					finalMessage = await afterResponse(settled, spanContext);
				} catch (error) {
					if (!(error instanceof AbortRequested)) throw error;
					await error.cancellation;
				}
			}
			await observer.end(finalMessage, spanContext);

			const stopReason = finalMessage.stopReason === "toolUse" ? "tool_use" : finalMessage.stopReason;
			const errorType = classifyProviderError(
				span.metadata.status,
				finalMessage.errorMessage,
				finalMessage.stopReason,
			);
			const usage = finalMessage.usage;
			aiSpan.setAttributes({
				"theta.ai.response.model": finalMessage.responseModel ?? finalMessage.model,
				...(finalMessage.responseId === undefined ? {} : { "theta.ai.response.id": finalMessage.responseId }),
				...(stopReason ? { "theta.ai.response.stop_reason": stopReason } : {}),
				...(span.metadata.status === undefined ? {} : { "theta.ai.http.status_code": span.metadata.status }),
				"theta.ai.usage.input_tokens": usage.input ?? 0,
				"theta.ai.usage.output_tokens": usage.output ?? 0,
				"theta.ai.usage.cache_read_tokens": usage.cacheRead ?? 0,
				"theta.ai.usage.cache_write_tokens": usage.cacheWrite ?? 0,
				...(usage.reasoning === undefined ? {} : { "theta.ai.usage.reasoning_tokens": usage.reasoning }),
				...(usage.totalTokens === undefined ? {} : { "theta.ai.usage.total_tokens": usage.totalTokens }),
				...(usage.cost.total === undefined ? {} : { "theta.ai.usage.cost": usage.cost.total }),
				...(chunkCount > 0 ? { "theta.ai.stream.chunk_count": chunkCount } : {}),
				...(firstChunkTime === undefined ? {} : { "theta.ai.stream.time_to_first_chunk_ms": firstChunkTime }),
				...(errorType === undefined ? {} : { "theta.ai.error.type": errorType }),
			});
			return finalMessage;
		},
		context,
	);
}

/** Stream one assistant response without mutating the caller's message list. */
export async function streamHarnessAssistant(
	messages: AgentMessage[],
	config: HarnessAssistantStreamConfig,
	context: Context,
): Promise<SettledAssistantMessage> {
	let requestContext = { messages: messages.slice(), systemPrompt: config.systemPrompt };
	if (config.transformContext) {
		requestContext = await config.transformContext(requestContext, context);
	}

	const providerMessages = await config.toProviderMessages(requestContext.messages, context);
	const aiContext: AiContext = {
		systemPrompt: requestContext.systemPrompt,
		messages: providerMessages,
		tools: config.tools,
	};

	let metadata: AssistantResponseMetadata = {};
	const stream = await config.request(
		aiContext,
		createRequestOptions(
			config,
			(nextMetadata) => {
				metadata = nextMetadata;
			},
			context,
		),
		context,
	);

	const afterResponse = config.afterResponse;
	return consumeAssistantStream(
		stream,
		config.observer,
		afterResponse === undefined
			? undefined
			: (message, afterContext) => afterResponse(message, metadata, afterContext),
		context,
		{ model: config.model, deferred: config.streamOptions.deferred !== undefined, metadata },
	);
}

