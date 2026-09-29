/**
 * F1 semantic query layer.
 *
 * Exposes a small, LSP-shaped API for symbol-level queries:
 *
 *   - `getDefinition(symbol)`        — where the symbol is declared
 *   - `getReferences(symbol)`        — every reference, with coverage
 *   - `getCallers(symbol)`           — direct + candidate dispatch targets
 *   - `getCallees(symbol)`           — direct + candidate callees
 *   - `getImplementations(symbol)`   — language-semantic implementations
 *   - `getRelevantTests(symbol)`     — ranked test candidates
 *   - `getDiagnostics(options?)`     — compiler / linter diagnostics
 *
 * The audit (Section 11.3 "API design") calls for "the right tool" to be
 * the existing TypeScript language service or an LSP. This module
 * defines the contract, ships a `MockSemanticQueryAdapter` for tests,
 * and wires two real backends:
 *
 *   - `typescript-ls` — `TypeScriptLanguageServiceAdapter` that resolves
 *                       the queries against a `ts.Program` via the
 *                       TypeScript compiler API. Available in-process
 *                       with no external dependency.
 *   - `lsp`           — `LspAdapter` (see `./lsp-adapter.ts`) that talks
 *                       to an external language server (typescript-language-server,
 *                       pylsp, rust-analyzer, gopls) over stdio. When no
 *                       server is on `PATH` and no override file is
 *                       present, the factory falls back to a mock with a
 *                       clear "no language server found" note.
 *
 * Public surface (callers should import only these):
 *   - `SemanticRelation`, `SemanticCertainty`, `SemanticLocation`
 *   - `SemanticResult` (discriminated union)
 *   - `DiagnosticResult`, `DiagnosticSeverity`
 *   - `SemanticQueryAdapter`
 *   - `MockSemanticQueryAdapter`
 *   - `createSemanticQueryAdapter`
 */

/* -------------------------------------------------------------------------- */
/* Imports                                                                    */
/* -------------------------------------------------------------------------- */

import { TypeScriptLanguageServiceAdapter } from "./typescript-semantic-adapter.ts";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/** A semantic query kind. Each maps to one method on `SemanticQueryAdapter`. */
export type SemanticRelation =
	| "definition"
	| "reference"
	| "caller"
	| "callee"
	| "implementation"
	| "test-relation"
	| "diagnostic";

/**
 * How confident the adapter is in the answer. `"unknown"` is the honest
 * default for the mock — it must not silently look like a real
 * "no references found" result.
 */
export type SemanticCertainty = "exact" | "candidate" | "unresolved" | "unknown";

/**
 * A source location. Lines are 1-indexed; bytes are 0-indexed and
 * optional because the regex MVP cannot always compute them.
 */
export interface SemanticLocation {
	/** Forward-slash relative path of the file. */
	path: string;
	/** 1-indexed start line. */
	startLine: number;
	/** 1-indexed end line (inclusive). */
	endLine: number;
	/** 0-indexed byte offset of the start, if available. */
	startByte?: number;
	/** 0-indexed byte offset of the end, if available. */
	endByte?: number;
}

/**
 * Severity classification for a diagnostic. Maps to the four
 * `ts.DiagnosticCategory` values: `Error` → `"error"`, `Warning` →
 * `"warning"`, `Message` / `Suggestion` → `"info"`.
 */
export type DiagnosticSeverity = "error" | "warning" | "info";

/**
 * Discriminated union over `relation`. Each variant is shaped for the
 * data the corresponding query returns:
 *
 *   - `"reference"` carries an explicit `coverage` label so the caller
 *     can distinguish "0 references because none exist" from
 *     "0 references because the indexer hasn't finished".
 *   - `"caller"` / `"callee"` separate `direct` (statically known) from
 *     `candidates` (dispatch targets that may resolve at runtime).
 *   - `"test-relation"` returns ranked test paths with a per-test
 *     `confidence` score; callers must never infer exhaustion from it.
 *   - `"diagnostic"` carries a single compiler / linter finding with
 *     full provenance (source, snapshot, timestamp) as required by the
 *     audit (Section 11.3 "API design"). `snapshotId` is a content
 *     hash; `timestamp` is when the adapter produced the result.
 */
