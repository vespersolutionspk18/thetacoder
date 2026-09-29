/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	type ToolResultMessage,
	validateToolArguments,
} from "@theta/ai";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@theta/telemetry";
import { synthesizeOutcome } from "./outcome.ts";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	PrepareNextTurnContext,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let lastCompletedTurn: PrepareNextTurnContext | undefined;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (lastCompletedTurn) {
				const nextTurnSnapshot = await config.prepareNextTurn?.(lastCompletedTurn);
				if (nextTurnSnapshot) {
					currentContext = nextTurnSnapshot.context ?? currentContext;
					config = {
						...config,
						model: nextTurnSnapshot.model ?? config.model,
						reasoning:
							nextTurnSnapshot.thinkingLevel === undefined
								? config.reasoning
								: nextTurnSnapshot.thinkingLevel === "off"
									? undefined
									: nextTurnSnapshot.thinkingLevel,
					};
				}
				// Preparation can be long-running (for example, compaction). Pick up steering
				// queued while it ran. Only poll again if the earlier poll returned nothing;
				// otherwise one-at-a-time mode would deliver two messages in this turn.
				if (pendingMessages.length === 0) {
					pendingMessages = (await config.getSteeringMessages?.()) || [];
				}
				await emit({ type: "turn_start" });
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			// F6: when the routing flag is on and the assistant message carries an
			// `executionPlan` field, the agent loop dispatches the plan through the
			// configured executor instead of letting the model drive individual tool
			// calls. The plan's tool calls are mapped through the same prepare /
			// execute / finalize pipeline that `executeToolCalls` uses, so a step
			// that maps to the read tool behaves identically to a `read` tool call
			// the model would have produced. A plan envelope is honored whether or
			// not the assistant message also contains natural tool calls; the plan
			// is the source of truth for the steps to dispatch.
			const executionPlan = readExecutionPlanFromMessage(message);
			const usePlanExecutor =
				executionPlan !== null &&
				config.executionPlan?.enabled === true &&
				typeof config.executionPlan.executor === "function";

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (usePlanExecutor) {
				const executedToolBatch = await executeToolCallsViaPlan(
					currentContext,
					message,
					executionPlan,
					config,
					signal,
					emit,
				);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;
				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			} else if (toolCalls.length > 0) {
				// A "length" stop means the output was cut off by the token limit, so
				// every tool call in the message may carry truncated arguments. Fail
				// them all instead of executing potentially borked calls.
				const executedToolBatch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });

			lastCompletedTurn = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};

			if (await config.shouldStopAfterTurn?.(lastCompletedTurn)) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// F2: optionally route through the context compiler. When the flag is
	// off (or the field is omitted) this is a no-op and the messages from
	// `transformContext` flow through unchanged — byte-identical to the
	// pre-F2 behavior. The agent package does not know the F2 module; the
	// higher-level package supplies the `compile` callback that wraps the
	// real `compileContext`. See `ContextCompilerConfig` in types.ts.
	const compiler = config.contextCompiler;
	if (compiler?.enabled && compiler.compile) {
		// Budget derivation: model.contextWindow is the total token budget the
		// model can see in a single turn. We reserve tokens for two purposes
		// that the F2 module does not itself account for:
		//   - `keepRecentTokens` (default 20_000) — reserve for the recent
		//     untrimmed tail and the TaskState messages the compiler will
		//     prepend. This mirrors the `compaction.keepRecentTokens` default
		//     so the projection budget is consistent with auto-compaction.
		//   - `model.maxTokens` — reserve for the model's response.
		// The remaining capacity is what the projected message stream must
		// fit into. If `contextWindow` is unknown (0, e.g. synthetic tests
		// with `DEFAULT_MODEL`), fall back to a generous default so the
		// projection still works in test or early-init paths.
		const keepRecentTokens = compiler.keepRecentTokens ?? 20_000;
		const keepRecentTurns = compiler.keepRecentTurns ?? 20;
		const model = config.model;
		const contextWindow = model.contextWindow;
		const maxTokensReserve = model.maxTokens ?? 0;
		const tokenBudget =
			contextWindow > 0 ? Math.max(0, contextWindow - keepRecentTokens - maxTokensReserve) : 100_000;
		const taskState = compiler.getTaskState ? compiler.getTaskState() : undefined;
		messages = await compiler.compile(messages, taskState, { tokenBudget, keepRecentTurns });
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	// F7 (audit "Telemetry and local models"): open a `theta.ai.request`
	// span on the normal loop path when the caller configured a telemetry
	// context, mirroring the harness's span shape so both inference paths
	// report the same attribute vocabulary. When no telemetry context is
	// set (the default), this is a zero-cost passthrough.
	const telemetryContext: TelemetryContext = config.telemetryContext ?? NOOP_TELEMETRY_CONTEXT;
	const runStream = async (): Promise<AssistantMessage> => {
		const response = await streamFunction(config.model, llmContext, {
			...config,
			apiKey: resolvedApiKey,
			signal,
		});

		let partialMessage: AssistantMessage | null = null;
		let addedPartial = false;

		for await (const event of response) {
			switch (event.type) {
				case "start":
					partialMessage = event.partial;
					context.messages.push(partialMessage);
					addedPartial = true;
					await emit({ type: "message_start", message: { ...partialMessage } });
					break;

				case "text_start":
				case "text_delta":
				case "text_end":
				case "thinking_start":
				case "thinking_delta":
				case "thinking_end":
				case "toolcall_start":
				case "toolcall_delta":
				case "toolcall_end":
					if (partialMessage) {
						partialMessage = event.partial;
						context.messages[context.messages.length - 1] = partialMessage;
						await emit({
							type: "message_update",
							assistantMessageEvent: event,
							message: { ...partialMessage },
						});
					}
					break;

				case "done":
				case "error": {
					const finalMessage = await response.result();
					if (addedPartial) {
						context.messages[context.messages.length - 1] = finalMessage;
					} else {
						context.messages.push(finalMessage);
					}
					if (!addedPartial) {
						await emit({ type: "message_start", message: { ...finalMessage } });
					}
					await emit({ type: "message_end", message: finalMessage });
					return finalMessage;
				}
			}
		}
		// Stream ended without an explicit done/error event.
		const final = await response.result();
		return final;
	};

	if (config.telemetryContext === undefined) {
		return runStream();
	}

	return telemetryContext.startSpan(
		{
			name: "theta.ai.request",
			attributes: {
				"theta.ai.operation": "stream",
				"theta.ai.provider": config.model.provider,
				"theta.ai.model": config.model.id,
				"theta.ai.api": config.model.api,
				"theta.ai.streaming": true,
			},
		},
		async (span) => {
			try {
				const finalMessage = await runStream();
				const usage = finalMessage.usage;
				const stopReason = finalMessage.stopReason === "toolUse" ? "tool_use" : finalMessage.stopReason;
				span.setAttributes({
					"theta.ai.response.model": finalMessage.responseModel ?? finalMessage.model,
					...(finalMessage.responseId === undefined ? {} : { "theta.ai.response.id": finalMessage.responseId }),
					...(stopReason ? { "theta.ai.response.stop_reason": stopReason } : {}),
					"theta.ai.usage.input_tokens": usage.input ?? 0,
					"theta.ai.usage.output_tokens": usage.output ?? 0,
					"theta.ai.usage.cache_read_tokens": usage.cacheRead ?? 0,
					"theta.ai.usage.cache_write_tokens": usage.cacheWrite ?? 0,
					...(usage.reasoning === undefined ? {} : { "theta.ai.usage.reasoning_tokens": usage.reasoning }),
					...(usage.totalTokens === undefined ? {} : { "theta.ai.usage.total_tokens": usage.totalTokens }),
					...(usage.cost.total === undefined ? {} : { "theta.ai.usage.cost": usage.cost.total }),
				});
				if (finalMessage.stopReason === "error") {
					span.setStatus({
						status: "error",
						error: { name: "provider_error", message: finalMessage.errorMessage ?? "provider error" },
					});
				}
				return finalMessage;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				span.setStatus({ status: "error", error: { name: "request_error", message } });
				throw error;
			}
		},
	);
}

