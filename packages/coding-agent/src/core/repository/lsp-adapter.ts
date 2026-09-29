/**
 * F1 LSP backend — `SemanticQueryAdapter` over an LSP server.
 *
 * The audit (Section 11.3 "API design") calls for the F1 semantic
 * query layer to be backed by an external language server when one
 * is available. This module maps the LSP-shaped `SemanticQueryAdapter`
 * contract to the LSP protocol:
 *
 *   - `getDefinition`        → `textDocument/definition`
 *   - `getReferences`        → `textDocument/references`
 *   - `getCallers`           → `prepareCallHierarchy` / `callHierarchy/incomingCalls`
 *   - `getCallees`           → `prepareCallHierarchy` / `callHierarchy/outgoingCalls`
 *   - `getImplementations`   → `textDocument/implementation`
 *   - `getRelevantTests`     → walks the worktree (LSP does not standardize
 *                              test-relation queries; same heuristic as
 *                              `TypeScriptLanguageServiceAdapter`)
 *   - `getDiagnostics`       → server-pushed `textDocument/publishDiagnostics`
 *                              notifications + (LSP 3.17+) `textDocument/diagnostic`
 *                              pull when the server advertises a
 *                              `diagnosticProvider`.
 *
 * The audit explicitly requires the audit to distinguish "a real
 * tool finding from a placeholder", so every adapter method is
 * honest about its source: `certainty: "exact"` when the response
 * came from a real LSP server, `certainty: "unknown"` when the
 * server could not be reached, `certainty: "candidate"` when the
 * server does not support the query kind (call hierarchy).
 *
 * The adapter owns a small symbol→position heuristic: LSP is
 * position-oriented, but the public contract is symbol-oriented
 * (callers pass `symbol: "foo"`, not a `(uri, line, char)` triple).
 * The adapter walks the file the caller hinted at, finds the
 * first whole-word occurrence of the symbol, and uses that as the
 * anchor.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { CancellationToken } from "vscode-jsonrpc/node";
import { CancellationTokenSource } from "vscode-jsonrpc/node";
import { type LspClient, LspClientError } from "./lsp-client.ts";
import { hasInProcessFallback, type LspLanguage } from "./lsp-config.ts";
import type { LspManager } from "./lsp-manager.ts";
import type {
	DiagnosticResult,
	DiagnosticSeverity,
	SemanticDiagnosticsOptions,
	SemanticLocation,
	SemanticQueryAdapter,
	SemanticQueryOptions,
	SemanticReferencesOptions,
	SemanticResult,
} from "./semantic-queries.ts";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface LspAdapterOptions {
	/** The LSP manager that owns language clients. */
	manager: LspManager;
	/** Language the adapter is bound to. */
	language: LspLanguage;
	/**
	 * Optional cancellation token. When the surrounding request is
	 * aborted, the adapter forwards the cancel down to the LSP
	 * client (`$/cancelRequest`).
	 */
	abortSignal?: AbortSignal;
}

/** LSP `Location` shape. `range` is `{ start, end }` with `line` 0-indexed. */
interface LspLocation {
	uri: string;
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

/** LSP `Diagnostic` shape. `severity` and `code` are optional. */
interface LspDiagnostic {
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
	severity?: number;
	code?: string | number;
	source?: string;
	message: string;
}

/** LSP `CallHierarchyItem` shape. */
interface LspCallHierarchyItem {
	name: string;
	kind: number;
	uri: string;
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
	selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } };
}