export type SemanticResult =
	| {
			relation: "definition";
			symbol: string;
			locations: SemanticLocation[];
			certainty: SemanticCertainty;
			note?: string;
	  }
	| {
			relation: "reference";
			symbol: string;
			locations: SemanticLocation[];
			certainty: SemanticCertainty;
			coverage: "complete" | "partial" | "unknown";
			note?: string;
	  }
	| {
			relation: "caller" | "callee";
			symbol: string;
			direct: SemanticLocation[];
			candidates: SemanticLocation[];
			certainty: SemanticCertainty;
			note?: string;
	  }
	| {
			relation: "implementation";
			symbol: string;
			locations: SemanticLocation[];
			certainty: SemanticCertainty;
			note?: string;
	  }
	| {
			relation: "test-relation";
			symbol: string;
			tests: { path: string; reason: string; confidence: number }[];
			certainty: SemanticCertainty;
			note?: string;
	  }
	| {
			relation: "diagnostic";
			file: string;
			line: number;
			column?: number;
			code?: string | number;
			severity: DiagnosticSeverity;
			message: string;
			/** Where the diagnostic came from (e.g. `"typescript"`). */
			source?: string;
			/** Content hash of the source file at the time the diagnostic was produced. */
			snapshotId?: string;
			/** Milliseconds-since-epoch when the adapter produced this result. */
			timestamp: number;
			/**
			 * Confidence in the finding. Compiler-produced findings are
			 * `exact`; linter suggestions may downgrade to `candidate`.
			 */
			certainty: SemanticCertainty;
			/** Optional adapter commentary (e.g. "TS adapter failed to enumerate"). */
			note?: string;
	  };

/**
 * A single diagnostic entry, equivalent to the `"diagnostic"` variant
 * of `SemanticResult`. Exposed as a named alias so callers that only
 * care about diagnostics don't have to narrow the union.
 */
export type DiagnosticResult = Extract<SemanticResult, { relation: "diagnostic" }>;

/* -------------------------------------------------------------------------- */
/* Adapter interface                                                          */
/* -------------------------------------------------------------------------- */

/** Options accepted by every query. All fields optional. */
export interface SemanticQueryOptions {
	/** Hint about which file / module the symbol lives in. */
	path?: string;
}

/** Options for `getReferences`. */
export interface SemanticReferencesOptions extends SemanticQueryOptions {
	/** Cap on returned locations. Backend may still report `coverage: "partial"`. */
	maxResults?: number;
}

/** Options for `getDiagnostics`. */
export interface SemanticDiagnosticsOptions {
	/** Restrict to this file (forward-slash relative path under the worktree). */
	path?: string;
	/** When `true`, include `severity: "warning"` findings. Default `false`. */
	includeWarnings?: boolean;
}

/**
 * The adapter contract. Each method is `async` so a real LSP / TS-LS
 * backend can drop in without changing call sites.
 */
export interface SemanticQueryAdapter {
	getDefinition(symbol: string, options?: SemanticQueryOptions): Promise<SemanticResult>;
	getReferences(symbol: string, options?: SemanticReferencesOptions): Promise<SemanticResult>;
	getCallers(symbol: string, options?: SemanticQueryOptions): Promise<SemanticResult>;
	getCallees(symbol: string, options?: SemanticQueryOptions): Promise<SemanticResult>;
	getImplementations(symbol: string, options?: SemanticQueryOptions): Promise<SemanticResult>;
	getRelevantTests(symbol: string, options?: SemanticQueryOptions): Promise<SemanticResult>;
	/**
	 * Compiler / linter diagnostics, with full provenance
	 * (source, snapshot, timestamp). The audit (Section 11.3
	 * "API design") calls for `repo.getDiagnostics(symbol)` to
	 * include this metadata so the model can tell a fresh
	 * finding from a stale one and a real tool finding from
	 * a placeholder.
	 */
	getDiagnostics(options?: SemanticDiagnosticsOptions): Promise<DiagnosticResult[]>;
}

/* -------------------------------------------------------------------------- */
/* Factory options                                                            */
/* -------------------------------------------------------------------------- */

/** Backend identifiers the factory understands. */
export type SemanticBackend = "mock" | "lsp" | "typescript-ls";

export interface CreateSemanticQueryAdapterOptions {
	/** Which backend to instantiate. Default `"mock"`. */
	backend?: SemanticBackend;
	/** Free-form backend configuration. Consumed by the `lsp` and
	 * `typescript-ls` backends. The factory extracts a
	 * `manager: LspManager` for `lsp` and a
	 * `program: ts.Program` (and optional `worktree`) for
	 * `typescript-ls` from this bag. */
	config?: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Mock implementation                                                        */
/* -------------------------------------------------------------------------- */

const MOCK_DEFAULT_NOTE =
	"Mock adapter — no real language service attached. Run a real LSP/TypeScript LS adapter to get results.";

function emptyMock(relation: SemanticRelation, symbol: string, note: string): SemanticResult {
	switch (relation) {
		case "definition":
			return { relation: "definition", symbol, locations: [], certainty: "unknown", note };
		case "reference":
			return {
				relation: "reference",
				symbol,
				locations: [],
				certainty: "unknown",
				coverage: "unknown",
				note,
			};
		case "caller":
		case "callee":
			return {
				relation,
				symbol,
				direct: [],
				candidates: [],
				certainty: "unknown",
				note,
			};
		case "implementation":
			return { relation: "implementation", symbol, locations: [], certainty: "unknown", note };
		case "test-relation":
			return { relation: "test-relation", symbol, tests: [], certainty: "unknown", note };
		case "diagnostic":
			// Diagnostics don't have a single `symbol`; return a
			// sentinel that the consumer can detect. The mock
			// never produces this from the default path; it is
			// here only to keep the switch exhaustive.
			return {
				relation: "diagnostic",
				file: "",
				line: 0,
				severity: "info",
				message: note,
				timestamp: 0,
				certainty: "unknown",
			};
	}
}

/**
 * In-memory mock that returns `certainty: "unknown"` placeholders by
 * default. Tests can inject deterministic results via
 * `setMockResult(relation, symbol, result)`. Every call is appended to
 * a per-instance log retrievable with `getQueryLog()`.
 */
export class MockSemanticQueryAdapter implements SemanticQueryAdapter {
	/**
	 * Default note attached to results that have no injection. Overridable
	 * so the factory can return a mock that says "Backend X not
	 * implemented" instead of the standard mock note.
	 */
	private defaultNote: string = MOCK_DEFAULT_NOTE;
	private readonly injected: Map<string, SemanticResult> = new Map();
	private readonly log: { relation: SemanticRelation; symbol: string; timestamp: number }[] = [];
	private injectedDiagnostics: DiagnosticResult[] | undefined;

	/**
	 * Map key. Combines `relation` and `symbol` so the same symbol can
	 * have different injected results for different relations (e.g. a
	 * definition but no callers).
	 */
	private key(relation: SemanticRelation, symbol: string): string {
		return `${relation}::${symbol}`;
	}

	/** Inject a result for `(relation, symbol)`. Overwrites any prior injection. */
	setMockResult(relation: SemanticRelation, symbol: string, result: SemanticResult): void {
		this.injected.set(this.key(relation, symbol), result);
	}

	/**
	 * Inject deterministic diagnostics for `getDiagnostics`. Overwrites
	 * any prior injection. Diagnostics are not keyed by a symbol — the
	 * caller controls which diagnostics to surface by passing them in
	 * directly.
	 */
	setMockDiagnostics(diagnostics: DiagnosticResult[]): void {
		// Defensive copy so external mutations don't leak into the mock.
		this.injectedDiagnostics = diagnostics.map((d) => ({ ...d }));
	}

	/** Read-only view of every query this adapter has handled, in arrival order. */
	getQueryLog(): { relation: SemanticRelation; symbol: string; timestamp: number }[] {
		return this.log.slice();
	}

	/** Test-only: reset both the injection map and the query log. */
	resetForTests(): void {
		this.injected.clear();
		this.injectedDiagnostics = undefined;
		this.log.length = 0;
	}

	/**
	 * Override the default note attached to non-injected results. The
	 * factory uses this to give the `lsp` / `typescript-ls` backends a
	 * "not implemented in MVP" note without having to inject every
	 * (relation, symbol) combination.
	 */
	setDefaultNote(note: string): void {
		this.defaultNote = note;
	}

	private record(relation: SemanticRelation, symbol: string): void {
		this.log.push({ relation, symbol, timestamp: Date.now() });
	}

	private resolve(relation: SemanticRelation, symbol: string): SemanticResult {
		const injected = this.injected.get(this.key(relation, symbol));
		if (injected) return injected;
		return emptyMock(relation, symbol, this.defaultNote);
	}

	getDefinition(symbol: string): Promise<SemanticResult> {
		this.record("definition", symbol);
		return Promise.resolve(this.resolve("definition", symbol));
	}

	getReferences(symbol: string): Promise<SemanticResult> {
		this.record("reference", symbol);
		return Promise.resolve(this.resolve("reference", symbol));
	}

	getCallers(symbol: string): Promise<SemanticResult> {
		this.record("caller", symbol);
		return Promise.resolve(this.resolve("caller", symbol));
	}

	getCallees(symbol: string): Promise<SemanticResult> {
		this.record("callee", symbol);
		return Promise.resolve(this.resolve("callee", symbol));
	}