/**
 * Fail all tool calls from an assistant message that was truncated by the
 * output token limit. Streamed tool-call arguments are finalized with a
 * best-effort JSON salvage parser, so a truncated message can yield tool calls
 * whose arguments parse and validate but are silently incomplete. None of them
 * are safe to execute; report each as an error so the model can re-issue them.
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			if (signal?.aborted) {
				const finalized = {
					toolCall,
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				} satisfies FinalizedToolCallOutcome;
				await emitToolExecutionEnd(finalized, emit);
				return finalized;
			}
			const executed = await executePreparedToolCall(preparation, signal, emit);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
				if (beforeResult.terminate === true) {
					result.terminate = true;
				}
				return {
					kind: "immediate",
					result,
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	} finally {
		acceptingUpdates = false;
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	// Layer-2 floor: synthesize a structured outcome for every tool result
	// before extensions get a chance to override. Tools that return
	// `details: undefined` (e.g. write) need the guard below before attaching.
	result.details = result.details ?? {};
	result.details.outcome = synthesizeOutcome(prepared.toolCall.name, result, isError);

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		usage: finalized.result.usage,
		...(finalized.result.addedToolNames?.length ? { addedToolNames: finalized.result.addedToolNames } : {}),
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}

// ============================================================================
// F6 ExecutionPlan dispatch
// ============================================================================

/**
 * The agent package treats the F6 `ExecutionPlan` as an opaque value
 * stored on the assistant message. The shape is owned by the F6 module
 * in the higher-level package; the agent loop only needs to forward the
 * value to the configured `executor` and recover the resulting
 * step-by-step tool calls so the conversation history stays consistent.
 */
