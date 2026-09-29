import type { ThinkingLevel } from "@theta/agent-core";
import type { Transport } from "@theta/ai";
import type { TuiMode as RendererTuiMode, ScrollViewScrollbar, TerminalCapabilities } from "@theta/tui";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";

export interface CompactionSettings {
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	keepRecentTokens?: number; // default: 20000
}

export interface BranchSummarySettings {
	reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
	skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}

export interface ProviderRetrySettings {
	timeoutMs?: number; // SDK/provider request timeout in milliseconds
	maxRetries?: number; // SDK/provider retry attempts
	maxRetryDelayMs?: number; // default: 60000 (max server-requested delay before failing)
}

/**
 * F16 verification engine settings.
 *
 * - `enabled`         — master switch for the F16 completion gate. When
 *                       `false`, the gate short-circuits to `satisfied`
 *                       and the agent loop behaves as it did pre-F16.
 *                       Default: `true` (the audit calls for the gate
 *                       to be on by default; opt-out is the explicit
 *                       user choice).
 * - `runOnEveryTurn`  — when `true`, the verification runner spawns
 *                       the configured checks at the end of every
 *                       `turn_end` event. When `false` (the default),
 *                       the runner only fires when the gate itself is
 *                       evaluated, keeping per-turn latency low. The
 *                       gate is still evaluated on every turn; the
 *                       question is whether the runner proactively
 *                       re-runs the underlying commands.
 * - `policyPath`      — path to a `.theta/verification.json` file
 *                       (resolved relative to the worktree). When
 *                       `undefined`, the policy loader falls back to
 *                       the project-shape default and any per-package
 *                       `package.json` `theta.verification` override.
 */
export interface VerificationSettings {
	enabled?: boolean; // default: true
	runOnEveryTurn?: boolean; // default: false
	policyPath?: string; // default: undefined → .theta/verification.json
	/**
	 * Authorize the harness (not the model) to spawn policy checks through
	 * the verification runner when the gate needs fresh evidence. The
	 * audit's "automatic checks" safeguard requires an explicit opt-in
	 * because checks execute repository-defined commands. Default:
	 * `false` (the gate records verdicts from observed tool activity only).
	 */
	autoRunChecks?: boolean; // default: false
}

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 3
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
	provider?: ProviderRetrySettings;
}

/**
 * F1 repository-layer tree-sitter settings.
 *
 * `enabled` controls whether the F1 syntax index and
 * `LiveSyntaxIndex` prefer the tree-sitter-backed extractors over
 * the regex fallback. When the per-language tree-sitter grammar is
 * not registered (the default — the language packages are not part
 * of the workspace's runtime dependencies), the index silently
 * falls back to regex extraction regardless of this flag.
 *
 * Default: `enabled = true` (opt-out, since the fallback is silent
 * and the tree-sitter path is preferred wherever it is available).
 */
export interface QueryTreeSitterSettings {
	enabled?: boolean; // default: true
}

/**
 * F1 repository-intelligence settings.
 *
 * The `lsp` knob is the master switch for the LSP-backed semantic
 * query layer. The `treeSitter` knob is owned by the tree-sitter
 * subagent — the LSP layer does not consume it directly, but the
 * two share the same `repository.*` namespace so the live data
 * layer can read both at construction time.
 */
export interface RepositorySettings {
	lsp?: RepositoryLspSettings;
	treeSitter?: RepositoryTreeSitterSettings;
}

export interface RepositoryTreeSitterSettings {
	enabled?: boolean;
}

/**
 * F1 repository-intelligence LSP settings.
 *
 * `enabled` is the master switch for the LSP-backed semantic query
 * layer. When `true` (the default), the live data layer's
 * `resolveAdapter` auto-detects a usable language server
 * (e.g. `typescript-language-server` on `PATH` or in
 * `node_modules/.bin`) and binds the worktree to a real
 * `LspAdapter`. When `false`, the auto-detect path skips the LSP
 * probe entirely and falls straight through to the in-process
 * `typescript-ls` or the mock.
 *
 * Default: `enabled = true` — the audit (Section 11.3) calls for
 * "the right tool" to be the language server when one is on
 * `PATH`; the F1 layer only falls back to the in-process or mock
 * backend when no server is available, and the user can opt out
 * of the probe (e.g. in sandboxed environments where spawning
 * a child is undesirable).
 */
export interface RepositoryLspSettings {
	enabled?: boolean; // default: true
}

/**
 * F1 `query` tool settings.
 *
 * `enabled` (alias: `enabledByDefault`) controls whether the F1
 * `query` tool is registered by default in the base tool list.
 * `f1ReadOnlyByDefault` controls whether the three F1-backed
 * read-only tools (`f1-grep`, `f1-find`, `f1-ls`) are used in
 * place of the standard `grep` / `find` / `ls` when the F1
 * manifest is warm. Both default to `true`.
 */
export interface QuerySettings {
	enabled?: boolean; // default: true
	enabledByDefault?: boolean; // alias for `enabled`
	f1ReadOnlyByDefault?: boolean; // default: true
}

/**
 * F2 context-compiler settings.
 *
 * `enabled` controls whether the agent loop routes the
 * `transformContext` output through the F2 module (vs the byte-
 * identical passthrough). Default `false`. `cacheRendering` enables
 * the stable/volatile split that lets the provider adapter place
 * `cache_control` markers at the boundary.
 */
