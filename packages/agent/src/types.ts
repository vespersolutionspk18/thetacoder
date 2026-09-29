import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
	Usage,
} from "@theta/ai";
import type { Static, TSchema } from "typebox";

/**
 * Stream function used by the agent loop. `Models.streamSimple` satisfies
 * this shape.
 *
 * Contract:
 * - Must not throw or return a rejected promise for request/model/runtime failures.
 * - Must return an AssistantMessageEventStream.
 * - Failures must be encoded in the returned stream via protocol events and a
 *   final AssistantMessage with stopReason "error" or "aborted" and errorMessage.
 */
export type StreamFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * Configuration for how tool calls from a single assistant message are executed.
 *
 * - "sequential": each tool call is prepared, executed, and finalized before the next one starts.
 * - "parallel": tool calls are prepared sequentially, then allowed tools execute concurrently.
 *   `tool_execution_end` is emitted in tool completion order after each tool is finalized,
 *   while tool-result message artifacts are emitted later in assistant source order.
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * Controls how many queued user messages are injected when the agent loop reaches a queue drain point.
 *
 * - "all": drain and inject every queued message at that point.
 * - "one-at-a-time": drain and inject only the oldest queued message, leaving the rest queued for later drain points.
 */
export type QueueMode = "all" | "one-at-a-time";

/** A single tool call content block emitted by an assistant message. */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * Result returned from `beforeToolCall`.
 *
 * Returning `{ block: true }` prevents the tool from executing. The loop emits an error tool result instead.
 * `reason` becomes the text shown in that error result. If omitted, a default blocked message is used.
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
	/**
	 * Hint that the agent should stop after the current tool batch when this call is blocked.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

/**
 * Partial override returned from `afterToolCall`.
 *
 * Merge semantics are field-by-field:
 * - `content`: if provided, replaces the tool result content array in full
 * - `details`: if provided, replaces the tool result details value in full
 * - `isError`: if provided, replaces the tool result error flag
 * - `usage`: if provided, replaces the tool result usage
 * - `terminate`: if provided, replaces the early-termination hint
 *
 * Omitted fields keep the original executed tool result values.
 * There is no deep merge for `content`, `details`, or `usage`.
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	/** Usage from the final tool execution itself, if available. Not used for main LLM context accounting. */
	usage?: Usage;
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

/** Context passed to `beforeToolCall`. */
export interface BeforeToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	args: unknown;
	/** Current agent context at the time the tool call is prepared. */
	context: AgentContext;
}

/** Context passed to `afterToolCall`. */
export interface AfterToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	args: unknown;
	/** The executed tool result before any `afterToolCall` overrides are applied. */
	result: AgentToolResult<any>;
	/** Whether the executed tool result is currently treated as an error. */
	isError: boolean;
	/** Current agent context at the time the tool call is finalized. */
	context: AgentContext;
}

/** Context passed to `shouldStopAfterTurn`. */
export interface ShouldStopAfterTurnContext {
	/** The assistant message that completed the turn. */
	message: AssistantMessage;
	/** Tool result messages passed to the preceding `turn_end` event. */
	toolResults: ToolResultMessage[];
	/** Current agent context after the turn's assistant message and tool results have been appended. */
	context: AgentContext;
	/** Messages that this loop invocation will return if it exits at this point. Prompt runs include the initial prompt messages; continuation runs do not include pre-existing context messages. */
	newMessages: AgentMessage[];
}

/** Replacement runtime state used by the agent loop before starting another provider request. */
export interface AgentLoopTurnUpdate {
	/** Context for the next provider request. */
	context?: AgentContext;
	/** Model for the next provider request. */
	model?: Model<any>;
	/** Thinking level for the next provider request. */
	thinkingLevel?: ThinkingLevel;
}

export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

/**
 * Configuration for the F2 context-compiler routing step inside the agent loop.
 *
 * When `enabled` is true, the agent loop runs the output of `transformContext`
 * through the provided `compile` callback before handing it off to
 * `convertToLlm`. When `enabled` is false (the default) the agent loop is a
 * pure passthrough over `transformContext`, preserving the existing
 * chronological-replay behavior byte-for-byte.
 *
 * The agent package treats `taskState` as an opaque `unknown` so the agent
 * package does not need to import any TaskState definition from downstream
 * packages. The higher-level package that supplies the F2 module is
 * responsible for typing the value it returns from `getTaskState` and for
 * casting it back to its own TaskState type inside the `compile` callback.
 */