interface ExecutionPlanEnvelope {
	plan: unknown;
	/**
	 * Optional explicit step -> tool-call list, in declaration order. When
	 * present, the agent loop uses this to map step results back to
	 * tool-result messages; when absent, the agent loop derives a synthetic
	 * tool call from each step's `kind` and `target`.
	 */
	steps?: unknown[];
}

/**
 * Read the optional `executionPlan` envelope off an assistant message.
 * The agent package does not own the F6 `ExecutionPlan` type, so this
 * is a structural duck-type read. Returns `null` when the field is
 * missing or does not look like a valid envelope.
 */
function readExecutionPlanFromMessage(message: AssistantMessage): ExecutionPlanEnvelope | null {
	const candidate = (message as { executionPlan?: unknown }).executionPlan;
	if (!candidate || typeof candidate !== "object") return null;
	const record = candidate as { plan?: unknown; steps?: unknown };
	if (record.plan === undefined || record.plan === null) return null;
	const steps = Array.isArray(record.steps) ? record.steps : undefined;
	return { plan: record.plan, steps };
}

/**
 * Run a plan-bearing assistant message through the configured F6
 * executor. The agent loop:
 *
 *  1. Builds a `StepRunner` that wraps the existing prepare / execute /
 *     finalize pipeline so plan steps share the same `beforeToolCall` /
 *     `afterToolCall` plumbing that natural tool calls do.
 *  2. Calls the consumer-supplied `executor` with the plan, the runner,
 *     and the configured `concurrency`.
 *  3. For each step result, emits a `tool_execution_*` event pair and
 *     appends a `ToolResultMessage` to the conversation history so the
 *     model sees the outcome on the next turn.
 *
 * The executor returns an unknown value; the agent loop expects it to
 * have `stepResults: Array<{ stepId, status, output, error? }>` and
 * `status: ExecutionResultStatus`. Both are read structurally so the
 * agent package does not need to import the F6 types.
 */