export interface ContextCompilerSettings {
	enabled?: boolean; // default: false
	cacheRendering?: ContextCompilerCacheRenderingSettings;
}

export interface ContextCompilerCacheRenderingSettings {
	enabled?: boolean; // default: false
	format?: string; // default: "anthropic"
	retention?: "short" | "long"; // default: "long"
	systemPrompt?: boolean; // default: true
	lastTool?: boolean; // default: true
	lastMessage?: boolean; // default: true
}

/**
 * F6 ExecutionPlan settings.
 *
 * `enabled` controls whether tool calls from an assistant message
 * that carries an `executionPlan` field are dispatched through the
 * F6 `executePlan` runner (vs the natural `executeToolCalls` path).
 * Default `false`. `concurrency` caps in-flight plan steps.
 */
export interface ExecutionPlanSettings {
	enabled?: boolean; // default: false
	concurrency?: number; // default: 4
}

/**
 * F2 / F11 incremental serialization settings.
 *
 * `incrementalSerialization` enables the F11 incremental message
 * serializer (one per F2-enabled agent). When `false`, the agent
 * loop uses the byte-identical pre-F11 serialization path. Default
 * `false`.
 */
export interface F2IncrementalSerializationSettings {
	enabled?: boolean; // default: false
}

/**
 * `incrementalSerialization` may be either a boolean shorthand
 * (`true` to enable with defaults) or a `F2IncrementalSerializationSettings`
 * object. The shorthand is accepted at the storage layer; accessor
 * methods always return the resolved object form.
 */
export interface F2Settings {
	incrementalSerialization?: boolean | F2IncrementalSerializationSettings;
}

export type TuiMode = RendererTuiMode;
export type FullscreenExitOutput = "transcript" | "resume-hint";

export interface TerminalSettings {
	showImages?: boolean; // default: true (only relevant if terminal supports images)
	imageWidthCells?: number; // default: 60 (preferred inline image width in terminal cells)
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
	showTerminalProgress?: boolean; // default: false (OSC 9;4 terminal progress indicators)
	hyperlinks?: boolean | "auto";
	images?: "kitty" | "iterm2" | "auto" | false;
	trueColor?: boolean | "auto";
}

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
	blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export type MermaidRenderingMode = "off" | "final" | "streaming";

export interface MarkdownSettings {
	codeBlockIndent?: string; // default: "  "
	mermaid?: MermaidRenderingMode; // default: "streaming"
}

export interface WarningSettings {
	anthropicExtraUsage?: boolean; // default: true
}

export type DefaultProjectTrust = "ask" | "always" | "never";

export type TransportSetting = Transport;

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 * - autoload=false: start empty and only apply explicit resource patterns
 */
export type PackageSource =
	| string
	| {
			source: string;
			autoload?: boolean;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

export interface Settings {
	lastChangelogVersion?: string;
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
	modelThinkingLevels?: Record<string, ThinkingLevel>; // per-model default thinking level overrides keyed by "provider/modelId"
	transport?: TransportSetting; // default: "auto"
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	theme?: string;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	verification?: VerificationSettings; // F16: opt-in F16 verification engine + completion gate
	retry?: RetrySettings;
	queryTreeSitter?: QueryTreeSitterSettings; // F1: opt-out for tree-sitter syntax extraction
	query?: QuerySettings; // F1: query tool registration and F1 read-only defaults
	contextCompiler?: ContextCompilerSettings; // F2: opt-in routing of transformContext through the F2 module
	executionPlan?: ExecutionPlanSettings; // F6: opt-in routing of tool calls through the F6 ExecutionPlan executor
	f2?: F2Settings; // F2/F11: F11 incremental serialization (closed union today; F11+)
	hideThinkingBlock?: boolean;
	showCacheMissNotices?: boolean; // default: false - show cache cost and provider recovery notices
	externalEditor?: string; // Command for Ctrl+G external editor; takes precedence over VISUAL/EDITOR
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows); supports leading ~ expansion
	quietStartup?: boolean;
	defaultProjectTrust?: DefaultProjectTrust; // default: "ask"; global setting only
	shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
	npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
	collapseChangelog?: boolean; // Show condensed changelog after update (use /changelog for full)
	enableInstallTelemetry?: boolean; // default: true - anonymous version/update ping after changelog-detected updates
	enableAnalytics?: boolean; // default: false - opt-in analytics data sharing
	trackingId?: string; // analytics tracking identifier, generated when analytics is enabled
	packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
	extensions?: string[]; // Array of local extension file paths or directories
	skills?: string[]; // Array of local skill file paths or directories
	prompts?: string[]; // Array of local prompt template paths or directories
	themes?: string[]; // Array of local theme file paths or directories
	enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
	/**
	 * F9 selective skills catalog: maximum estimated tokens the visible
	 * skill catalog may occupy in the system prompt. `undefined` (the
	 * default) injects every visible skill; a number filters the catalog
	 * through `selectSkillsForPrompt` so large installed catalogs stop
	 * growing the stable prompt prefix.
	 */
	skillsCatalogBudgetTokens?: number;
	terminal?: TerminalSettings;
	images?: ImageSettings;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	defaultTools?: string[]; // Initial built-in tool selection
	doubleEscapeAction?: "fork" | "tree" | "none"; // Action for double-escape with empty editor (default: "tree")
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // Default filter when opening /tree
	thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
	editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
	outputPad?: 0 | 1; // Horizontal padding for chat message output (default: 1)
	autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
	markdown?: MarkdownSettings;
	warnings?: WarningSettings;
	sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
	httpProxy?: string; // Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for Theta-managed HTTP clients
	httpIdleTimeoutMs?: number; // HTTP header/body idle timeout in milliseconds; 0 disables it
	websocketConnectTimeoutMs?: number; // WebSocket connect/open handshake timeout in milliseconds; 0 disables it
	tuiMode?: TuiMode; // default: "regular"
	fullscreenExitOutput?: FullscreenExitOutput; // default: "transcript"; no effect in regular TUI mode
	fullscreenScrollbar?: ScrollViewScrollbar; // default: "auto"; no effect in regular TUI mode
	fullscreenCopyOnSelect?: boolean; // default: true; no effect in regular TUI mode
	repository?: RepositorySettings; // F1: knobs for the F1 repository-intelligence layer (e.g. LSP enablement)
}

function isMergeableObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMergeObjects(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };

	for (const key of Object.keys(overrides)) {
		const overrideValue = overrides[key];
		if (overrideValue === undefined) {
			continue;
		}

		const baseValue = base[key];
		result[key] =
			isMergeableObject(baseValue) && isMergeableObject(overrideValue)
				? deepMergeObjects(baseValue, overrideValue)
				: overrideValue;
	}

	return result;
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	return deepMergeObjects(base as Record<string, unknown>, overrides as Record<string, unknown>) as Settings;
}

function parseTimeoutSetting(value: unknown, settingName: string): number | undefined {
	const timeoutMs = parseHttpIdleTimeoutMs(value);
	if (timeoutMs !== undefined) {
		return timeoutMs;
	}
	if (value !== undefined) {
		throw new Error(`Invalid ${settingName} setting: ${String(value)}`);
	}
	return undefined;
}

export type SettingsScope = "global" | "project";

export interface SettingsManagerCreateOptions {
	projectTrusted?: boolean;
}

export interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

export interface SettingsError {
	scope: SettingsScope;
	path?: string;
	error: Error;
}

type SettingsPaths = Partial<Record<SettingsScope, string>>;

function toSettingsError(scope: SettingsScope, error: unknown, path?: string): SettingsError {
	return {
		scope,
		...(path ? { path } : {}),
		error: error instanceof Error ? error : new Error(String(error)),
	};
}

export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;

	constructor(cwd: string, agentDir: string) {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		this.globalSettingsPath = join(resolvedAgentDir, "settings.json");
		this.projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json");
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			// Only create directory and lock if file exists or we need to write
			const fileExists = existsSync(path);
			if (fileExists) {
				release = this.acquireLockSyncWithRetry(path);
			}
			const current = fileExists ? readFileSync(path, "utf-8") : undefined;
			const next = fn(current);
			if (next !== undefined) {
				// Only create directory when we actually need to write
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				if (!release) {
					release = this.acquireLockSyncWithRetry(path);
				}
				writeFileSync(path, next, "utf-8");
			}
		} finally {
			if (release) {
				release();
			}
		}
	}
}

export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
		}
	}
}