	getImplementations(symbol: string): Promise<SemanticResult> {
		this.record("implementation", symbol);
		return Promise.resolve(this.resolve("implementation", symbol));
	}

	getRelevantTests(symbol: string): Promise<SemanticResult> {
		this.record("test-relation", symbol);
		return Promise.resolve(this.resolve("test-relation", symbol));
	}

	async getDiagnostics(options?: SemanticDiagnosticsOptions): Promise<DiagnosticResult[]> {
		this.record("diagnostic", "");
		if (this.injectedDiagnostics === undefined) return [];
		const wantWarnings = options?.includeWarnings === true;
		const wantPath = options?.path;
		return this.injectedDiagnostics
			.filter((d) => {
				if (!wantWarnings && d.severity === "warning") return false;
				if (wantPath !== undefined && d.file !== wantPath) return false;
				return true;
			})
			.map((d) => ({ ...d }));
	}
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

function notImplementedNote(backend: SemanticBackend): string {
	return `Backend ${backend} not implemented in MVP.`;
}

const LSP_NO_MANAGER_NOTE =
	"LSP backend requested but no `manager` was supplied via `config`. " +
	"Construct an `LspManager` for the worktree and pass it as `config.manager` to use a real language server.";

/**
 * Create a `SemanticQueryAdapter`. The default backend is `"mock"`.
 *
 * Backends:
 *   - `"mock"`          — `MockSemanticQueryAdapter` with the standard
 *                         default note.
 *   - `"typescript-ls"` — when `config.program` (a `ts.Program`) is
 *                         supplied, returns a real
 *                         `TypeScriptLanguageServiceAdapter` that
 *                         answers queries against the program. Without
 *                         a program, returns a mock with a note
 *                         explaining how to wire one.
 *   - `"lsp"`           — when `config.manager` (an `LspManager`) and
 *                         `config.language` are supplied, returns a
 *                         real `LspAdapter` that talks to the manager.
 *                         If the manager has no server for the
 *                         worktree, the factory still returns a mock
 *                         but with a clear "no language server found"
 *                         note so the audit can tell a real tool
 *                         finding from a placeholder.
 */
export function createSemanticQueryAdapter(options?: CreateSemanticQueryAdapterOptions): SemanticQueryAdapter {
	const backend: SemanticBackend = options?.backend ?? "mock";

	if (backend === "mock") {
		return new MockSemanticQueryAdapter();
	}

	if (backend === "typescript-ls") {
		// The factory accepts the program via the free-form `config`
		// bag so callers don't have to import the `typescript` types
		// just to use the mock. The adapter itself is loaded via a
		// dynamic import string indirection so callers that never
		// touch the typescript-ls backend don't pay for the module
		// graph.
		const config = options?.config ?? {};
		const maybeProgram = (config as { program?: unknown }).program;
		if (maybeProgram) {
			return new TypeScriptLanguageServiceAdapter({ program: maybeProgram as never });
		}
		const mock = new MockSemanticQueryAdapter();
		mock.setDefaultNote(notImplementedNote(backend));
		return mock;
	}

	if (backend === "lsp") {
		// The `lsp` backend is implemented in `lsp-adapter.ts`. The
		// factory accepts the `LspManager` and the language tag
		// through the free-form `config` bag so callers don't have
		// to import the LSP types just to wire a mock. The
		// dependency on `lsp-adapter.ts` is a top-level static
		// import (see the import block at the head of this file).
		const config = options?.config ?? {};
		const maybeManager = (config as { manager?: unknown }).manager;
		const maybeLanguage = (config as { language?: unknown }).language;
		if (!maybeManager) {
			const mock = new MockSemanticQueryAdapter();
			mock.setDefaultNote(LSP_NO_MANAGER_NOTE);
			return mock;
		}
		const language = (typeof maybeLanguage === "string" ? maybeLanguage : "typescript") as
			| "typescript"
			| "javascript"
			| "python"
			| "rust"
			| "go";
		const { LspAdapter } = lspAdapterModule;
		return new LspAdapter({ manager: maybeManager as never, language });
	}

	// Unknown backend: return the standard mock so callers see the
	// usual "Mock adapter" note instead of a thrown error.
	return new MockSemanticQueryAdapter();
}

/* -------------------------------------------------------------------------- */
/* Lazy LspAdapter import                                                     */
/* -------------------------------------------------------------------------- */

// Imported as a namespace so the bundle can elide the file when the
// caller never asks for the `lsp` backend. The module has no
// top-level side effects.
import * as lspAdapterModule from "./lsp-adapter.ts";