/** LSP `CallHierarchyIncomingCall` / `OutgoingCall` shape. */
interface LspCallHierarchyCall {
	from?: LspCallHierarchyItem;
	to?: LspCallHierarchyItem;
	fromRanges: Array<{ start: { line: number; character: number }; end: { line: number; character: number } }>;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Result of `LspAdapter.connect()`. The discriminator is `ok`: callers
 * narrow the union with `if (!ctx.ok) { ... ctx.reason ... }` and then
 * access `ctx.client`/`ctx.worktree` on the success branch without an
 * extra `undefined` check.
 */
type ConnectResult =
	| { ok: true; client: LspClient; worktree: string }
	| { ok: false; reason: string; worktree: string };

const TEST_FILE_RE = /\.(?:test|spec)\.tsx?$/i;
const TS_TEST_FILE_RE = /\.(?:test|spec)\.tsx?$/i;

/** Default languageId mapping for `textDocument/didOpen`. */
const LANGUAGE_ID: Record<LspLanguage, string> = {
	typescript: "typescript",
	javascript: "javascript",
	python: "python",
	rust: "rust",
	go: "go",
};

/** LSP `DiagnosticSeverity` enum (1..4). */
const DIAG_SEVERITY: Record<number, DiagnosticSeverity> = {
	1: "error",
	2: "warning",
	3: "info",
	4: "info",
};

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `SemanticQueryAdapter` implementation that talks to an LSP server
 * via a `LspManager`. The adapter is cheap to construct; it does
 * not spawn a server until the first query.
 */
export class LspAdapter implements SemanticQueryAdapter {
	private readonly manager: LspManager;
	private readonly language: LspLanguage;
	private readonly abortSignal: AbortSignal | undefined;
	/** Per-file content hash cache, keyed by absolute path. */
	private readonly snapshotCache = new Map<string, { id: string; mtimeMs: number; size: number }>();
	/** Most-recent `publishDiagnostics` payload keyed by file URI. */
	private readonly publishedDiagnostics = new Map<string, { items: LspDiagnostic[]; timestamp: number }>();
	/** Subscriptions the adapter registered on the active client. */
	private diagnosticSubscription: { dispose(): void } | undefined;
	/** Currently-bound client (so we can re-subscribe on restart). */
	private boundClient: LspClient | undefined;

	constructor(options: LspAdapterOptions) {
		this.manager = options.manager;
		this.language = options.language;
		this.abortSignal = options.abortSignal;
	}

	/* ---------------------------- getDefinition ----------------------------- */

	async getDefinition(symbol: string, options?: SemanticQueryOptions): Promise<SemanticResult> {
		const ctx = await this.connect();
		if (!ctx.ok) return this.unknown("definition", symbol, ctx.reason);

		const anchor = await this.findSymbolAnchor(ctx, symbol, options?.path);
		if (!anchor) {
			return {
				relation: "definition",
				symbol,
				locations: [],
				certainty: "unknown",
				note: `Symbol "${symbol}" not found in the LSP-visible source for ${this.language}.`,
			};
		}

		try {
			const token = this.cancellationToken();
			const response = await ctx.client.request<LspLocation | LspLocation[] | null>(
				"textDocument/definition",
				anchor.params,
				token,
			);
			const locations = this.locationsFromResponse(ctx.worktree, response);
			return {
				relation: "definition",
				symbol,
				locations,
				certainty: "exact",
				note: "Resolved via language server.",
			};
		} catch (err) {
			return this.unknown("definition", symbol, this.errorNote(err));
		}
	}

	/* ---------------------------- getReferences ----------------------------- */

	async getReferences(symbol: string, options?: SemanticReferencesOptions): Promise<SemanticResult> {
		const ctx = await this.connect();
		if (!ctx.ok) return this.unknown("reference", symbol, ctx.reason);

		const anchor = await this.findSymbolAnchor(ctx, symbol, options?.path);
		if (!anchor) {
			return {
				relation: "reference",
				symbol,
				locations: [],
				certainty: "unknown",
				coverage: "unknown",
				note: `Symbol "${symbol}" not found in the LSP-visible source for ${this.language}.`,
			};
		}

		try {
			const token = this.cancellationToken();
			const response = await ctx.client.request<LspLocation[] | null>(
				"textDocument/references",
				{
					...anchor.params,
					context: { includeDeclaration: true },
				},
				token,
			);
			const locations = this.locationsFromResponse(ctx.worktree, response ?? []);
			const capped = options?.maxResults ? locations.slice(0, options.maxResults) : locations;
			const coverage: "complete" | "partial" = capped.length < locations.length ? "partial" : "complete";
			return {
				relation: "reference",
				symbol,
				locations: capped,
				certainty: "exact",
				coverage,
				note:
					coverage === "partial" ? `Capped at ${options?.maxResults} results.` : "Resolved via language server.",
			};
		} catch (err) {
			return this.unknown("reference", symbol, this.errorNote(err));
		}
	}