async function executeToolCallsViaPlan(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	envelope: ExecutionPlanEnvelope,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	// The agent-loop's `emit` is a stream forwarder and does not
	// persist tool result messages to `currentContext.messages`. To
	// recover the real per-step tool result messages after the
	// executor returns, the runner records the message it built
	// (with the actual tool result content and the toolCallId the
	// runner used) into this side-channel map, indexed by `stepId`.
	// We pair it with the executor's `stepResults` below so the
	// returned `messages` array reflects the real per-step
	// outcomes, not a synthesized placeholder.
	const messagesByStepId = new Map<string, ToolResultMessage>();
	const planRunner = buildExecutionPlanStepRunner(
		currentContext,
		assistantMessage,
		config,
		signal,
		emit,
		messagesByStepId,
	);
	const concurrency = config.executionPlan?.concurrency ?? 1;
	const executor = config.executionPlan!.executor!;
	const result = (await executor(envelope.plan, planRunner, {
		concurrency,
		signal,
	})) as {
		status?: string;
		stepResults?: Array<{
			stepId: string;
			status?: string;
			output?: unknown;
			error?: Error;
		}>;
	};

	// The F6 executor reorders `stepResults` to topological order
	// before returning, so pairing by index between
	// `messagesByStepId` (which records messages in completion
	// order) and the returned `stepResults` is not safe when
	// `concurrency > 1`. Pair by `stepId` instead. The synthesized
	// `finalized` outcome is still used for the
	// `shouldTerminateToolBatch` check, because the
	// `ToolResultMessage` shape does not carry the `terminate`
	// hint that early-termination relies on.
	const stepResults = Array.isArray(result?.stepResults) ? result.stepResults : [];
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];
	for (const stepResult of stepResults) {
		const finalized: FinalizedToolCallOutcome = planFinalizedForStep(envelope, stepResult);
		finalizedCalls.push(finalized);
		const captured = messagesByStepId.get(stepResult.stepId);
		messages.push(captured ?? createToolResultMessage(finalized));
	}
	return { messages, terminate: shouldTerminateToolBatch(finalizedCalls) };
}

/**
 * Build a `StepRunner` that the F6 executor invokes for each plan step.
 * The runner maps the step's `kind` and `target` to a concrete tool call,
 * then runs the existing `prepareToolCall` + `executePreparedToolCall` +
 * `finalizeExecutedToolCall` flow so plan steps share the exact same
 * before/after hooks and outcome synthesis as natural tool calls.
 */
/**
 * Build a `StepRunner` (typed as `unknown` here so the agent package does
 * not import the F6 module) that the F6 executor invokes for each plan
 * step. The runner maps the step's `kind` and `target` to a concrete tool
 * call, then runs the existing `prepareToolCall` +
 * `executePreparedToolCall` + `finalizeExecutedToolCall` flow so plan
 * steps share the exact same `beforeToolCall` / `afterToolCall` plumbing
 * and outcome synthesis as natural tool calls.
 *
 * Exported so higher-level packages (e.g. the coding-agent
 * `AgentSession.executePlan(plan)` API) can build a runner that runs plan
 * steps through the same agent-side tool execution path that
 * `executeToolCalls` uses.
 */
export function createExecutionPlanRunner(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	messagesByStepId?: Map<string, ToolResultMessage>,
): (
	step: unknown,
	stepSignal: AbortSignal | undefined,
) => Promise<{
	stepId: string;
	status: "succeeded" | "failed" | "cancelled" | "incomplete" | "unknown";
	output?: unknown;
	error?: Error;
	startedAt: number;
	endedAt: number;
	wallTimeMs: number;
}> {
	return buildExecutionPlanStepRunner(currentContext, assistantMessage, config, signal, emit, messagesByStepId);
}