export interface ContextCompilerConfig {
	/** When true, the agent loop routes `transformContext` output through `compile`. */
	enabled: boolean;
	/**
	 * Resolve the latest TaskState for the current session. Called once per
	 * assistant turn. The agent package does not interpret the return value;
	 * it is forwarded to `compile` as-is.
	 */
	getTaskState?: () => unknown;
	/**
	 * Project the input messages into a budgeted form. Receives the messages
	 * after `transformContext` ran, the latest TaskState (or undefined), and
	 * the budget configuration. The default agent-side values are:
	 * - `tokenBudget = max(0, model.contextWindow - keepRecentTokens - maxTokens)`
	 * - `keepRecentTurns = 20`
	 *
	 * The default estimator is chars/4 rounded up. Consumers that need a
	 * different estimator can compute it inside the `compile` callback.
	 */
	compile?: (
		messages: AgentMessage[],
		taskState: unknown,
		options: { tokenBudget: number; keepRecentTurns: number },
	) => AgentMessage[] | Promise<AgentMessage[]>;
	/**
	 * Tokens reserved inside the context window for the recent untrimmed tail
	 * and TaskState. Subtracted from `model.contextWindow` along with
	 * `model.maxTokens` to derive the projection budget. Default: 20000.
	 */
	keepRecentTokens?: number;
	/**
	 * Maximum number of recent turns to keep before the budget step trims
	 * older messages. Default: 20.
	 */
	keepRecentTurns?: number;
}

/**
 * F6 ExecutionPlan routing.
 *
 * When `enabled` is `true`, the agent loop dispatches tool calls from an
 * assistant message that carries an `executionPlan` field through the
 * provided `executor` (default: the F6 `executePlan` from the
 * coding-agent package) instead of the natural `executeToolCalls` path.
 * The `runner` argument the executor receives is built by the agent loop
 * and wraps the existing `prepareToolCall` + `executePreparedToolCall` +
 * `finalizeExecutedToolCall` flow, so plan steps and natural tool calls
 * share the same prepare / execute / finalize pipeline.
 *
 * When `enabled` is `false` (the default) or the field is omitted, the
 * agent loop ignores `executionPlan` on the assistant message and falls
 * through to `executeToolCalls` byte-for-byte, preserving the pre-F6
 * behavior.
 *
 * The agent package treats `plan` as an opaque `unknown` so it does not
 * import the F6 module. The higher-level package that supplies the
 * `executor` callback is responsible for typing the value it reads back
 * off the assistant message as its own F6 `ExecutionPlan` type and
 * passing that same value back to the `executor`.
 */