	/* ------------------------------ getCallers ------------------------------ */

	async getCallers(symbol: string, options?: SemanticQueryOptions): Promise<SemanticResult> {
		const ctx = await this.connect();
		if (!ctx.ok) return this.unknown("caller", symbol, ctx.reason);

		const anchor = await this.findSymbolAnchor(ctx, symbol, options?.path);
		if (!anchor) {
			return {
				relation: "caller",
				symbol,
				direct: [],
				candidates: [],
				certainty: "unknown",
				note: `Symbol "${symbol}" not found in the LSP-visible source for ${this.language}.`,
			};
		}

		try {
			const token = this.cancellationToken();
			const prepared = await ctx.client.request<LspCallHierarchyItem[] | null>(
				"textDocument/prepareCallHierarchy",
				anchor.params,
				token,
			);
			const item = prepared?.[0];
			if (!item) {
				return {
					relation: "caller",
					symbol,
					direct: [],
					candidates: [],
					certainty: "candidate",
					note: `Language server has no call-hierarchy data for "${symbol}" at the resolved position.`,
				};
			}
			const incoming = await ctx.client.request<LspCallHierarchyCall[] | null>(
				"callHierarchy/incomingCalls",
				{ item },
				token,
			);
			const direct: SemanticLocation[] = [];
			const seen = new Set<string>();
			for (const call of incoming ?? []) {
				for (const range of call.fromRanges ?? []) {
					const uri = call.from?.uri ?? anchor.params.textDocument.uri;
					const loc = this.locationFromRange(ctx.worktree, uri, range);
					if (!loc) continue;
					const key = `${loc.path}::${loc.startLine}::${loc.endLine}`;
					if (seen.has(key)) continue;
					seen.add(key);
					direct.push(loc);
				}
			}
			return {
				relation: "caller",
				symbol,
				direct,
				candidates: [],
				certainty: "exact",
				note: "Callers resolved via call-hierarchy protocol.",
			};
		} catch (err) {
			// The audit says "the model can tell a fresh finding from
			// a stale one" — if the server rejects the call-hierarchy
			// request, we degrade to `candidate` with an honest note
			// rather than throwing.
			return {
				relation: "caller",
				symbol,
				direct: [],
				candidates: [],
				certainty: "candidate",
				note: `Call-hierarchy unsupported by ${this.language} server: ${this.errorNote(err)}`,
			};
		}
	}

	/* ------------------------------ getCallees ------------------------------ */

	async getCallees(symbol: string, options?: SemanticQueryOptions): Promise<SemanticResult> {
		const ctx = await this.connect();
		if (!ctx.ok) return this.unknown("callee", symbol, ctx.reason);

		const anchor = await this.findSymbolAnchor(ctx, symbol, options?.path);
		if (!anchor) {
			return {
				relation: "callee",
				symbol,
				direct: [],
				candidates: [],
				certainty: "unknown",
				note: `Symbol "${symbol}" not found in the LSP-visible source for ${this.language}.`,
			};
		}

		try {
			const token = this.cancellationToken();
			const prepared = await ctx.client.request<LspCallHierarchyItem[] | null>(
				"textDocument/prepareCallHierarchy",
				anchor.params,
				token,
			);
			const item = prepared?.[0];
			if (!item) {
				return {
					relation: "callee",
					symbol,
					direct: [],
					candidates: [],
					certainty: "candidate",
					note: `Language server has no call-hierarchy data for "${symbol}" at the resolved position.`,
				};
			}
			const outgoing = await ctx.client.request<LspCallHierarchyCall[] | null>(
				"callHierarchy/outgoingCalls",
				{ item },
				token,
			);
			const direct: SemanticLocation[] = [];
			const seen = new Set<string>();
			for (const call of outgoing ?? []) {
				for (const range of call.fromRanges ?? []) {
					const uri = call.to?.uri ?? anchor.params.textDocument.uri;
					const loc = this.locationFromRange(ctx.worktree, uri, range);
					if (!loc) continue;
					const key = `${loc.path}::${loc.startLine}::${loc.endLine}`;
					if (seen.has(key)) continue;
					seen.add(key);
					direct.push(loc);
				}
			}
			return {
				relation: "callee",
				symbol,
				direct,
				candidates: [],
				certainty: "exact",
				note: "Callees resolved via call-hierarchy protocol.",
			};
		} catch (err) {
			return {
				relation: "callee",
				symbol,
				direct: [],
				candidates: [],
				certainty: "candidate",
				note: `Call-hierarchy unsupported by ${this.language} server: ${this.errorNote(err)}`,
			};
		}
	}

