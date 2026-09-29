import { join } from "node:path";
import { Agent, type AgentMessage, setDefaultStreamFn, type ThinkingLevel } from "@theta/agent-core";
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@theta/ai/compat";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { annotateCacheMarkers, attachCachePlanToMessages } from "./cache-rendering.ts";
import { type CompiledContext, compileContext } from "./context-compiler.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { annotateStaleness, checkEvidenceFreshness } from "./evidence-freshness.ts";
import { executePlan as f6ExecutePlan } from "./execution-plan/index.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { convertToLlmIncremental, IncrementalSerializer } from "./incremental-serialization.ts";
import { convertToLlm } from "./messages.ts";
import { findInitialModel } from "./model-resolver.ts";
import { ModelRuntime } from "./model-runtime.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import { createFileWatcher, type FileWatcher } from "./repository/file-watcher.ts";
import { createLiveQueryToolData, type LiveQueryToolData } from "./repository/query-data.ts";
import type { SharedEvidenceStore } from "./repository/shared-evidence.ts";
import { FileSharedEvidenceStore } from "./repository/shared-evidence-ipc.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { getLatestTaskState, type TaskState } from "./task-state.ts";
import { time } from "./timings.ts";
import {
	createBashTool,
	createCodingToolDefinitions,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	type ToolDef,
	type ToolName,
	withFileMutationQueue,
} from "./tools/index.ts";

// Preserve the pre-0.81 fallback for extensions that construct Agent instances
// or invoke low-level agent loops without supplying streamFn. Agent core remains
// provider-agnostic and does not import theta-ai/compat itself.
setDefaultStreamFn(streamSimple);

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.theta/agent */
	agentDir?: string;

	/** Canonical model/auth runtime. Defaults to a runtime using agentDir/auth.json and models.json. */
	modelRuntime?: ModelRuntime;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (read, bash, edit, write)
	 *   but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names.
	 *
	 * When omitted, theta uses the `defaultTools` setting for the initial built-in
	 * selection when configured. Otherwise it enables the default built-in tools
	 * (read, bash, edit, write). Extension/custom tools remain enabled unless
	 * `noTools` changes that default. When provided, only the listed tool names are
	 * enabled.
	 */
	tools?: string[];
	/** Optional denylist of tool names to disable. Applies after `tools` when both are provided. */
	excludeTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
	/**
	 * F1 query data layer. The session uses this to build the F1
	 * `query` tool's data (manifest + syntax index + semantic
	 * adapter). Exposed here so tests and SDK consumers can inspect
	 * the live snapshot or trigger a refresh.
	 */
	liveQueryToolData: LiveQueryToolData;
	/**
	 * F1 file watcher backing the live query data layer's
	 * watcher-driven symbol index. Present when the watcher backend
	 * was available; absent when the layer degraded to the no-watcher
	 * behavior. The data layer owns its lifecycle
	 * (`liveQueryToolData.dispose()` stops it on session teardown),
	 * so callers only need this handle for inspection or explicit
	 * early disposal.
	 */
	fileWatcher?: FileWatcher;
}

// Re-exports

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
	createPowerShellTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

/**
 * F2 `convertToLlm` wire-in. Composes the F11 incremental serializer
 * (for cross-turn caching of the per-`AgentMessage` conversion output)
 * with the defense-in-depth image-blocking filter.
 *
 * The F2 layer calls `convert` once per provider request. For a long
 * session, the same `AgentMessage` references flow through every turn
 * with unchanged tool-call arguments, so the F11 serializer caches
 * each message's `convertToLlm` output and skips re-serialization on
 * cache hits. The cache is keyed by the `AgentMessage` reference and a
 * content hash of the conversion-relevant fields; the cached `Message`
 * is `structuredClone`'d once and reused verbatim for subsequent
 * unchanged inputs.
 *
 * The F11 incremental serializer is constructed lazily on first use
 * (one per F2-enabled session, i.e. one per `createAgentSession`
 * call) and reused for the lifetime of the wire-in so the cache
 * spans every turn in the session. The serializer instance is
 * exposed via `getSerializer()` for diagnostics and testing.
 *
 * The image-blocking filter runs after the conversion and is
 * unchanged from the pre-F11 wire-in: when
 * `settingsManager.getBlockImages()` is true, `ImageContent` blocks
 * in `user` and `toolResult` messages are replaced with a text
 * placeholder.
 */