export interface ExecutionPlanConfig {
	/** When true, dispatch plan-bearing assistant messages through `executor`. */
	enabled: boolean;
	/**
	 * Maximum number of plan steps in flight at once. The agent loop
	 * forwards this value to the `executor` as its concurrency parameter.
	 * Values < 1 are treated as 1.
	 */
	concurrency?: number;
	/**
	 * Plan runner the agent loop calls for each plan step. The agent loop
	 * supplies a `StepRunner` that wraps the existing
	 * `prepareToolCall` + `executePreparedToolCall` + `finalizeExecutedToolCall`
	 * flow and maps the step's `kind` and `target` to a concrete tool call.
	 *
	 * The default in the higher-level package is the F6 `executePlan` from
	 * `coding-agent/src/core/execution-plan/executor.ts`. The agent package
	 * never imports that module directly to avoid a circular dependency.
	 *
	 * The `plan` and `runner` arguments are typed as `unknown` here so the
	 * agent package does not need to know the F6 shapes. The higher-level
	 * `executor` implementation casts both to the F6 types it owns. The
	 * third argument carries the agent loop's `concurrency` and `signal`;
	 * executors can ignore the third argument if they accept those settings
	 * through other channels.
	 */
	executor?: (
		plan: unknown,
		runner: unknown,
		options?: { concurrency?: number; signal?: AbortSignal },
	) => Promise<unknown>;
}

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 *
	 * Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage
	 * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
	 * status messages) should be filtered out.
	 *
	 * Contract: must not throw or reject. Return a safe fallback value instead.
	 * Throwing interrupts the low-level agent loop without producing a normal event sequence.
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // Convert custom message to user message
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // Filter out UI-only messages
	 *     return [];
	 *   }
	 *   // Pass through standard LLM messages
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * Optional transform applied to the context before `convertToLlm`.
	 *
	 * Use this for operations that work at the AgentMessage level:
	 * - Context window management (pruning old messages)
	 * - Injecting context from external sources
	 *
	 * Contract: must not throw or reject. Return the original messages or another
	 * safe fallback value instead.
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * Optional F2 context-compiler routing.
	 *
	 * When `enabled` is true, the agent loop runs the output of `transformContext`
	 * through the provided `compile` callback before passing it to `convertToLlm`.
	 * This replaces the chronological-replay behavior of the extension hook with a
	 * budgeted projection. When `enabled` is false (the default) or when the
	 * field is omitted, the agent loop preserves the existing passthrough
	 * behavior byte-for-byte.
	 *
	 * The `compile` callback is provided by the higher-level package that owns
	 * the F2 module. The agent package intentionally does not import the F2
	 * module directly to avoid a circular dependency; the agent package only
	 * knows how to compute the budget and forward the messages and the resolved
	 * TaskState to the consumer.
	 */
	contextCompiler?: ContextCompilerConfig;

	/**
	 * Optional F6 ExecutionPlan routing.
	 *
	 * When `enabled` is `true`, the agent loop dispatches tool calls from an
	 * assistant message that carries an `executionPlan` field through the
	 * provided `executor` callback instead of `executeToolCalls`. When
	 * `enabled` is `false` (the default) or the field is omitted, the agent
	 * loop preserves the existing `executeToolCalls` path byte-for-byte.
	 *
	 * The agent loop builds the `StepRunner` that maps a plan step's
	 * `kind` and `target` to a concrete tool call (read → `read`,
	 * bash → `bash`, etc.) and wraps the existing
	 * `prepareToolCall` + `executePreparedToolCall` + `finalizeExecutedToolCall`
	 * path. The `executor` is provided by the higher-level package that
	 * owns the F6 module; the agent package intentionally does not import
	 * the F6 module directly to avoid a circular dependency.
	 */
	executionPlan?: ExecutionPlanConfig;

	/**
	 * Resolves an API key dynamically for each LLM call.
	 *
	 * Useful for short-lived OAuth tokens (e.g., GitHub Copilot) that may expire
	 * during long-running tool execution phases.
	 *
	 * Contract: must not throw or reject. Return undefined when no key is available.
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * Called after each turn fully completes and `turn_end` has been emitted.
	 *
	 * If it returns true, the loop emits `agent_end` and exits before polling steering or follow-up queues,
	 * without starting another LLM call. The current assistant response and any tool executions finish normally.
	 * This callback sees the completed-turn context and runs before `prepareNextTurn`.
	 *
	 * Use this to request a graceful stop after the current turn, e.g. before context gets too full.
	 *
	 * Contract: must not throw or reject. Throwing interrupts the low-level agent loop without producing a normal event sequence.
	 */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;

	/**
	 * Called after `turn_end` when the loop will continue, immediately before the next turn starts.
	 * Return replacement context/model/thinking state to affect that turn.
	 * Return undefined to keep using the current context/config.
	 */
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	/**
	 * Returns steering messages to inject into the conversation mid-run.
	 *
	 * Called after the current assistant turn finishes executing its tool calls, unless `shouldStopAfterTurn` exits first.
	 * If messages are returned, they are added to the context before the next LLM call.
	 * Tool calls from the current assistant message are not skipped.
	 *
	 * Use this for "steering" the agent while it's working.
	 *
	 * Contract: must not throw or reject. Return [] when no steering messages are available.
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Returns follow-up messages to process after the agent would otherwise stop.
	 *
	 * Called when the agent has no more tool calls and no steering messages.
	 * If messages are returned, they're added to the context and the agent
	 * continues with another turn.
	 *
	 * Use this for follow-up messages that should wait until the agent finishes.
	 *
	 * Contract: must not throw or reject. Return [] when no follow-up messages are available.
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Tool execution mode.
	 * - "sequential": execute tool calls one by one
	 * - "parallel": preflight tool calls sequentially, then execute allowed tools concurrently;
	 *   emit `tool_execution_end` in tool completion order after each tool is finalized,
	 *   then emit tool-result message artifacts later in assistant source order
	 *
	 * Default: "parallel"
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * Called before a tool is executed, after arguments have been validated.
	 *
	 * Return `{ block: true }` to prevent execution. The loop emits an error tool result instead.
	 * A blocked result can also set `terminate: true` to participate in the batch early-termination rule.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * Called after a tool finishes executing, before `tool_execution_end` and tool-result message events are emitted.
	 *
	 * Return an `AfterToolCallResult` to override parts of the executed tool result:
	 * - `content` replaces the full content array
	 * - `details` replaces the full details payload
	 * - `isError` replaces the error flag
	 * - `usage` replaces the tool result usage
	 * - `terminate` replaces the early-termination hint
	 *
	 * Any omitted fields keep their original values. No deep merge is performed.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

/**
 * Thinking/reasoning level for models that support it.
 * Note: "xhigh" and "max" are only supported by selected model families. Use model
 * thinking-level metadata from @theta/ai to detect support for a concrete model.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// Empty by default - apps extend via declaration merging
}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * Public agent state.
 *
 * `tools` and `messages` use accessor properties so implementations can copy
 * assigned arrays before storing them.
 */
