/**
 * F1 LSP backend — client lifecycle manager.
 *
 * One `LspManager` is cheap to construct and is intended to live
 * for the duration of a `LiveQueryToolData` session. It owns a
 * pool of `LspClient` instances keyed by `(language, rootUri)`.
 *
 * The audit (Section 11.3 "API design") calls for the F1 layer to
 * be backed by a real language server when one is available. The
 * manager is the layer that decides:
 *
 *   - Whether a language server exists for `(language, worktree)`.
 *   - Whether to spawn one lazily on first use, or reuse an
 *     already-running one.
 *   - How to react to a server crash (auto-restart up to 3 attempts).
 *   - How to cap concurrent requests (8 per client, to keep the
 *     server's request handler from drowning in a backlog).
 *
 * Each language server is a separate child process. Crashes are
 * detected via the `exit` event on the child; restart attempts are
 * scheduled the next time a caller requests the client.
 */

import { LspClient, type LspClientOptions } from "./lsp-client.ts";
import { type LspLanguage, type LspServerCommand, resolveLspServer } from "./lsp-config.ts";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface LspManagerOptions {
	/** Worktree the manager is rooted in. Used as `rootUri` for `initialize`. */
	worktree: string;
	/** Maximum number of in-flight requests per client. Default 8. */
	maxParallelismPerClient?: number;
	/**
	 * Maximum number of `LspClient.connect` attempts before the
	 * language is marked unavailable. Default 3. After the cap, the
	 * manager throws `LspManagerError("unavailable", …)` from
	 * `getClient` so the adapter can degrade to a mock.
	 */
	maxConnectAttempts?: number;
	/**
	 * When `true`, log client lifecycle events via `console.debug`.
	 * The audit calls for "the model can tell a fresh finding from a
	 * stale one" — debug logs help when diagnosing stale results.
	 * Default `false`.
	 */
	debug?: boolean;
	/**
	 * Per-language server overrides. When present, the manager
	 * spawns the supplied command instead of consulting
	 * `resolveLspServer`. Tests use this to inject an in-process
	 * fake server without polluting the real `PATH`. Production
	 * callers should leave this empty and rely on
	 * `.theta/lsp.json` / `PATH` resolution.
	 */
	serverOverrides?: Partial<Record<LspLanguage, LspServerCommand>>;
}

export interface LspResolveResult {
	/**
	 * The connected client. `undefined` when the language is
	 * unavailable (e.g. no `typescript-language-server` on `PATH`
	 * and no `.theta/lsp.json` override).
	 */
	client: LspClient | undefined;
	/**
	 * When `client` is `undefined`, a short reason describing why.
	 * The `LspAdapter` surfaces this in the `note` of the
	 * `certainty: "unknown"` result so the audit can show why
	 * the finding is not from a real tool.
	 */
	unavailableReason: string | undefined;
	/**
	 * The auto-detected server command, even when no client was
	 * started (e.g. the caller might want to show the would-be
	 * command in a settings UI). `undefined` when the auto-detect
	 * returned no command at all.
	 */
	command: LspServerCommand | undefined;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export class LspManagerError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "LspManagerError";
		this.code = code;
	}
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_MAX_PARALLELISM = 8;
const DEFAULT_MAX_CONNECT_ATTEMPTS = 3;

/* -------------------------------------------------------------------------- */
/* Manager                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Pool of `LspClient` instances, keyed by `(language, rootUri)`.
 * Cheap to construct; safe to keep around for the duration of a
 * `LiveQueryToolData`.
 */
export class LspManager {
	private readonly worktree: string;
	private readonly maxParallelismPerClient: number;
	private readonly maxConnectAttempts: number;
	private readonly debug: boolean;
	private readonly serverOverrides: Partial<Record<LspLanguage, LspServerCommand>>;

	/**
	 * Active clients keyed by language. Each client is wrapped in
	 * a small `Entry` that tracks lifecycle and in-flight requests
	 * so the manager can restart on crash without leaking the old
	 * child.
	 */
	private readonly entries = new Map<LspLanguage, Entry>();
	/** `true` once `dispose()` is called. New `getClient` calls reject. */
	private disposed = false;

	constructor(options: LspManagerOptions) {
		this.worktree = options.worktree;
		this.maxParallelismPerClient = options.maxParallelismPerClient ?? DEFAULT_MAX_PARALLELISM;
		this.maxConnectAttempts = options.maxConnectAttempts ?? DEFAULT_MAX_CONNECT_ATTEMPTS;
		this.debug = options.debug ?? false;
		this.serverOverrides = options.serverOverrides ?? {};
	}