function buildExecutionPlanStepRunner(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	_signal: AbortSignal | undefined,
	emit: AgentEventSink,
	messagesByStepId?: Map<string, ToolResultMessage>,
): (
	step: unknown,
	stepSignal: AbortSignal | undefined,
) => Promise<{
	stepId: string;
	status: "succeeded" | "failed" | "cancelled" | "incomplete" | "unknown";
	output?: unknown;
	error?: Error;
	startedAt: number;
	endedAt: number;
	wallTimeMs: number;
}> {
	return async (step, stepSignal) => {
		const startedAt = Date.now();
		const stepRecord = (step ?? {}) as {
			id?: unknown;
			kind?: unknown;
			target?: unknown;
			operation?: unknown;
		};
		const stepId = typeof stepRecord.id === "string" ? stepRecord.id : "step";
		const kind = typeof stepRecord.kind === "string" ? stepRecord.kind : "";
		const target = typeof stepRecord.target === "string" ? stepRecord.target : "";

		const toolName = planStepKindToToolName(kind);
		const toolCallId = `plan-${stepId}-${randomToolCallId()}`;
		const toolCall: AgentToolCall = {
			type: "toolCall",
			id: toolCallId,
			name: toolName,
			arguments: planStepToToolArguments(kind, target, stepRecord),
		};
		await emit({
			type: "tool_execution_start",
			toolCallId,
			toolName,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, stepSignal);
		if (preparation.kind === "immediate") {
			const endedAt = Date.now();
			const immediateFinalized: FinalizedToolCallOutcome = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
			await emitToolExecutionEnd(immediateFinalized, emit);
			const immediateMessage = createToolResultMessage(immediateFinalized);
			messagesByStepId?.set(stepId, immediateMessage);
			await emit({ type: "message_start", message: immediateMessage });
			await emit({ type: "message_end", message: immediateMessage });
			return {
				stepId,
				status: preparation.isError ? "failed" : "unknown",
				output: preparation.result.details,
				error: preparation.isError ? new Error(extractErrorMessage(preparation.result)) : undefined,
				startedAt,
				endedAt,
				wallTimeMs: Math.max(0, endedAt - startedAt),
			};
		}

		const executed = await executePreparedToolCall(preparation, stepSignal, emit);
		const finalized = await finalizeExecutedToolCall(
			currentContext,
			assistantMessage,
			preparation,
			executed,
			config,
			stepSignal,
		);
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		messagesByStepId?.set(stepId, toolResultMessage);
		await emit({ type: "message_start", message: toolResultMessage });
		await emit({ type: "message_end", message: toolResultMessage });

		const endedAt = Date.now();
		const isError = finalized.isError === true;
		return {
			stepId,
			status: isError ? "failed" : "succeeded",
			output: finalized.result.details,
			error: isError ? new Error(extractErrorMessage(finalized.result)) : undefined,
			startedAt,
			endedAt,
			wallTimeMs: Math.max(0, endedAt - startedAt),
		};
	};
}

function planStepKindToToolName(kind: string): string {
	switch (kind) {
		case "read":
			return "read";
		case "edit":
		case "write":
			return kind;
		case "bash":
			return "bash";
		case "grep":
			return "grep";
		case "find":
			return "find";
		default:
			return "bash";
	}
}

function planStepToToolArguments(
	kind: string,
	target: string,
	step: { operation?: unknown } | undefined,
): Record<string, unknown> {
	switch (kind) {
		case "read":
		case "edit":
		case "write":
		case "grep":
		case "find":
			return { path: target };
		case "bash":
			return { command: typeof step?.operation === "string" ? step.operation : target };
		default:
			return { command: target };
	}
}

function planFinalizedForStep(
	envelope: ExecutionPlanEnvelope,
	stepResult: {
		stepId: string;
		status?: string;
		output?: unknown;
		error?: Error;
	},
): FinalizedToolCallOutcome {
	const step = (envelope.steps ?? []).find(
		(candidate) =>
			candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === stepResult.stepId,
	) as { id?: unknown; kind?: unknown; target?: unknown; operation?: unknown } | undefined;
	const kind = typeof step?.kind === "string" ? step.kind : "";
	const target = typeof step?.target === "string" ? step.target : "";
	const toolName = planStepKindToToolName(kind);
	const toolCallId = `plan-${stepResult.stepId}-${randomToolCallId()}`;
	const toolCall: AgentToolCall = {
		type: "toolCall",
		id: toolCallId,
		name: toolName,
		arguments: planStepToToolArguments(kind, target, step),
	};
	const status = typeof stepResult.status === "string" ? stepResult.status : "unknown";
	const isError = status === "failed" || status === "incomplete" || stepResult.error !== undefined;
	const message = stepResult.error?.message ?? `Plan step ${stepResult.stepId} ${status}`;
	const result: AgentToolResult<any> = {
		content: [{ type: "text", text: message }],
		details: {
			...(isError ? {} : { value: stepResult.output }),
			...(isError ? {} : { stepId: stepResult.stepId, status }),
			...(isError ? { error: message } : {}),
		},
	};
	return { toolCall, result, isError };
}

function extractErrorMessage(result: AgentToolResult<unknown>): string {
	const first = Array.isArray(result.content) ? result.content[0] : undefined;
	if (first && first.type === "text") return first.text;
	return "Plan step failed";
}

function randomToolCallId(): string {
	return Math.random().toString(36).slice(2, 10);
}