export function createF2ConvertToLlm(settingsManager: SettingsManager): {
	convert: (messages: AgentMessage[]) => Message[];
	/** Returns the lazy-initialized serializer instance, or `null` if the wire-in has not been used yet. */
	getSerializer: () => IncrementalSerializer | null;
} {
	// Lazy: only constructed on the first call to `convert`. This
	// avoids the cost for sessions that never use the F2 wire-in, and
	// the same backing serializer is reused for every subsequent
	// call (one cache per `createF2ConvertToLlm` invocation, i.e. one
	// per F2-enabled session).
	let incrementalSerializer: IncrementalSerializer | null = null;
	let incrementalConvert: ((messages: AgentMessage[]) => Message[]) | null = null;

	const getIncrementalConvert = (): ((messages: AgentMessage[]) => Message[]) => {
		if (incrementalSerializer === null) {
			incrementalSerializer = new IncrementalSerializer();
		}
		if (incrementalConvert === null) {
			// Capture the serializer in the closure so the call site
			// does not need to re-read the (mutable) outer variable
			// on every invocation. The closure is built once and
			// reused for the rest of the session.
			//
			// Note: `createIncrementalConvertToLlm()` is a thin
			// convenience factory that does exactly `new
			// IncrementalSerializer() + (m) =>
			// convertToLlmIncremental(serializer, m)`. We use the
			// primitives directly so the same `IncrementalSerializer`
			// instance is reachable via `getSerializer()` for cache
			// diagnostics and testing. The factory's serializer is
			// not externally visible, so without this deviation the
			// test could only verify cache hits behaviorally.
			const serializer = incrementalSerializer;
			incrementalConvert = (messages) => convertToLlmIncremental(serializer, messages);
		}
		return incrementalConvert;
	};

	// Defense-in-depth image blocker. Reads the setting dynamically so
	// a mid-session toggle takes effect on the next call. Identical to
	// the pre-F11 `convertToLlmWithBlockImages` filter.
	const blockImages = (converted: Message[]): Message[] => {
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const convert = (messages: AgentMessage[]): Message[] => {
		// Read the setting dynamically so a mid-session toggle of
		// `f2.incrementalSerialization` takes effect on the next
		// call. When the setting is off, fall back to a fresh
		// `convertToLlm` walk (byte-identical to the pre-F11 wire-in).
		if (settingsManager.getF2IncrementalSerializationEnabled()) {
			return blockImages(getIncrementalConvert()(messages));
		}
		return blockImages(convertToLlm(messages));
	};

	return {
		convert,
		getSerializer: () => incrementalSerializer,
	};
}

/**
 * Create the default coding tool definitions for `cwd`, wiring the F1
 * `query` tool from the supplied `LiveQueryToolData`. This is the
 * function `createAgentSession` uses to assemble the tool list that
 * gets handed to the agent loop; it is also exported so the wiring
 * is testable in isolation.
 *
 * The `query` tool is bound to a LIVE data source
 * (`getData: () => live.getToolData()`) so every invocation resolves
 * the current manifest / symbol index / semantic adapter — a
 * worktree mutation (with `live.refresh()` in between) is reflected
 * in the next query without rebuilding the tools. The initial
 * `getToolData()` await warms the layer's cache (first manifest walk
 * + syntax extraction) so the first query does not pay cold I/O.
 */
export async function createCodingToolDefinitionsWithLiveQuery(
	cwd: string,
	live: LiveQueryToolData,
): Promise<ToolDef[]> {
	await live.getToolData();
	return createCodingToolDefinitions(cwd, {
		query: {
			getData: () => live.getToolData(),
		},
	});
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@theta/ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath, modelsPath }));

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRuntime.getModel(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
			modelRuntime,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to per-model override, then global default
	if (thinkingLevel === undefined && model) {
		const perModel = settingsManager.getModelThinkingLevel(model.provider, model.id);
		if (perModel) {
			thinkingLevel = perModel;
		}
	}
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const defaultActiveToolNames: ToolName[] = ["read", "bash", "edit", "write"];
	const configuredDefaultToolNames = settingsManager.getDefaultTools();
	const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
	const excludedToolNames = options.excludeTools;
	const excludedToolNameSet = excludedToolNames ? new Set(excludedToolNames) : undefined;
	// F1: the `query` tool is added to the default active tool list when
	// the live data layer is attached and the `query.enabledByDefault`
	// setting is true (the default). The user can opt out via the
	// setting. We only auto-add when the user has not provided an
	// explicit `tools` allowlist (full control) or `noTools` (no tools
	// at all) — both of those are explicit user intent at the call
	// site. `excludeTools` still applies on top so users can drop the
	// tool via the denylist as well.
	const queryEnabledByDefault = settingsManager.getQueryEnabledByDefault();
	const shouldAutoAddQuery = !options.tools && !options.noTools && queryEnabledByDefault;
	const baseActiveToolNames = (
		options.tools ?? (options.noTools ? [] : (configuredDefaultToolNames ?? defaultActiveToolNames))
	).filter((name) => !excludedToolNameSet?.has(name));
	const initialActiveToolNames =
		shouldAutoAddQuery && !baseActiveToolNames.includes("query")
			? [...baseActiveToolNames, "query"]
			: baseActiveToolNames;

	let agent: Agent;

	// F2 wire-in: the F11 incremental serializer (one per F2-enabled
	// session, cached across turns) composes with the image-blocking
	// filter. See `createF2ConvertToLlm` for the full contract. The
	// serializer is constructed lazily on the first call and persists
	// across turns, so repeated calls with the same `AgentMessage`
	// references skip per-message re-serialization.
	const f2ConvertToLlm = createF2ConvertToLlm(settingsManager);

	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	// F2 evidence freshness: the latest known content hashes for the
	// paths referenced by `TaskState.changedFiles`. The map is
	// populated by the `onReadResult` callback passed to the
	// `AgentSession` below: every successful `read` tool result with
	// a `details.contentIdentity` records `path → contentIdentity` so
	// the freshness check in the `compile` callback (which closes
	// over this map) can compare recorded hashes against fresh
	// evidence.
	const _latestEvidenceHashes = new Map<string, string>();
	// F2 evidence freshness read-tool capture. Forwarded to
	// `AgentSession` via the `onReadResult` config; the session's
	// `afterToolCall` hook invokes this for every successful read.
	// The callback is a thin closure so the host (this function)
	// owns the map and the AgentSession stays decoupled from the
	// evidence-freshness module.
	const onReadResult = (capture: { path: string; contentIdentity: string }): void => {
		_latestEvidenceHashes.set(capture.path, capture.contentIdentity);
	};

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: f2ConvertToLlm.convert,
		streamFn: async (model, context, options) => {
			const providerRetrySettings = settingsManager.getProviderRetrySettings();
			const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
			// SDKs treat timeout=0 as 0ms (immediate timeout), not "no timeout".
			// Use max int32 to effectively disable the timeout.
			const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
			const timeoutMs = options?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
			const websocketConnectTimeoutMs =
				options?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs();
			const headerRunner = extensionRunnerRef.current;
			return modelRuntime.streamSimple(model, context, {
				...options,
				timeoutMs,
				websocketConnectTimeoutMs,
				maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
				transformHeaders: async (requestHeaders) => {
					const headers = mergeProviderAttributionHeaders(
						model,
						settingsManager,
						options?.sessionId,
						requestHeaders,
					);
					return headerRunner?.hasHandlers("before_provider_headers")
						? headerRunner.emitBeforeProviderHeaders(headers ?? {})
						: (headers ?? {});
				},
			});
		},
		onPayload: async (payload, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		// F2: opt-in routing of `transformContext` output through the context
		// compiler. When the setting is off (the default), the field is set to
		// `{ enabled: false }` so the agent loop's `transformContext` flow
		// remains byte-identical to the pre-F2 behavior. The `compile` and
		// `getTaskState` callbacks close over the live `sessionManager` and the
		// real F2 module so each assistant turn reads the latest TaskState
		// snapshot from the session branch. The agent package does not know
		// about the F2 module or the TaskState type; both are passed through
		// as opaque values and cast back to the F2 types inside `compile`.
		contextCompiler: settingsManager.getContextCompilerEnabled()
			? {
					enabled: true,
					keepRecentTokens: 20_000,
					keepRecentTurns: 20,
					getTaskState: () => getLatestTaskState(sessionManager.getBranch()),
					compile: (messages, taskState, options) => {
						// F2 stable-rendering: when `cacheRendering.enabled` is
						// true, run `annotateCacheMarkers` on the compiled
						// projection so the provider adapter can place
						// `cache_control` markers at the stable/volatile split.
						// The cache plan is captured by the closure so a future
						// adapter-side consumer can read it (see
						// `cache-rendering.ts`); the agent loop is unaware of
						// the plan and just receives the marked messages.
						//
						// After `annotateCacheMarkers` runs, the F2 wire-in
						// step `attachCachePlanToMessages` attaches the plan
						// to the last user/assistant message's `details` so the
						// provider adapter (`packages/ai/src/api/openai-completions.ts`
						// and `packages/ai/src/api/anthropic-messages.ts`) can
						// read it structurally and place `cache_control`
						// markers accordingly. Without this step the adapter
						// would fall back to the legacy positional walker.
						//
						// F2 evidence freshness: after the (optional) cache
						// marker pass, run `checkEvidenceFreshness` against
						// the latest known evidence hashes and let
						// `annotateStaleness` prepend a `freshness-warning`
						// custom message to the projection when any tracked
						// file is stale or missing. The report is captured by
						// the closure alongside the cache plan.
						const compiled = compileContext(messages, taskState as TaskState | undefined, options);
						let projection: CompiledContext = compiled;
						if (settingsManager.getContextCompilerCacheRenderingEnabled()) {
							const rendering = settingsManager.getContextCompilerCacheRendering();
							projection = annotateCacheMarkers(projection, {
								format: rendering.format,
								retention: rendering.retention,
								systemPrompt: rendering.systemPrompt,
								lastTool: rendering.lastTool,
								lastMessage: rendering.lastMessage,
							});
							if (projection.cachePlan) {
								projection = {
									...projection,
									messages: attachCachePlanToMessages(projection.messages, projection.cachePlan),
								};
							}
						}
						const freshnessReport = checkEvidenceFreshness({
							taskState: taskState as TaskState | undefined,
							latestHashes: _latestEvidenceHashes,
						});
						const withFreshness = annotateStaleness(freshnessReport, projection);
						return withFreshness.messages;
					},
				}
			: { enabled: false },
		// F6: opt-in routing of plan-bearing assistant messages through
		// the F6 `executePlan` runtime. When the setting is off (the
		// default) the agent loop preserves the existing
		// `executeToolCalls` path byte-for-byte. When the setting is on,
		// the agent loop reads the `executionPlan` envelope off the
		// assistant message and dispatches its tool calls through the
		// `executor` callback below. The `executor` invokes the F6
		// `executePlan` from `./execution-plan/index.ts`; the agent
		// package does not know this module, so the agent-side step
		// runner is built by the agent loop and passed in as the second
		// argument.
		executionPlan: settingsManager.getExecutionPlanEnabled()
			? {
					enabled: true,
					concurrency: settingsManager.getExecutionPlanSettings().concurrency,
					executor: (plan, runner, options) =>
						f6ExecutePlan({
							plan: plan as never,
							runner: runner as never,
							concurrency: options?.concurrency,
							signal: options?.signal,
						}),
				}
			: { enabled: false },
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});

	// Restore messages if session has existing data
	if (hasExistingSession) {
		agent.state.messages = existingSession.messages;
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	// F1: create the file watcher (best-effort — when the backend is
	// unavailable in this build or creation fails, degrade to the
	// no-watcher behavior instead of throwing), then build the live
	// query data layer with the watcher and the session's settings
	// manager. The layer owns the watcher's lifecycle (starts it, and
	// stops it in `dispose()` from the session teardown path). Attach
	// the layer to the session so the F1 `query` tool is part of the
	// active tool list. The live object is built before
	// `new AgentSession(...)` so the first `await session.whenReady()`
	// resolves immediately (the manifest + syntax index are already
	// cached). The live handle is also exposed on the result so
	// callers (and tests) can inspect it or force a refresh.
	let fileWatcher: FileWatcher | undefined;
	try {
		fileWatcher = createFileWatcher({ root: cwd });
	} catch {
		// Graceful degradation: no watcher, current (snapshot-only)
		// behavior.
		fileWatcher = undefined;
	}
	const liveQueryToolData: LiveQueryToolData = createLiveQueryToolData({
		root: cwd,
		watcher: fileWatcher,
		settingsManager,
	});
	// Warm the cache so the first `_buildRuntime` call inside the
	// session's constructor returns the cached snapshot without having
	// to re-walk the worktree. Optional: the session would also work
	// without it (it would just take a few extra ms during the
	// construction build).
	await createCodingToolDefinitionsWithLiveQuery(cwd, liveQueryToolData);

	// F10 shared evidence: when the host (or a parent subagent) points
	// `THETA_SHARED_EVIDENCE_PATH` at a file, the session publishes every
	// successful `read` tool result as `file-content` evidence into that
	// cross-process store so cooperating sessions avoid re-reading files
	// the parent already read. This is the same opt-in contract the
	// subagent example extension uses; sessions without the env var keep
	// the previous no-store behavior.
	let sharedEvidenceStore: SharedEvidenceStore | undefined;
	const sharedEvidencePath = process.env.THETA_SHARED_EVIDENCE_PATH;
	if (sharedEvidencePath?.trim()) {
		try {
			sharedEvidenceStore = new FileSharedEvidenceStore({ path: resolvePath(sharedEvidencePath.trim()) });
		} catch {
			// The store constructor reads the backing file; a corrupt or
			// locked file must not break session creation. Degrade to the
			// no-store behavior.
			sharedEvidenceStore = undefined;
		}
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRuntime,
		initialActiveToolNames,
		allowedToolNames,
		excludedToolNames,
		liveQueryToolData,
		sharedEvidenceStore,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
		onReadResult,
	});
	const extensionsResult = resourceLoader.getExtensions();

	// Wait for the initial tool registry build (which now reads from
	// the live query data layer) to finish before returning. Without
	// this, callers could observe `getAllTools()` before the
	// `query` tool has been registered.
	await session.whenReady();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
		liveQueryToolData,
		fileWatcher,
	};
}