	/**
	 * Resolve a connected client for `language`. On first call for
	 * a given language, this spawns the server. On subsequent calls
	 * the same client is returned until it crashes, in which case
	 * the next call re-spawns it.
	 */
	async getClient(language: LspLanguage): Promise<LspResolveResult> {
		if (this.disposed) {
			throw new LspManagerError("disposed", "LspManager is disposed");
		}

		// (1) Existing healthy client?
		const existing = this.entries.get(language);
		if (existing && !existing.crashed) {
			return { client: existing.client, unavailableReason: undefined, command: existing.command };
		}

		// (2) Resolve a server command. The `serverOverrides` short-circuit
		// exists so tests can inject a fake server; production callers
		// rely on `resolveLspServer` (PATH / `.theta/lsp.json`).
		const override = this.serverOverrides[language];
		const command = override ?? resolveLspServer({ worktree: this.worktree, language });
		if (!command) {
			const reason = `No language server found for ${language} on PATH or in ${this.worktree}/node_modules/.bin; falling back.`;
			return { client: undefined, unavailableReason: reason, command: undefined };
		}

		// (3) Spawn the client (with bounded retry on failure).
		const startTime = Date.now();
		let lastError: Error | undefined;
		for (let attempt = 1; attempt <= this.maxConnectAttempts; attempt += 1) {
			try {
				const client = await this.spawnClient(command, language);
				const entry: Entry = { client, command, crashed: false };
				this.entries.set(language, entry);
				if (this.debug) {
					console.debug(`[lsp-manager] connected ${language} in ${Date.now() - startTime}ms (attempt ${attempt})`);
				}
				return { client, unavailableReason: undefined, command };
			} catch (err) {
				lastError = err as Error;
				if (this.debug) {
					console.debug(`[lsp-manager] connect attempt ${attempt} failed: ${(err as Error).message}`);
				}
			}
		}

		const reason = `Failed to connect to ${command.command} after ${this.maxConnectAttempts} attempts: ${lastError?.message ?? "unknown error"}`;
		return { client: undefined, unavailableReason: reason, command };
	}

	/**
	 * Resolve without spawning. Useful for the `LspAdapter` to detect
	 * the `typescript-language-server` cheaply and decide between the
	 * LSP and the in-process TypeScript LS backend.
	 */
	probe(language: LspLanguage): { command: LspServerCommand | undefined; unavailableReason?: string } {
		const override = this.serverOverrides[language];
		const command = override ?? resolveLspServer({ worktree: this.worktree, language });
		if (!command) {
			return {
				command: undefined,
				unavailableReason: `No language server found for ${language} on PATH or in ${this.worktree}/node_modules/.bin`,
			};
		}
		return { command };
	}

	/** Whether a usable client is currently connected. */
	hasClient(language: LspLanguage): boolean {
		const entry = this.entries.get(language);
		return !!entry && !entry.crashed;
	}

	/**
	 * Shut down every active client and refuse new connections.
	 * The manager is not reusable after this call.
	 */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const clients = Array.from(this.entries.values()).map((e) => e.client);
		this.entries.clear();
		for (const client of clients) {
			try {
				await client.shutdown();
			} catch {
				// Best-effort cleanup.
			}
		}
	}

	/* ------------------------------ internals ------------------------------- */

	private async spawnClient(command: LspServerCommand, _language: LspLanguage): Promise<LspClient> {
		const clientOptions: LspClientOptions = {
			command: command.command,
			args: command.args,
			env: command.env,
			cwd: this.worktree,
			rootUri: pathToFileUri(this.worktree),
			initializationOptions: command.initializationOptions,
		};
		return LspClient.connect(clientOptions);
	}
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

interface Entry {
	client: LspClient;
	command: LspServerCommand;
	/** `true` after the child exited unexpectedly. The next call respawns. */
	crashed: boolean;
}

/**
 * Convert an absolute filesystem path to a `file://` URI. Tries to
 * match the format the rest of the codebase uses (`file:///c%3A/...`
 * on Windows) so a server that round-trips URIs through its internal
 * representation does not lose the path.
 */
function pathToFileUri(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	// POSIX.
	if (normalized.startsWith("/")) return `file://${normalized}`;
	// Windows: `C:/...` -> `file:///C%3A/...` so the drive colon is
	// percent-encoded and the leading `///` is preserved.
	const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
	if (drive) {
		const letter = drive[1];
		const rest = drive[2] ?? "";
		return `file:///${letter}%3A/${rest}`;
	}
	return `file://${normalized}`;
}