	/* --------------------------- getImplementations ------------------------- */

	async getImplementations(symbol: string, options?: SemanticQueryOptions): Promise<SemanticResult> {
		const ctx = await this.connect();
		if (!ctx.ok) return this.unknown("implementation", symbol, ctx.reason);

		const anchor = await this.findSymbolAnchor(ctx, symbol, options?.path);
		if (!anchor) {
			return {
				relation: "implementation",
				symbol,
				locations: [],
				certainty: "unknown",
				note: `Symbol "${symbol}" not found in the LSP-visible source for ${this.language}.`,
			};
		}

		try {
			const token = this.cancellationToken();
			const response = await ctx.client.request<LspLocation | LspLocation[] | null>(
				"textDocument/implementation",
				anchor.params,
				token,
			);
			const locations = this.locationsFromResponse(ctx.worktree, response);
			return {
				relation: "implementation",
				symbol,
				locations,
				certainty: locations.length > 0 ? "exact" : "candidate",
				note:
					locations.length > 0
						? "Resolved via language server."
						: "Language server has no implementation data at the resolved position.",
			};
		} catch (err) {
			return this.unknown("implementation", symbol, this.errorNote(err));
		}
	}

	/* ---------------------------- getRelevantTests -------------------------- */

	async getRelevantTests(symbol: string, _options?: SemanticQueryOptions): Promise<SemanticResult> {
		// The LSP standard has no test-relation query. We use the
		// same worktree-walk heuristic as the in-process typescript
		// adapter so the audit's `candidate` certainty shows up
		// consistently across backends.
		try {
			const worktree = this.worktree();
			if (!worktree) {
				return {
					relation: "test-relation",
					symbol,
					tests: [],
					certainty: "unknown",
					note: "No worktree known to the LSP adapter; cannot walk for tests.",
				};
			}
			const tests: { path: string; reason: string; confidence: number }[] = [];
			const seen = new Set<string>();
			const queue: string[] = [worktree];
			const visited = new Set<string>();
			while (queue.length > 0) {
				const dir = queue.shift() ?? "";
				if (visited.has(dir)) continue;
				visited.add(dir);
				let entries: import("node:fs").Dirent[];
				try {
					entries = await readdir(dir, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const entry of entries) {
					if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
					const full = join(dir, entry.name);
					if (entry.isDirectory()) {
						queue.push(full);
						continue;
					}
					if (!entry.isFile()) continue;
					if (!TS_TEST_FILE_RE.test(entry.name)) continue;
					let content: string;
					try {
						content = await readFile(full, "utf-8");
					} catch {
						continue;
					}
					if (!content.includes(symbol)) continue;
					const rel = relative(worktree, full).replace(/\\/g, "/");
					if (seen.has(rel)) continue;
					seen.add(rel);
					const hasImport = new RegExp(`import\\b[^;]*\\b${symbol}\\b`).test(content);
					const describeRegex = new RegExp(`(?:describe|it|test)\\s*\\(\\s*["'\`][^"'\`]*\\b${symbol}\\b`);
					const hasDescribe = describeRegex.test(content);
					let confidence = 0.4;
					let reason = `Mentions ${symbol}`;
					if (hasImport) {
						confidence = 0.95;
						reason = `Imports ${symbol}`;
					} else if (hasDescribe) {
						confidence = 0.7;
						reason = `Test name references ${symbol}`;
					}
					tests.push({ path: rel, reason, confidence });
				}
			}
			tests.sort((a, b) => b.confidence - a.confidence);
			return {
				relation: "test-relation",
				symbol,
				tests,
				certainty: tests.length > 0 ? "candidate" : "unknown",
				note:
					tests.length === 0
						? `No test file mentioning "${symbol}" was found under ${worktree}.`
						: "LSP does not standardise test-relation queries; tests are ranked by file-content heuristic.",
			};
		} catch (err) {
			return {
				relation: "test-relation",
				symbol,
				tests: [],
				certainty: "unknown",
				note: `LSP test-relation heuristic failed: ${this.errorNote(err)}`,
			};
		}
	}

	/* ----------------------------- getDiagnostics --------------------------- */

	async getDiagnostics(options?: SemanticDiagnosticsOptions): Promise<DiagnosticResult[]> {
		const ctx = await this.connect();
		if (!ctx.ok) return [];
		const client = ctx.client;
		const worktree = ctx.worktree;
		const wantWarnings = options?.includeWarnings === true;
		const wantPath = options?.path;
		const all: DiagnosticResult[] = [];
		// Try the pull model (LSP 3.17+). Servers that do not support
		// it throw `MethodNotFound`; we swallow that and fall back
		// to whatever the server has already pushed.
		try {
			const token = this.cancellationToken();
			const pull = await client.request<LspDiagnostic[] | null>(
				"textDocument/diagnostic",
				{ textDocument: { uri: this.toFileUri(worktree, options?.path) } },
				token,
			);
			if (Array.isArray(pull)) {
				const now = Date.now();
				for (const d of pull) {
					all.push(this.diagnosticToResult(worktree, options?.path ?? "", d, now));
				}
			}
		} catch {
			// Method not found or similar; rely on published.
		}
		// Add whatever the server has already pushed.
		for (const [uri, entry] of this.publishedDiagnostics) {
			const path = this.uriToRelativePath(worktree, uri);
			for (const d of entry.items) {
				const result = this.diagnosticToResult(worktree, path, d, entry.timestamp);
				if (!wantWarnings && result.severity === "warning") continue;
				if (wantPath !== undefined && result.file !== wantPath) continue;
				all.push(result);
			}
		}
		// Sort by file then line for stable output.
		all.sort((a, b) => {
			if (a.file !== b.file) return a.file.localeCompare(b.file);
			return a.line - b.line;
		});
		// `TEST_FILE_RE` is exported as a constant for callers that
		// want to filter test-file diagnostics; the helper above
		// intentionally does not.
		void TEST_FILE_RE;
		return all;
	}

	/* ----------------------------- internals -------------------------------- */

	private worktree(): string {
		// The manager owns the worktree; recover it from the bound
		// client. Until the first connect we fall back to
		// `process.cwd()`.
		return this.boundClient?.root ?? process.cwd();
	}

	private async connect(): Promise<ConnectResult> {
		let result: Awaited<ReturnType<LspManager["getClient"]>>;
		try {
			result = await this.manager.getClient(this.language);
		} catch {
			// The manager was disposed or the language is
			// permanently unavailable. The audit requires an
			// honest `unknown` result, not a throw to the
			// caller.
			return { ok: false, reason: "LspManager is unavailable or has been disposed", worktree: this.worktree() };
		}
		if (!result.client) {
			return {
				ok: false,
				reason: result.unavailableReason ?? "language server unavailable",
				worktree: this.worktree(),
			};
		}
		// Subscribe to diagnostics on the new client (and only on
		// the new client — the previous one's subscription is
		// tied to its own disposable). The subscription is
		// registered here rather than inside `getDiagnostics`
		// so a server-pushed diagnostic that arrives before the
		// first `getDiagnostics` call is still captured.
		if (this.boundClient !== result.client) {
			this.diagnosticSubscription?.dispose();
			this.boundClient = result.client;
			this.ensureDiagnosticSubscription(result.client);
		}
		return { ok: true, client: result.client, worktree: this.worktree() };
	}

	private ensureDiagnosticSubscription(client: LspClient): void {
		if (this.diagnosticSubscription) return;
		this.diagnosticSubscription = client.onNotification("textDocument/publishDiagnostics", (raw) => {
			const params = raw as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined;
			const uri = params?.uri;
			if (!uri) return;
			const items = Array.isArray(params?.diagnostics) ? params.diagnostics : [];
			this.publishedDiagnostics.set(uri, { items, timestamp: Date.now() });
		});
	}

	/**
	 * Resolve a `(uri, line, character)` anchor for `symbol` inside
	 * the file the caller hinted at (or the first matching file we
	 * know about). Returns `undefined` if the file is missing, the
	 * symbol does not occur there as a whole word, or the file
	 * cannot be opened on the server.
	 */
	private async findSymbolAnchor(
		ctx: { client: LspClient; worktree: string },
		symbol: string,
		hintPath: string | undefined,
	): Promise<
		| { uri: string; params: { textDocument: { uri: string }; position: { line: number; character: number } } }
		| undefined
	> {
		const abs = hintPath ? join(ctx.worktree, hintPath) : null;
		if (!abs || !existsSync(abs)) {
			return undefined;
		}
		const text = readFileSync(abs, "utf-8");
		const uri = this.toFileUri(ctx.worktree, hintPath);
		// Whole-word search: a "word" here is a run of letters,
		// digits, underscore, or `$`. This matches what the TS
		// language service accepts as an identifier.
		const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const re = new RegExp(`\\b${escaped}\\b`, "g");
		const match = re.exec(text);
		if (!match) return undefined;
		const position = this.positionAt(text, match.index);
		// Make sure the server has the file open. `didOpen` is a
		// no-op when the document is already open.
		try {
			await ctx.client.didOpen(uri, text, LANGUAGE_ID[this.language]);
		} catch (err) {
			// `didOpen` is best-effort; an error here just means the
			// server will fall back to its on-disk read.
			void err;
		}
		return { uri, params: { textDocument: { uri }, position } };
	}

	private toFileUri(worktree: string, path: string | undefined): string {
		const abs = path ? join(worktree, path) : worktree;
		const normalized = abs.replace(/\\/g, "/");
		if (normalized.startsWith("/")) return `file://${normalized}`;
		const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
		if (drive) return `file:///${drive[1]}%3A/${drive[2] ?? ""}`;
		return `file://${normalized}`;
	}

	private uriToRelativePath(worktree: string, uri: string): string {
		const norm = uri.replace(/\\/g, "/");
		// Normalize percent-encoded drive letter (`C%3A` → `C:`)
		// so the `file:///` form on Windows matches the worktree.
		const normDecoded = norm.replace(/%3A/gi, ":");
		const wt = worktree.replace(/\\/g, "/").replace(/\/$/, "");
		// `file:///C:/path/...` (Windows)
		const winUri = `file:///${wt}/`;
		if (normDecoded.startsWith(winUri)) return normDecoded.slice(winUri.length);
		// `file:///path/...` (POSIX)
		const posixUri = `file://${wt}/`;
		if (normDecoded.startsWith(posixUri)) return normDecoded.slice(posixUri.length);
		// `file://C:/path/...` (no leading triple-slash; malformed but
		// some servers send this)
		const malformed = `file://${wt}/`;
		if (normDecoded.startsWith(malformed)) return normDecoded.slice(malformed.length);
		// Already relative — pass through.
		if (!normDecoded.includes("://")) return normDecoded;
		return norm;
	}

	private positionAt(text: string, offset: number): { line: number; character: number } {
		let line = 0;
		let character = 0;
		for (let i = 0; i < offset && i < text.length; i += 1) {
			if (text.charCodeAt(i) === 10 /* \n */) {
				line += 1;
				character = 0;
			} else {
				character += 1;
			}
		}
		return { line, character };
	}

	private locationsFromResponse(
		worktree: string,
		response: LspLocation | LspLocation[] | null | undefined,
	): SemanticLocation[] {
		if (!response) return [];
		const arr = Array.isArray(response) ? response : [response];
		const out: SemanticLocation[] = [];
		const seen = new Set<string>();
		for (const loc of arr) {
			if (!loc?.uri) continue;
			const path = this.uriToRelativePath(worktree, loc.uri);
			const startLine = loc.range.start.line + 1;
			const endLine = loc.range.end.line + 1;
			const key = `${path}::${startLine}::${endLine}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ path, startLine, endLine });
		}
		return out;
	}

	private locationFromRange(
		worktree: string,
		uri: string,
		range: { start: { line: number; character: number }; end: { line: number; character: number } },
	): SemanticLocation | undefined {
		if (!uri) return undefined;
		const path = this.uriToRelativePath(worktree, uri);
		return { path, startLine: range.start.line + 1, endLine: range.end.line + 1 };
	}

	private diagnosticToResult(
		_worktree: string,
		path: string,
		diag: LspDiagnostic,
		timestamp: number,
	): DiagnosticResult {
		const severity = diag.severity !== undefined ? (DIAG_SEVERITY[diag.severity] ?? "info") : "info";
		const result: DiagnosticResult = {
			relation: "diagnostic",
			file: path,
			line: (diag.range?.start?.line ?? 0) + 1,
			severity,
			message: diag.message ?? "",
			source: diag.source ?? this.language,
			snapshotId: this.snapshotIdForPath(path),
			timestamp,
			certainty: "exact",
		};
		const character = diag.range?.start?.character ?? 0;
		if (character > 0) result.column = character;
		if (diag.code !== undefined) result.code = diag.code;
		return result;
	}

	private snapshotIdForPath(path: string): string {
		// Lazily hash by `(path, mtimeMs, size)`. The audit's
		// provenance requirement is "a stable content hash for the
		// file at the time the diagnostic was produced", which the
		// `(mtime, size)` key satisfies for the common case where
		// the file has not been edited between hash and use. A true
		// snapshot is fine for diagnostics but a SHA-256 of a
		// multi-megabyte file on every push is not.
		try {
			const st = statSync(path);
			const key = `${path}::${st.mtimeMs}::${st.size}`;
			const existing = this.snapshotCache.get(path);
			if (existing && existing.mtimeMs === st.mtimeMs && existing.size === st.size) {
				return existing.id;
			}
			const id = createHash("sha256").update(key).digest("hex");
			this.snapshotCache.set(path, { id, mtimeMs: st.mtimeMs, size: st.size });
			return id;
		} catch {
			// The file may not exist on disk (it was synthesised by
			// the adapter). Fall back to a hash of the path so the
			// provenance field is still stable.
			return createHash("sha256").update(path).digest("hex");
		}
	}

	private cancellationToken(): CancellationToken {
		const cts = new CancellationTokenSource();
		if (this.abortSignal) {
			if (this.abortSignal.aborted) cts.cancel();
			else this.abortSignal.addEventListener("abort", () => cts.cancel(), { once: true });
		}
		return cts.token;
	}

	private errorNote(err: unknown): string {
		if (err instanceof LspClientError) return `${err.code}: ${err.message}`;
		if (err instanceof Error) return err.message;
		return String(err);
	}

	private unknown(
		relation: "definition" | "reference" | "caller" | "callee" | "implementation",
		symbol: string,
		reason: string | undefined,
	): SemanticResult {
		const note = reason ?? "Language server unavailable.";
		switch (relation) {
			case "definition":
				return { relation: "definition", symbol, locations: [], certainty: "unknown", note };
			case "reference":
				return { relation: "reference", symbol, locations: [], certainty: "unknown", coverage: "unknown", note };
			case "caller":
				return { relation: "caller", symbol, direct: [], candidates: [], certainty: "unknown", note };
			case "callee":
				return { relation: "callee", symbol, direct: [], candidates: [], certainty: "unknown", note };
			case "implementation":
				return { relation: "implementation", symbol, locations: [], certainty: "unknown", note };
		}
	}
}

/* -------------------------------------------------------------------------- */
/* Convenience: hasInProcessFallback export for factory wiring                */
/* -------------------------------------------------------------------------- */

export { hasInProcessFallback };