export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private settings: Settings;
	private projectTrusted: boolean;
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];
	private settingsPaths: SettingsPaths;

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
		projectTrusted = true,
		settingsPaths: SettingsPaths = {},
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.projectTrusted = projectTrusted;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		this.settingsPaths = settingsPaths;
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** Create a SettingsManager that loads from files */
	static create(
		cwd: string,
		agentDir: string = getAgentDir(),
		options: SettingsManagerCreateOptions = {},
	): SettingsManager {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		const storage = new FileSettingsStorage(resolvedCwd, resolvedAgentDir);
		return SettingsManager.fromStorageWithPaths(storage, options, {
			global: join(resolvedAgentDir, "settings.json"),
			project: join(resolvedCwd, CONFIG_DIR_NAME, "settings.json"),
		});
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}): SettingsManager {
		return SettingsManager.fromStorageWithPaths(storage, options);
	}

	/** Create a manager while retaining optional file paths for reported storage errors. */
	private static fromStorageWithPaths(
		storage: SettingsStorage,
		options: SettingsManagerCreateOptions,
		settingsPaths: SettingsPaths = {},
	): SettingsManager {
		const projectTrusted = options.projectTrusted ?? true;
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project", projectTrusted);
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push(toSettingsError("global", globalLoad.error, settingsPaths.global));
		}
		if (projectLoad.error) {
			initialErrors.push(toSettingsError("project", projectLoad.error, settingsPaths.project));
		}

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			projectTrusted,
			settingsPaths,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = SettingsManager.migrateSettings(structuredClone(settings) as Record<string, unknown>);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage, options);
	}

	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope, projectTrusted = true): Settings {
		if (scope === "project" && !projectTrusted) {
			return {};
		}

		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		if (!content) {
			return {};
		}
		const settings = JSON.parse(stripBom(content));
		return SettingsManager.migrateSettings(settings);
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): { settings: Settings; error: Error | null } {
		try {
			return { settings: SettingsManager.loadFromStorage(storage, scope, projectTrusted), error: null };
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	/** Migrate old settings format to new format */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		// Migrate queueMode -> steeringMode
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}

		// Migrate legacy websockets boolean -> transport enum
		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			settings.transport = settings.websockets ? "websocket" : "sse";
			delete settings.websockets;
		}

		// Migrate old skills object format to new array format
		if (
			"skills" in settings &&
			typeof settings.skills === "object" &&
			settings.skills !== null &&
			!Array.isArray(settings.skills)
		) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}

		// Migrate retry.maxDelayMs -> retry.provider.maxRetryDelayMs
		if (
			"retry" in settings &&
			typeof settings.retry === "object" &&
			settings.retry !== null &&
			!Array.isArray(settings.retry)
		) {
			const retrySettings = settings.retry as Record<string, unknown>;
			const providerSettings =
				typeof retrySettings.provider === "object" && retrySettings.provider !== null
					? (retrySettings.provider as Record<string, unknown>)
					: undefined;
			if (
				typeof retrySettings.maxDelayMs === "number" &&
				(providerSettings?.maxRetryDelayMs === undefined || providerSettings?.maxRetryDelayMs === null)
			) {
				retrySettings.provider = {
					...(providerSettings ?? {}),
					maxRetryDelayMs: retrySettings.maxDelayMs,
				};
			}
			delete retrySettings.maxDelayMs;
		}

		return settings as Settings;
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	isProjectTrusted(): boolean {
		return this.projectTrusted;
	}

	setProjectTrusted(trusted: boolean): void {
		if (this.projectTrusted === trusted) {
			return;
		}

		this.projectTrusted = trusted;
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		if (!trusted) {
			this.projectSettings = {};
			this.projectSettingsLoadError = null;
			this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
			return;
		}

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", trusted);
		this.projectSettings = projectLoad.settings;
		this.projectSettingsLoadError = projectLoad.error;
		if (projectLoad.error) {
			this.recordError("project", projectLoad.error);
		}
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	async reload(): Promise<void> {
		await this.writeQueue;
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", this.projectTrusted);
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}

		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void {
		this.settings = deepMergeSettings(this.settings, overrides);
	}

	/** Mark a global field as modified during this session */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** Mark a project field as modified during this session */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	private assertProjectTrustedForWrite(): void {
		if (!this.projectTrusted) {
			throw new Error("Project is not trusted; refusing to write project settings");
		}
	}

	private recordError(scope: SettingsScope, error: unknown): void {
		this.errors.push(toSettingsError(scope, error, this.settingsPaths[scope]));
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				if (scope === "project") {
					this.assertProjectTrustedForWrite();
				}
				task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current
				? SettingsManager.migrateSettings(JSON.parse(stripBom(current)) as Record<string, unknown>)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	private save(): void {
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

		if (this.globalSettingsLoadError) {
			return;
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		this.assertProjectTrustedForWrite();
		this.projectSettings = structuredClone(settings);
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

		if (this.projectSettingsLoadError) {
			return;
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private updateProjectSettings(field: keyof Settings, update: (settings: Settings) => void): void {
		this.assertProjectTrustedForWrite();
		const projectSettings = structuredClone(this.projectSettings);
		update(projectSettings);
		this.markProjectModified(field);
		this.saveProjectSettings(projectSettings);
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.globalSettings.lastChangelogVersion = version;
		this.markModified("lastChangelogVersion");
		this.save();
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		return sessionDir ? normalizePath(sessionDir) : sessionDir;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.globalSettings.defaultProvider = provider;
		this.markModified("defaultProvider");
		this.save();
	}

	setDefaultModel(modelId: string): void {
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultModel");
		this.save();
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || "one-at-a-time";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.steeringMode = mode;
		this.markModified("steeringMode");
		this.save();
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.followUpMode = mode;
		this.markModified("followUpMode");
		this.save();
	}

	getThemeSetting(): string | undefined {
		const value = this.settings.theme;
		if (typeof value === "string") return value;
		return undefined;
	}

	getTheme(): string | undefined {
		const theme = this.getThemeSetting();
		return theme?.includes("/") ? undefined : theme;
	}

	setTheme(theme: string): void {
		this.globalSettings.theme = theme;
		this.markModified("theme");
		this.save();
	}

	getDefaultThinkingLevel(): ThinkingLevel | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: ThinkingLevel): void {
		this.globalSettings.defaultThinkingLevel = level;
		this.markModified("defaultThinkingLevel");
		this.save();
	}

	getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined {
		return this.settings.modelThinkingLevels?.[`${provider}/${modelId}`];
	}

	getAllModelThinkingLevels(): Record<string, ThinkingLevel> {
		return { ...(this.settings.modelThinkingLevels ?? {}) };
	}

	setModelThinkingLevel(provider: string, modelId: string, level: ThinkingLevel): void {
		if (!this.globalSettings.modelThinkingLevels) {
			this.globalSettings.modelThinkingLevels = {};
		}
		this.globalSettings.modelThinkingLevels[`${provider}/${modelId}`] = level;
		this.markModified("modelThinkingLevels");
		this.save();
	}

	removeModelThinkingLevel(provider: string, modelId: string): void {
		if (!this.globalSettings.modelThinkingLevels) return;
		delete this.globalSettings.modelThinkingLevels[`${provider}/${modelId}`];
		if (Object.keys(this.globalSettings.modelThinkingLevels).length === 0) {
			delete this.globalSettings.modelThinkingLevels;
		}
		this.markModified("modelThinkingLevels");
		this.save();
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? "auto";
	}

	setTransport(transport: TransportSetting): void {
		this.globalSettings.transport = transport;
		this.markModified("transport");
		this.save();
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): void {
		if (!this.globalSettings.compaction) {
			this.globalSettings.compaction = {};
		}
		this.globalSettings.compaction.enabled = enabled;
		this.markModified("compaction", "enabled");
		this.save();
	}

	getCompactionReserveTokens(): number {
		return this.settings.compaction?.reserveTokens ?? 16384;
	}

	getCompactionKeepRecentTokens(): number {
		return this.settings.compaction?.keepRecentTokens ?? 20000;
	}

	getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
		};
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? false;
	}

	/**
	 * F16 master switch. When `false`, the completion gate
	 * short-circuits to `satisfied` and the runner is never invoked.
	 * Default: `true` (the audit calls for the gate to be on by default).
	 */
	getVerificationEnabled(): boolean {
		return this.settings.verification?.enabled ?? true;
	}

	setVerificationEnabled(enabled: boolean): void {
		if (!this.globalSettings.verification) {
			this.globalSettings.verification = {};
		}
		this.globalSettings.verification.enabled = enabled;
		this.markModified("verification", "enabled");
		this.save();
	}

	/**
	 * Whether the verification runner proactively re-spawns the
	 * configured checks at every `turn_end`. When `false` (the
	 * default), the runner only fires lazily — the gate still
	 * evaluates on every turn, but the underlying commands only
	 * re-run when the gate needs fresh evidence.
	 */
	getVerificationRunOnEveryTurn(): boolean {
		return this.settings.verification?.runOnEveryTurn ?? false;
	}

	setVerificationRunOnEveryTurn(runOnEveryTurn: boolean): void {
		if (!this.globalSettings.verification) {
			this.globalSettings.verification = {};
		}
		this.globalSettings.verification.runOnEveryTurn = runOnEveryTurn;
		this.markModified("verification", "runOnEveryTurn");
		this.save();
	}

	/**
	 * Path to a `.theta/verification.json` file. When `undefined`
	 * (the default), the policy loader resolves the path from the
	 * worktree's `.theta/` directory.
	 */
	getVerificationPolicyPath(): string | undefined {
		return this.settings.verification?.policyPath;
	}

	setVerificationPolicyPath(policyPath: string | undefined): void {
		if (!this.globalSettings.verification) {
			this.globalSettings.verification = {};
		}
		this.globalSettings.verification.policyPath = policyPath;
		this.markModified("verification", "policyPath");
		this.save();
	}

	/**
	 * Whether the harness is authorized to spawn policy checks through the
	 * verification runner when the gate needs fresh evidence. Default:
	 * `false`. The audit requires explicit authorization before running
	 * repository-defined commands automatically.
	 */
	getVerificationAutoRunChecks(): boolean {
		return this.settings.verification?.autoRunChecks ?? false;
	}

	setVerificationAutoRunChecks(autoRunChecks: boolean): void {
		if (!this.globalSettings.verification) {
			this.globalSettings.verification = {};
		}
		this.globalSettings.verification.autoRunChecks = autoRunChecks;
		this.markModified("verification", "autoRunChecks");
		this.save();
	}

	/**
	 * Bundle accessor. Returns the resolved F16 verification settings
	 * with defaults filled in: `enabled = true`, `runOnEveryTurn = false`,
	 * `policyPath = undefined`, `autoRunChecks = false`.
	 */
	getVerificationSettings(): {
		enabled: boolean;
		runOnEveryTurn: boolean;
		policyPath: string | undefined;
		autoRunChecks: boolean;
	} {
		return {
			enabled: this.getVerificationEnabled(),
			runOnEveryTurn: this.getVerificationRunOnEveryTurn(),
			policyPath: this.getVerificationPolicyPath(),
			autoRunChecks: this.getVerificationAutoRunChecks(),
		};
	}

	// F1 query tool

	getQueryEnabled(): boolean {
		const q = this.settings.query;
		return q?.enabled ?? q?.enabledByDefault ?? true;
	}

	setQueryEnabled(enabled: boolean): void {
		if (!this.globalSettings.query) {
			this.globalSettings.query = {};
		}
		this.globalSettings.query.enabled = enabled;
		this.markModified("query", "enabled");
		this.save();
	}

	getQueryEnabledByDefault(): boolean {
		return this.getQueryEnabled();
	}

	setQueryEnabledByDefault(enabled: boolean): void {
		this.setQueryEnabled(enabled);
	}

	getF1ReadOnlyEnabledByDefault(): boolean {
		return this.settings.query?.f1ReadOnlyByDefault ?? true;
	}

	setF1ReadOnlyEnabledByDefault(enabled: boolean): void {
		if (!this.globalSettings.query) {
			this.globalSettings.query = {};
		}
		this.globalSettings.query.f1ReadOnlyByDefault = enabled;
		this.markModified("query", "f1ReadOnlyByDefault");
		this.save();
	}

	// F2 context compiler

	getContextCompilerEnabled(): boolean {
		return this.settings.contextCompiler?.enabled ?? false;
	}

	setContextCompilerEnabled(enabled: boolean): void {
		if (!this.globalSettings.contextCompiler) {
			this.globalSettings.contextCompiler = {};
		}
		this.globalSettings.contextCompiler.enabled = enabled;
		this.markModified("contextCompiler", "enabled");
		this.save();
	}

	getContextCompilerCacheRenderingEnabled(): boolean {
		return this.settings.contextCompiler?.cacheRendering?.enabled ?? false;
	}

	setContextCompilerCacheRenderingEnabled(enabled: boolean): void {
		if (!this.globalSettings.contextCompiler) {
			this.globalSettings.contextCompiler = {};
		}
		if (!this.globalSettings.contextCompiler.cacheRendering) {
			this.globalSettings.contextCompiler.cacheRendering = {};
		}
		this.globalSettings.contextCompiler.cacheRendering.enabled = enabled;
		this.markModified("contextCompiler", "cacheRendering");
		this.save();
	}

	getContextCompilerCacheRendering(): {
		format: "anthropic" | "openai";
		retention: "short" | "long";
		systemPrompt: boolean;
		lastTool: boolean;
		lastMessage: boolean;
	} {
		const cr = this.settings.contextCompiler?.cacheRendering;
		const format = cr?.format ?? "anthropic";
		return {
			format: format === "openai" ? "openai" : "anthropic",
			retention: cr?.retention ?? "long",
			systemPrompt: cr?.systemPrompt ?? true,
			lastTool: cr?.lastTool ?? true,
			lastMessage: cr?.lastMessage ?? true,
		};
	}

	// F6 ExecutionPlan

	getExecutionPlanEnabled(): boolean {
		return this.settings.executionPlan?.enabled ?? false;
	}

	setExecutionPlanEnabled(enabled: boolean): void {
		if (!this.globalSettings.executionPlan) {
			this.globalSettings.executionPlan = {};
		}
		this.globalSettings.executionPlan.enabled = enabled;
		this.markModified("executionPlan", "enabled");
		this.save();
	}

	getExecutionPlanSettings(): { enabled: boolean; concurrency: number } {
		return {
			enabled: this.getExecutionPlanEnabled(),
			concurrency: this.settings.executionPlan?.concurrency ?? 4,
		};
	}

	setExecutionPlanConcurrency(concurrency: number): void {
		if (!this.globalSettings.executionPlan) {
			this.globalSettings.executionPlan = {};
		}
		this.globalSettings.executionPlan.concurrency = concurrency;
		this.markModified("executionPlan", "concurrency");
		this.save();
	}

	// F2 / F11 incremental serialization

	getF2IncrementalSerializationEnabled(): boolean {
		const v = this.settings.f2?.incrementalSerialization;
		if (v === undefined) return false;
		if (typeof v === "boolean") return v;
		return v.enabled ?? false;
	}

	setF2IncrementalSerializationEnabled(enabled: boolean): void {
		if (!this.globalSettings.f2) {
			this.globalSettings.f2 = {};
		}
		this.globalSettings.f2.incrementalSerialization = { enabled };
		this.markModified("f2", "incrementalSerialization");
		this.save();
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.enabled = enabled;
		this.markModified("retry", "enabled");
		this.save();
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 3,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
		};
	}

	getHttpIdleTimeoutMs(): number {
		return parseTimeoutSetting(this.settings.httpIdleTimeoutMs, "httpIdleTimeoutMs") ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	}

	setHttpIdleTimeoutMs(timeoutMs: number): void {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(timeoutMs)}`);
		}
		this.globalSettings.httpIdleTimeoutMs = Math.floor(timeoutMs);
		this.markModified("httpIdleTimeoutMs");
		this.save();
	}

	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
		return {
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			maxRetries: this.settings.retry?.provider?.maxRetries,
			maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 60000,
		};
	}

	getWebSocketConnectTimeoutMs(): number | undefined {
		return parseTimeoutSetting(this.settings.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	getShowCacheMissNotices(): boolean {
		return this.settings.showCacheMissNotices ?? false;
	}

	getExternalEditorCommand(): string {
		const configuredEditor = this.settings.externalEditor;
		if (typeof configuredEditor === "string" && configuredEditor.trim() !== "") {
			return configuredEditor;
		}
		const environmentEditor = process.env.VISUAL || process.env.EDITOR;
		if (environmentEditor) {
			return environmentEditor;
		}
		return process.platform === "win32" ? "notepad" : "nano";
	}

	setHideThinkingBlock(hide: boolean): void {
		this.globalSettings.hideThinkingBlock = hide;
		this.markModified("hideThinkingBlock");
		this.save();
	}

	setShowCacheMissNotices(show: boolean): void {
		this.globalSettings.showCacheMissNotices = show;
		this.markModified("showCacheMissNotices");
		this.save();
	}

	getShellPath(): string | undefined {
		const shellPath = this.settings.shellPath;
		return shellPath ? normalizePath(shellPath) : shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.globalSettings.shellPath = path;
		this.markModified("shellPath");
		this.save();
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? false;
	}

	setQuietStartup(quiet: boolean): void {
		this.globalSettings.quietStartup = quiet;
		this.markModified("quietStartup");
		this.save();
	}

	getDefaultProjectTrust(): DefaultProjectTrust {
		const value = this.globalSettings.defaultProjectTrust;
		return value === "always" || value === "never" ? value : "ask";
	}

	setDefaultProjectTrust(defaultProjectTrust: DefaultProjectTrust): void {
		this.globalSettings.defaultProjectTrust = defaultProjectTrust;
		this.markModified("defaultProjectTrust");
		this.save();
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.globalSettings.shellCommandPrefix = prefix;
		this.markModified("shellCommandPrefix");
		this.save();
	}

	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.globalSettings.npmCommand = command ? [...command] : undefined;
		this.markModified("npmCommand");
		this.save();
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? false;
	}

	setCollapseChangelog(collapse: boolean): void {
		this.globalSettings.collapseChangelog = collapse;
		this.markModified("collapseChangelog");
		this.save();
	}

	getEnableInstallTelemetry(): boolean {
		return this.settings.enableInstallTelemetry ?? true;
	}

	setEnableInstallTelemetry(enabled: boolean): void {
		this.globalSettings.enableInstallTelemetry = enabled;
		this.markModified("enableInstallTelemetry");
		this.save();
	}

	getEnableAnalytics(): boolean {
		return this.settings.enableAnalytics ?? false;
	}

	getTrackingId(): string | undefined {
		return this.settings.trackingId;
	}

	/** Set the analytics opt-in preference; generates a tracking identifier on first opt-in */
	setEnableAnalytics(enabled: boolean): void {
		this.globalSettings.enableAnalytics = enabled;
		this.markModified("enableAnalytics");
		if (enabled && !this.globalSettings.trackingId) {
			this.globalSettings.trackingId = randomUUID();
			this.markModified("trackingId");
		}
		this.save();
	}

	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	setPackages(packages: PackageSource[]): void {
		this.globalSettings.packages = packages;
		this.markModified("packages");
		this.save();
	}

	setProjectPackages(packages: PackageSource[]): void {
		this.updateProjectSettings("packages", (settings) => {
			settings.packages = packages;
		});
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.globalSettings.extensions = paths;
		this.markModified("extensions");
		this.save();
	}

	setProjectExtensionPaths(paths: string[]): void {
		this.updateProjectSettings("extensions", (settings) => {
			settings.extensions = paths;
		});
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.globalSettings.skills = paths;
		this.markModified("skills");
		this.save();
	}

	setProjectSkillPaths(paths: string[]): void {
		this.updateProjectSettings("skills", (settings) => {
			settings.skills = paths;
		});
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.globalSettings.prompts = paths;
		this.markModified("prompts");
		this.save();
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		this.updateProjectSettings("prompts", (settings) => {
			settings.prompts = paths;
		});
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.globalSettings.themes = paths;
		this.markModified("themes");
		this.save();
	}

	setProjectThemePaths(paths: string[]): void {
		this.updateProjectSettings("themes", (settings) => {
			settings.themes = paths;
		});
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.globalSettings.enableSkillCommands = enabled;
		this.markModified("enableSkillCommands");
		this.save();
	}

	/**
	 * F9 selective skills catalog: token budget for the visible skill
	 * catalog in the system prompt. `undefined` keeps the full catalog.
	 */
	getSkillsCatalogBudgetTokens(): number | undefined {
		return this.settings.skillsCatalogBudgetTokens;
	}

	setSkillsCatalogBudgetTokens(budget: number | undefined): void {
		if (budget === undefined) {
			delete this.globalSettings.skillsCatalogBudgetTokens;
		} else {
			if (!Number.isFinite(budget) || budget < 0) {
				throw new Error(`skillsCatalogBudgetTokens must be a non-negative finite number, got ${budget}`);
			}
			this.globalSettings.skillsCatalogBudgetTokens = budget;
		}
		this.markModified("skillsCatalogBudgetTokens");
		this.save();
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getTerminalCapabilityOverrides(): Partial<TerminalCapabilities> {
		const terminal = this.settings.terminal;
		const images = terminal?.images;
		return {
			...(images === "kitty" || images === "iterm2" ? { images } : images === false ? { images: null } : {}),
			...(typeof terminal?.trueColor === "boolean" ? { trueColor: terminal.trueColor } : {}),
			...(typeof terminal?.hyperlinks === "boolean" ? { hyperlinks: terminal.hyperlinks } : {}),
		};
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showImages = show;
		this.markModified("terminal", "showImages");
		this.save();
	}

	getImageWidthCells(): number {
		const width = this.settings.terminal?.imageWidthCells;
		if (typeof width !== "number" || !Number.isFinite(width)) {
			return 60;
		}
		return Math.max(1, Math.floor(width));
	}

	setImageWidthCells(width: number): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.imageWidthCells = Math.max(1, Math.floor(width));
		this.markModified("terminal", "imageWidthCells");
		this.save();
	}

	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return process.env.PI_CLEAR_ON_SHRINK === "1";
	}

	setClearOnShrink(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.clearOnShrink = enabled;
		this.markModified("terminal", "clearOnShrink");
		this.save();
	}

	getShowTerminalProgress(): boolean {
		return this.settings.terminal?.showTerminalProgress ?? false;
	}

	setShowTerminalProgress(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showTerminalProgress = enabled;
		this.markModified("terminal", "showTerminalProgress");
		this.save();
	}

	getTuiMode(): TuiMode {
		return this.settings.tuiMode === "fullscreen" ? "fullscreen" : "regular";
	}

	setTuiMode(mode: TuiMode): void {
		this.globalSettings.tuiMode = mode;
		this.markModified("tuiMode");
		this.save();
	}

	getFullscreenExitOutput(): FullscreenExitOutput {
		return this.settings.fullscreenExitOutput === "resume-hint" ? "resume-hint" : "transcript";
	}

	setFullscreenExitOutput(output: FullscreenExitOutput): void {
		this.globalSettings.fullscreenExitOutput = output;
		this.markModified("fullscreenExitOutput");
		this.save();
	}

	getFullscreenScrollbar(): ScrollViewScrollbar {
		const mode = this.settings.fullscreenScrollbar;
		return mode === "always" || mode === "hidden" ? mode : "auto";
	}

	setFullscreenScrollbar(mode: ScrollViewScrollbar): void {
		this.globalSettings.fullscreenScrollbar = mode;
		this.markModified("fullscreenScrollbar");
		this.save();
	}

	getFullscreenCopyOnSelect(): boolean {
		return this.settings.fullscreenCopyOnSelect ?? true;
	}

	setFullscreenCopyOnSelect(enabled: boolean): void {
		this.globalSettings.fullscreenCopyOnSelect = enabled;
		this.markModified("fullscreenCopyOnSelect");
		this.save();
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.autoResize = enabled;
		this.markModified("images", "autoResize");
		this.save();
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	setBlockImages(blocked: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.blockImages = blocked;
		this.markModified("images", "blockImages");
		this.save();
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	getDefaultTools(): string[] | undefined {
		const tools = this.settings.defaultTools;
		return tools ? [...tools] : undefined;
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.globalSettings.enabledModels = patterns;
		this.markModified("enabledModels");
		this.save();
	}

	getDoubleEscapeAction(): "fork" | "tree" | "none" {
		return this.settings.doubleEscapeAction ?? "tree";
	}

	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
		this.globalSettings.doubleEscapeAction = action;
		this.markModified("doubleEscapeAction");
		this.save();
	}

	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		const mode = this.settings.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		return mode && valid.includes(mode) ? mode : "default";
	}

	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		this.globalSettings.treeFilterMode = mode;
		this.markModified("treeFilterMode");
		this.save();
	}

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? process.env.PI_HARDWARE_CURSOR === "1";
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.globalSettings.showHardwareCursor = enabled;
		this.markModified("showHardwareCursor");
		this.save();
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? 0;
	}

	setEditorPaddingX(padding: number): void {
		this.globalSettings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		this.markModified("editorPaddingX");
		this.save();
	}

	getOutputPad(): 0 | 1 {
		return this.settings.outputPad === 0 ? 0 : 1;
	}

	setOutputPad(padding: 0 | 1): void {
		this.globalSettings.outputPad = padding;
		this.markModified("outputPad");
		this.save();
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? 5;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.globalSettings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		this.markModified("autocompleteMaxVisible");
		this.save();
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? "  ";
	}

	getMermaidRenderingMode(): MermaidRenderingMode {
		const mode = this.settings.markdown?.mermaid;
		return mode === "off" || mode === "final" ? mode : "streaming";
	}

	setMermaidRenderingMode(mode: MermaidRenderingMode): void {
		this.globalSettings.markdown ??= {};
		this.globalSettings.markdown.mermaid = mode;
		this.markModified("markdown", "mermaid");
		this.save();
	}

	getWarnings(): WarningSettings {
		return { ...(this.settings.warnings ?? {}) };
	}

	setWarnings(warnings: WarningSettings): void {
		this.globalSettings.warnings = { ...warnings };
		this.markModified("warnings");
		this.save();
	}

	/**
	 * Whether the F1 syntax index prefers tree-sitter-backed
	 * extraction over the regex fallback. When false, every file is
	 * processed by the regex extractors even if a tree-sitter
	 * grammar is registered for the file's language. When true (the
	 * default), the dispatcher uses tree-sitter for languages that
	 * have a registered grammar and silently falls back to regex
	 * elsewhere.
	 */
	getRepositoryTreeSitterEnabled(): boolean {
		return this.settings.queryTreeSitter?.enabled ?? true;
	}

	setRepositoryTreeSitterEnabled(enabled: boolean): void {
		if (!this.globalSettings.queryTreeSitter) {
			this.globalSettings.queryTreeSitter = {};
		}
		this.globalSettings.queryTreeSitter.enabled = enabled;
		this.markModified("queryTreeSitter", "enabled");
		this.save();
	}

	/**
	 * Whether the F1 LSP-backed semantic query layer is enabled. When
	 * true (the default), the live data layer probes the worktree for
	 * a usable language server and binds the `LspAdapter` when one is
	 * found. When false, the probe is skipped and the layer falls
	 * straight through to the in-process `typescript-ls` or the
	 * mock. Default: `true` (the audit calls for the real language
	 * server to be used when one is on `PATH`).
	 */
	getRepositoryLspEnabled(): boolean {
		return this.settings.repository?.lsp?.enabled ?? true;
	}

	setRepositoryLspEnabled(enabled: boolean): void {
		if (!this.globalSettings.repository) {
			this.globalSettings.repository = {};
		}
		if (!this.globalSettings.repository.lsp) {
			this.globalSettings.repository.lsp = {};
		}
		this.globalSettings.repository.lsp.enabled = enabled;
		// The settings writer only tracks a single nested key per
		// `markModified` call. Marking `repository.lsp` is enough
		// for the in-session check; the write-out uses the deep
		// merge of `this.globalSettings` so the new value lands
		// on disk.
		this.markModified("repository", "lsp");
		this.save();
	}

	/**
	 * Returns the full `repository.lsp` settings block. The tree-sitter
	 * subagent may read the same shape for its own settings; today
	 * only `lsp` is consumed by this layer.
	 */
	getRepositorySettings(): { lsp: { enabled: boolean }; treeSitter: { enabled: boolean } } {
		return {
			lsp: { enabled: this.getRepositoryLspEnabled() },
			treeSitter: { enabled: this.getRepositoryTreeSitterEnabled() },
		};
	}
}