export interface AgentState {
	/** System prompt sent with each model request. */
	systemPrompt: string;
	/** Active model used for future turns. */
	model: Model<any>;
	/** Requested reasoning level for future turns. */
	thinkingLevel: ThinkingLevel;
	/** Available tools. Assigning a new array copies the top-level array. */
	set tools(tools: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	/** Conversation transcript. Assigning a new array copies the top-level array. */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	/**
	 * True while the agent is processing a prompt or continuation.
	 *
	 * This remains true until awaited `agent_end` listeners settle.
	 */
	readonly isStreaming: boolean;
	/** Partial assistant message for the current streamed response, if any. */
	readonly streamingMessage?: AgentMessage;
	/** Tool call ids currently executing. */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** Error message from the most recent failed or aborted assistant turn, if any. */
	readonly errorMessage?: string;
}

/** Structured outcome synthesized for every tool result. */
export type ToolOutcomeStatus = "succeeded" | "failed" | "cancelled" | "incomplete" | "unknown";

/** Structured outcome synthesized for every tool result. */
export interface ToolOutcome {
	/** Terminal status of this tool call. */
	status: ToolOutcomeStatus;
	/** Process exit code, when applicable (shell tools). */
	exitStatus?: number;
	/** Identity of the code path that produced the result (parser, transport, snapshot path). */
	source?: { snapshot?: string; parser?: string };
	/** Per-tool structured observations: match counts, overwrite flags, etc. */
	observations?: Record<string, unknown>;
	/** Non-fatal warnings surfaced by the tool. */
	warnings?: string[];
	/** Raw evidence preserved for debugging or replay. */
	rawEvidence?: string;
	/** Stable identity of the parser used to interpret the underlying output. */
	parserIdentity?: string;
	/** Confidence in the synthesized status, in [0, 1]. */
	confidence?: number;
}

/** Final or partial result produced by a tool. */
export interface AgentToolResult<T> {
	/** Text or image content returned to the model. */
	content: (TextContent | ImageContent)[];
	/** Arbitrary structured details for logs or UI rendering. */
	details: T;
	/** Usage from the final tool execution itself, if available. Not used for main LLM context accounting. */
	usage?: Usage;
	/** Names of tools introduced by this result and available from this transcript point onward. */
	addedToolNames?: string[];
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

/**
 * Callback used by tools to stream partial execution updates.
 *
 * The callback is scoped to the current `execute()` invocation. Calls made after
 * the tool promise settles are ignored.
 */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/** Tool definition used by the agent runtime. */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	/** Human-readable label for UI display. */
	label: string;
	/**
	 * Optional compatibility shim for raw tool-call arguments before schema validation.
	 * Must return an object that matches `TParameters`.
	 */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	/** Execute the tool call. Throw on failure instead of encoding errors in `content`. */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	/** Recovery policy for an effect whose durable intent exists but whose outcome is unknown. */
	replay?: "never" | "safe";
	/**
	 * Per-tool execution mode override.
	 * - "sequential": this tool must execute one at a time with other tool calls.
	 * - "parallel": this tool can execute concurrently with other tool calls.
	 *
	 * If omitted, the default execution mode applies.
	 */
	executionMode?: ToolExecutionMode;
}

/** Context snapshot passed into the low-level agent loop. */
export interface AgentContext {
	/** System prompt included with the request. */
	systemPrompt: string;
	/** Transcript visible to the model. */
	messages: AgentMessage[];
	/** Tools available for this run. */
	tools?: AgentTool<any>[];
}

/**
 * Events emitted by the Agent for UI updates.
 *
 * `agent_end` is the last event emitted for a run, but awaited `Agent.subscribe()`
 * listeners for that event are still part of run settlement. The agent becomes
 * idle only after those listeners finish.
 */
export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// Message lifecycle - emitted for user, assistant, and toolResult messages
	| { type: "message_start"; message: AgentMessage }
	// Only emitted for assistant messages during streaming
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };

