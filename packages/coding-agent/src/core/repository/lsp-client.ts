/**
 * F1 LSP backend — JSON-RPC client.
 *
 * Wraps `vscode-jsonrpc`'s `MessageConnection` and `StreamMessageReader` /
 * `StreamMessageWriter` to drive an LSP server over stdio. The audit
 * (Section 11.3 "API design") calls for the F1 semantic query layer
 * to be backed by a real language server when one is on `PATH`. This
 * file is the layer the `LspAdapter` and `LspManager` build on top of.
 *
 * Public surface:
 *
 *   - `LspClient.connect(options)` — spawn the server, send
 *     `initialize` / `initialized`, return a usable client.
 *   - `client.request(method, params)` — typed JSON-RPC request with
 *     `CancellationToken`.
 *   - `client.notify(method, params)` — JSON-RPC notification.
 *   - `client.didOpen / didChange / didClose` — convenience wrappers
 *     for the standard document-sync notifications.
 *   - `client.onNotification(method, handler)` — subscribe to a
 *     server-pushed notification.
 *   - `client.shutdown()` / `client.exit()` — graceful shutdown.
 *
 * Error policy: any spawn / framing / LSP error throws an
 * `LspClientError`. The `LspAdapter` translates these into
 * `certainty: "unknown"` results so the audit never sees a
 * silent placeholder.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	type CancellationToken,
	CancellationTokenSource,
	createMessageConnection,
	type MessageConnection,
} from "vscode-jsonrpc/node";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface LspClientOptions {
	/** Executable to spawn. Resolved by `resolveLspServer` upstream. */
	command: string;
	/** Argv to pass. */
	args: string[];
	/** Working directory of the server process. */
	cwd?: string;
	/** Environment merged into the spawn env. */
	env?: Record<string, string>;
	/** Forwarded as `rootUri` / `workspaceFolders` in `initialize`. */
	rootUri: string;
	/** Forwarded as `processId`. */
	processId?: number;
	/** `initializationOptions` payload. */
	initializationOptions?: Record<string, unknown>;
	/** Milliseconds to wait for `initialize` to come back. Default 30_000. */
	initializeTimeoutMs?: number;
	/** Milliseconds to wait for any other request. Default 30_000. */
	requestTimeoutMs?: number;
}

/**
 * Minimal subset of LSP capabilities the client advertises. Real
 * language servers only check the keys they care about, so we keep
 * this list narrow on purpose. Anything we omit falls back to the
 * LSP spec default of "not supported".
 */
export interface LspClientCapabilities {
	textDocument?: {
		synchronization?: {
			didSave?: boolean;
			willSave?: boolean;
			dynamicRegistration?: boolean;
		};
		publishDiagnostics?: {
			relatedInformation?: boolean;
		};
		definition?: { linkSupport?: boolean };
		references?: Record<string, never>;
		implementation?: Record<string, never>;
		callHierarchy?: Record<string, never>;
		diagnostic?: { dynamicRegistration?: boolean };
	};
	workspace?: {
		workspaceFolders?: boolean;
		configuration?: boolean;
	};
}

export interface DidOpenParams {
	textDocument: { uri: string; languageId: string; version: number; text: string };
}

export interface DidChangeParams {
	textDocument: { uri: string; version: number };
	contentChanges: Array<{ text: string }>;
}

export interface DidCloseParams {
	textDocument: { uri: string };
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export class LspClientError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "LspClientError";
		this.code = code;
	}
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A connected LSP client. Owns the child process and the
 * `MessageConnection`; dispose with `shutdown()` + `exit()` to release
 * the resources.
 */
export class LspClient {
	private readonly child: ChildProcess;
	private readonly connection: MessageConnection;
	private readonly rootUri: string;
	private readonly rootPath: string;
	private readonly initializeTimeoutMs: number;
	private readonly requestTimeoutMs: number;
	private readonly capabilities: LspClientCapabilities;
	private readonly openDocuments = new Map<string, number>(); // uri -> version
	private disposed = false;

	private constructor(
		child: ChildProcess,
		connection: MessageConnection,
		rootUri: string,
		rootPath: string,
		initializeTimeoutMs: number,
		requestTimeoutMs: number,
		capabilities: LspClientCapabilities,
	) {
		this.child = child;
		this.connection = connection;
		this.rootUri = rootUri;
		this.rootPath = rootPath;
		this.initializeTimeoutMs = initializeTimeoutMs;
		this.requestTimeoutMs = requestTimeoutMs;
		this.capabilities = capabilities;
	}

	/** The `rootUri` passed to `initialize`. */
	get rootUriString(): string {
		return this.rootUri;
	}

	/** The working directory the server was spawned in (filesystem path). */
	get root(): string {
		return this.rootPath;
	}

	/**
	 * Connect to an LSP server. Spawns the child, runs the
	 * `initialize` / `initialized` handshake, and returns a ready
	 * client. Throws `LspClientError` on spawn failure or timeout.
	 */
	static async connect(options: LspClientOptions): Promise<LspClient> {
		const child = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: { ...process.env, ...(options.env ?? {}) },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});

		// `spawn` resolves `error` asynchronously on ENOENT etc. If
		// the child fails to spawn, we tear the connection down so
		// the caller never sees a half-open pipe.
		const spawnFailure = new Promise<never>((_, reject) => {
			child.once("error", (err) => {
				reject(new LspClientError("spawn-failed", `LSP server ${options.command} failed to start: ${err.message}`));
			});
		});

		const connection = createMessageConnection(
			// `vscode-jsonrpc`'s `StreamMessageReader` accepts any
			// `NodeJS.ReadableStream`. The cast keeps the public
			// API narrow (a `Readable` is structurally what
			// `childProcess.stdout` is).
			child.stdout as unknown as NodeJS.ReadableStream,
			child.stdin as unknown as NodeJS.WritableStream,
		);

		const client = new LspClient(
			child,
			connection,
			options.rootUri,
			options.cwd ?? process.cwd(),
			options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
			options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			defaultCapabilities(),
		);

		try {
			await Promise.race([
				client.initialize(options),
				new Promise<never>((_, reject) =>
					setTimeout(
						() =>
							reject(
								new LspClientError(
									"initialize-timeout",
									`LSP server did not respond to initialize within ${client.initializeTimeoutMs}ms`,
								),
							),
						client.initializeTimeoutMs,
					),
				),
				spawnFailure,
			]);
		} catch (err) {
			connection.dispose();
			if (!child.killed) child.kill();
			throw err;
		}

		// Surface child exit as a fatal error so any in-flight request
		// fails fast rather than hanging.
		child.once("exit", (code, signal) => {
			if (code !== 0 && !client.disposed) {
				connection.dispose();
			}
			// Reference unused to keep the linter quiet about the
			// `signal` argument — we only act on the `code` above but
			// the listener still needs both.
			void signal;
		});

		return client;
	}

	/* ----------------------------- low-level API ----------------------------- */

	/**
	 * Send a JSON-RPC request. `params` may be `undefined` for
	 * parameter-less methods. `token` is honored through
	 * `vscode-jsonrpc`'s built-in cancellation; the client
	 * automatically sends `$/cancelRequest` on cancel.
	 */
	async request<T = unknown>(method: string, params?: unknown, token?: CancellationToken): Promise<T> {
		if (this.disposed) {
			throw new LspClientError("disposed", "LspClient is disposed");
		}
		const cts = token ? undefined : new CancellationTokenSource();
		const effective = token ?? cts?.token;
		try {
			const timeout = new Promise<never>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new LspClientError(
								"request-timeout",
								`LSP request ${method} timed out after ${this.requestTimeoutMs}ms`,
							),
						),
					this.requestTimeoutMs,
				),
			);
			return await Promise.race([
				this.connection.sendRequest<T>(method, params as never, effective as CancellationToken),
				timeout,
			]);
		} finally {
			cts?.dispose();
		}
	}

	/** Send a JSON-RPC notification. Fire-and-forget. */
	async notify(method: string, params?: unknown): Promise<void> {
		if (this.disposed) {
			throw new LspClientError("disposed", "LspClient is disposed");
		}
		await this.connection.sendNotification(method, params as never);
	}

	/** Subscribe to a server-pushed notification by method name. */
	onNotification(method: string, handler: (params: unknown) => void): { dispose(): void } {
		const disposable = this.connection.onNotification(method, (params: unknown) => {
			try {
				handler(params);
			} catch {
				// Handlers are observers. Swallow their errors so a
				// single bad consumer does not break the framing loop.
			}
		});
		return { dispose: () => disposable.dispose() };
	}

	/* ------------------------- document sync helpers ------------------------- */

	/**
	 * `textDocument/didOpen` for the given file. Tracks the version
	 * internally so subsequent `didChange` calls do not have to.
	 */
	async didOpen(uri: string, text: string, languageId: string, version?: number): Promise<void> {
		const v = version ?? (this.openDocuments.get(uri) ?? 0) + 1;
		this.openDocuments.set(uri, v);
		await this.notify("textDocument/didOpen", {
			textDocument: { uri, languageId, version: v, text },
		} satisfies DidOpenParams);
	}

	/**
	 * `textDocument/didChange` for the given file. The adapter is
	 * responsible for sending the full document text — incremental
	 * `contentChanges` would require us to track the server's
	 * understanding of the file, which the audit does not require.
	 */
	async didChange(uri: string, text: string, version?: number): Promise<void> {
		const current = this.openDocuments.get(uri);
		const v = version ?? (current ?? 0) + 1;
		this.openDocuments.set(uri, v);
		await this.notify("textDocument/didChange", {
			textDocument: { uri, version: v },
			contentChanges: [{ text }],
		} satisfies DidChangeParams);
	}

	/**
	 * `textDocument/didClose` for the given file. Removes the
	 * version from the open-documents map so a subsequent `didOpen`
	 * starts a fresh sequence.
	 */
	async didClose(uri: string): Promise<void> {
		this.openDocuments.delete(uri);
		await this.notify("textDocument/didClose", { textDocument: { uri } } satisfies DidCloseParams);
	}

	/** Whether the file is currently open in the server. */
	isOpen(uri: string): boolean {
		return this.openDocuments.has(uri);
	}

	/* ------------------------------- shutdown ------------------------------- */

	/**
	 * LSP `shutdown` + `exit` sequence. Safe to call multiple times.
	 * Does not throw — cleanup errors are swallowed so a caller
	 * in a `finally` block does not mask a more interesting error.
	 */
	async shutdown(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		try {
			// `shutdown` is a request; `exit` is a notification.
			try {
				await Promise.race([
					this.connection.sendRequest("shutdown", undefined),
					new Promise((resolve) => setTimeout(resolve, 2_000)),
				]);
			} catch {
				// Some servers reject `shutdown` once they have
				// already exited; treat any error as a no-op.
			}
			try {
				await this.connection.sendNotification("exit", undefined);
			} catch {
				// Same as above.
			}
		} finally {
			this.connection.dispose();
			if (!this.child.killed) {
				this.child.kill();
			}
		}
	}

	/** Synonym for `shutdown()` — matches the `LspManager` call site. */
	async exit(): Promise<void> {
		return this.shutdown();
	}

	/* ----------------------------- internals -------------------------------- */

	private async initialize(options: LspClientOptions): Promise<void> {
		this.connection.listen();
		const initParams = {
			processId: options.processId ?? process.pid,
			clientInfo: { name: "theta", version: "0.85.1" },
			locale: "en",
			rootUri: options.rootUri,
			workspaceFolders: [
				{
					uri: options.rootUri,
					name: fileURLToPathSafe(options.rootUri),
				},
			],
			capabilities: this.capabilities,
			initializationOptions: options.initializationOptions ?? {},
			// The audit's 11.3 "API design" section calls for
			// `trace` set to "off" so language servers do not flood
			// our logs by default.
			trace: "off",
		};
		await this.connection.sendRequest("initialize", initParams);
		await this.connection.sendNotification("initialized", {});
	}
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function defaultCapabilities(): LspClientCapabilities {
	return {
		textDocument: {
			synchronization: { didSave: true, willSave: false, dynamicRegistration: false },
			publishDiagnostics: { relatedInformation: true },
			definition: { linkSupport: true },
			references: {},
			implementation: {},
			callHierarchy: {},
			diagnostic: { dynamicRegistration: false },
		},
		workspace: { workspaceFolders: true, configuration: false },
	};
}

function fileURLToPathSafe(uri: string): string {
	try {
		return fileURLToPath(uri);
	} catch {
		// A non-`file://` URI is fine for the workspace folder name.
		return uri;
	}
}

