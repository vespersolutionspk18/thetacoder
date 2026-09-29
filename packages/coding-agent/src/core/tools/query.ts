/**
 * F1 `query` tool.
 *
 * A read-only tool the model can invoke to get structured, factual
 * answers about the repository without spawning a search/read sub-agent.
 * It dispatches on `intent`:
 *
 *   - `find-symbol`            — name-substring lookup against the syntax index
 *   - `find-references`        — every reference to a symbol, via the semantic adapter
 *   - `find-files`             — filter the file manifest by language / package / glob
 *   - `find-relevant-context`  — natural-language task with optional hints, via `getRelevantContext`
 *   - `get-definition`         — first declaration site of a symbol, via the semantic adapter
 *   - `get-diagnostics`        — compiler / linter findings, via the semantic adapter
 *
 * The result carries two layers:
 *   - `content` — a human-readable `TextContent` line per result.
 *   - `details` — the full `QueryToolOutput` for callers that want to
 *     render the result structurally.
 *
 * The manifest index (by-language / by-package / by-path) is cached
 * behind the F11 `LruContentCache`. The cache is best-effort and
 * module-scoped: a stale entry can at worst cause a slightly older
 * view of the manifest, which the underlying `FileManifestEntry[]`
 * callers pass in has already committed to.
 */

import type { AgentTool, ToolOutcome } from "@theta/agent-core";
import type { TextContent } from "@theta/ai";
import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import type { FileManifestEntry } from "../repository/manifest.ts";
import { getByLanguage } from "../repository/manifest.ts";
import type { Reference } from "../repository/references.ts";
import { getReferences } from "../repository/references.ts";
import {
	extractIdentifiersFromTask,
	getRelevantContext,
	type RelevantContextItem,
	type TaskQuery,
} from "../repository/relevant-context.ts";
import type { SemanticQueryAdapter, SemanticResult } from "../repository/semantic-queries.ts";
import type { SymbolEntry } from "../repository/syntax-index.ts";
import { findSymbols } from "../repository/syntax-index.ts";
import { LruContentCache } from "../runtime-hotspots.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export type QueryToolIntent =
	| "find-symbol"
	| "find-references"
	| "find-files"
	| "find-relevant-context"
	| "get-definition"
	| "get-diagnostics";

export interface QueryToolInputOptions {
	/** Filter for `find-files`. Restrict to this source language (e.g. "typescript"). */
	language?: string;
	/** Filter for `find-files`. Restrict to this package name. */
	package?: string;
	/**
	 * For `find-files`: additional path glob (intersected with `query`).
	 * For `find-relevant-context`: an explicit path hint.
	 * For `find-references` / `get-definition` / `get-diagnostics`: a path hint passed to the adapter.
	 */
	path?: string;
	/** Cap on results returned. Default 50. */
	maxResults?: number;
	/** Pass-through to the reference scanner: include comment-zone matches. */
	includeComments?: boolean;
	/** Pass-through to the reference scanner: include string-literal matches. */
	includeStringLiterals?: boolean;
	/** For `get-diagnostics`: include warning-severity findings. Default false. */
	includeWarnings?: boolean;
}

export interface QueryToolInput {
	intent: QueryToolIntent;
	/** Free-form search string: symbol name, file glob, or natural-language task. */
	query: string;
	options?: QueryToolInputOptions;
}

export type QueryToolResultItem =
	| {
			kind: "file";
			path: string;
			byteLength: number;
			language: string | null;
			package?: string;
	  }
	| {
			kind: "symbol";
			name: string;
			path: string;
			startLine: number;
			endLine: number;
			/** The symbol's own kind (e.g. "function", "class", "interface"). */
			symbolKind: string;
			signature?: string;
	  }
	| {
			kind: "reference";
			path: string;
			startLine: number;
			endLine: number;
			refKind: string;
			symbol: string;
			certainty: string;
	  }
	| {
			kind: "context-item";
			path: string;
			startLine?: number;
			endLine?: number;
			score: number;
			reasons: string[];
			certainty: string;
	  }
	| {
			kind: "diagnostic";
			path: string;
			line: number;
			column?: number;
			code?: string | number;
			severity: "error" | "warning" | "info";
			message: string;
			source?: string;
			snapshotId?: string;
			timestamp: number;
			certainty: "exact";
	  };

export interface QueryToolOutput {
	intent: QueryToolInput["intent"];
	query: string;
	results: QueryToolResultItem[];
	truncated: boolean;
	totalCandidates: number;
	uncertainty: "low" | "medium" | "high";
	note?: string;
}

export interface QueryToolDetails {
	output: QueryToolOutput;
	/** Structured outcome synthesized by the agent loop. */
	outcome?: ToolOutcome;
}

export interface CreateQueryToolOptions {
	/** Worktree root, used for diagnostics only (e.g. log lines). */
	root?: string;
}

/* -------------------------------------------------------------------------- */
/* Schema (TypeBox)                                                            */
/* -------------------------------------------------------------------------- */

const querySchema = Type.Object({
	// `intent` is a free-form string from the model's perspective; the
	// tool validates it at dispatch time. Using `Type.String()` here
	// avoids `Type.Union` static-type narrowing quirks while still
	// documenting the allowed values in the description.
	intent: Type.String({
		description:
			"What kind of repository query to run: 'find-symbol', 'find-references', 'find-files', 'find-relevant-context', 'get-definition', or 'get-diagnostics'",
	}),
	query: Type.String({ description: "Symbol name, file glob, or natural-language task" }),
	options: Type.Optional(
		Type.Object({
			language: Type.Optional(Type.String({ description: "Filter by source language (e.g. 'typescript')" })),
			package: Type.Optional(Type.String({ description: "Filter by owning package name" })),
			path: Type.Optional(
				Type.String({
					description: "Glob for find-files, or explicit path for find-relevant-context / get-diagnostics",
				}),
			),
			maxResults: Type.Optional(Type.Number({ description: "Cap on results returned (default 50)" })),
			includeComments: Type.Optional(
				Type.Boolean({ description: "Include reference matches in comment zones (default false)" }),
			),
			includeStringLiterals: Type.Optional(
				Type.Boolean({ description: "Include reference matches inside string literals (default false)" }),
			),
			includeWarnings: Type.Optional(
				Type.Boolean({ description: "For get-diagnostics: include warning-severity findings (default false)" }),
			),
		}),
	),
});

/** Set of values accepted for `intent`. */
const VALID_INTENTS: ReadonlySet<QueryToolIntent> = new Set([
	"find-symbol",
	"find-references",
	"find-files",
	"find-relevant-context",
	"get-definition",
	"get-diagnostics",
]);

function isValidIntent(value: string): value is QueryToolIntent {
	return VALID_INTENTS.has(value as QueryToolIntent);
}

/* -------------------------------------------------------------------------- */
/* System-prompt contribution                                                  */
/* -------------------------------------------------------------------------- */

export const queryToolSystemPromptContribution = {
	snippet:
		"Run a structured query against the repository (symbols, references, files, context, definition, diagnostics)",
	guidelines: [
		"Use query for any factual question about the repo: where a symbol is defined, who calls it, which files are in a language, what context is relevant to a task, or what compiler/linter errors exist.",
		"Pick the intent that matches the question: 'get-definition' for declarations, 'find-references' for callers/uses, 'find-symbol' for fuzzy name lookup, 'find-files' for path/language filters, 'find-relevant-context' for natural-language tasks, 'get-diagnostics' for compile errors and warnings.",
		"results carry kind, path, and line numbers; details also has the full structured output. Diagnostics also include severity, code, message, source, snapshot, and timestamp.",
	],
} as const;

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const DEFAULT_MAX_RESULTS = 50;

/** Module-level LRU cache of derived manifest indexes. */
const manifestIndexCache = new LruContentCache<
	string,
	{
		byLanguage: Map<string, FileManifestEntry[]>;
		byPackage: Map<string, FileManifestEntry[]>;
		byPath: Map<string, FileManifestEntry>;
	}
>({ maxEntries: 16 });

/* -------------------------------------------------------------------------- */
/* Manifest index helpers                                                      */
/* -------------------------------------------------------------------------- */

function manifestVersion(manifest: FileManifestEntry[]): string {
	if (manifest.length === 0) return "empty";
	return `${manifest.length}:${manifest[0]?.path ?? ""}:${manifest[manifest.length - 1]?.path ?? ""}`;
}

function buildManifestIndex(manifest: FileManifestEntry[]): {
	byLanguage: Map<string, FileManifestEntry[]>;
	byPackage: Map<string, FileManifestEntry[]>;
	byPath: Map<string, FileManifestEntry>;
} {
	const byLanguage = new Map<string, FileManifestEntry[]>();
	const byPackage = new Map<string, FileManifestEntry[]>();
	const byPath = new Map<string, FileManifestEntry>();
	for (const entry of manifest) {
		if (entry.language !== null) {
			let bucket = byLanguage.get(entry.language);
			if (!bucket) {
				bucket = [];
				byLanguage.set(entry.language, bucket);
			}
			bucket.push(entry);
		}
		if (entry.package !== undefined) {
			let bucket = byPackage.get(entry.package);
			if (!bucket) {
				bucket = [];
				byPackage.set(entry.package, bucket);
			}
			bucket.push(entry);
		}
		byPath.set(entry.path, entry);
	}
	return { byLanguage, byPackage, byPath };
}

function getManifestIndex(manifest: FileManifestEntry[]): {
	byLanguage: Map<string, FileManifestEntry[]>;
	byPackage: Map<string, FileManifestEntry[]>;
	byPath: Map<string, FileManifestEntry>;
} {
	const key = manifestVersion(manifest);
	const cached = manifestIndexCache.get(key);
	if (cached) return cached;
	const fresh = buildManifestIndex(manifest);
	manifestIndexCache.put(key, fresh);
	return fresh;
}

/* -------------------------------------------------------------------------- */
/* Small glob helper for `find-files`                                          */
/* -------------------------------------------------------------------------- */

function escapeRegex(s: string): string {
	return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
	let body = pattern;
	let leadingSlash = false;
	if (body.startsWith("/")) {
		leadingSlash = true;
		body = body.slice(1);
	}
	if (body === "") return /(?!)/; // never matches

	let regex = "";
	let i = 0;
	while (i < body.length) {
		const ch = body[i];
		const next = body[i + 1];
		if (ch === "*" && next === "*") {
			regex += ".*";
			i += 2;
			if (body[i] === "/") i += 1;
		} else if (ch === "*") {
			regex += "[^/]*";
			i += 1;
		} else if (ch === "?") {
			regex += "[^/]";
			i += 1;
		} else {
			regex += escapeRegex(ch);
			i += 1;
		}
	}
	const anchor = leadingSlash ? "^" : "(^|/)";
	return new RegExp(`${anchor}${regex}(/|$)`);
}

function matchesGlob(path: string, pattern: string): boolean {
	return globToRegExp(pattern).test(path);
}

/* -------------------------------------------------------------------------- */
/* Result line formatting (TextContent)                                        */
/* -------------------------------------------------------------------------- */

function formatResultLine(item: QueryToolResultItem): string {
	switch (item.kind) {
		case "file": {
			const lang = item.language ?? "";
			const pkg = item.package ? `\t${item.package}` : "";
			return `FILE\t${item.path}\t${item.byteLength}\t${lang}${pkg}`;
		}
		case "symbol":
			return `SYMBOL\t${item.name}\t${item.symbolKind}\t${item.path}\t${item.startLine}-${item.endLine}`;
		case "reference":
			return `REFERENCE\t${item.symbol}\t${item.refKind}\t${item.path}\t${item.startLine}-${item.endLine}\t${item.certainty}`;
		case "context-item": {
			const range =
				item.startLine !== undefined && item.endLine !== undefined ? `\t${item.startLine}-${item.endLine}` : "";
			return `CONTEXT\t${item.path}${range}\t${item.score.toFixed(3)}\t${item.certainty}\t${item.reasons.join("+")}`;
		}
		case "diagnostic": {
			const code = item.code === undefined ? "" : `\t${item.code}`;
			const source = item.source ?? "typescript";
			return `DIAGNOSTIC\t${item.severity}\t${item.path}:${item.line}${code}\t${source}\t${item.message}`;
		}
	}
}

/* -------------------------------------------------------------------------- */
/* Intent dispatch                                                             */
/* -------------------------------------------------------------------------- */

interface DispatchContext {
	manifest: FileManifestEntry[];
	symbolIndex: SymbolEntry[];
	semanticAdapter: SemanticQueryAdapter;
	maxResults: number;
}

function findSymbolIntent(input: QueryToolInput, ctx: DispatchContext): QueryToolOutput {
	const findOptions: { language?: string; limit: number } = { limit: ctx.maxResults };
	if (input.options?.language !== undefined) findOptions.language = input.options.language;
	const found = findSymbols(ctx.symbolIndex, input.query, findOptions);
	const results: QueryToolResultItem[] = found.map((s) => {
		const out: QueryToolResultItem = {
			kind: "symbol",
			name: s.name,
			path: s.path,
			startLine: s.startLine,
			endLine: s.endLine,
			symbolKind: s.kind,
		};
		if (s.signature !== undefined) out.signature = s.signature;
		return out;
	});
	const truncated = found.length >= ctx.maxResults;
	return {
		intent: input.intent,
		query: input.query,
		results,
		truncated,
		totalCandidates: found.length,
		uncertainty: classifyUncertainty(results),
	};
}

async function findReferencesIntent(input: QueryToolInput, ctx: DispatchContext): Promise<QueryToolOutput> {
	// The semantic adapter is the LSP-shaped path. When the mock is in
	// play and no injection matches, fall back to the regex reference
	// scanner so the model still gets a useful answer.
	const refOptions: { maxResults: number; path?: string } = { maxResults: ctx.maxResults };
	if (input.options?.path !== undefined) refOptions.path = input.options.path;
	const sem = await ctx.semanticAdapter.getReferences(input.query, refOptions);
	// If the adapter is the mock returning `certainty: "unknown"`,
	// fall back to the regex scanner for a real answer.
	if (sem.relation === "reference" && sem.certainty === "unknown" && sem.locations.length === 0) {
		return runRegexReferences(input, ctx);
	}
	if (sem.relation !== "reference") {
		return {
			intent: input.intent,
			query: input.query,
			results: [],
			truncated: false,
			totalCandidates: 0,
			uncertainty: "high",
			note: sem.note ?? "Adapter did not return a reference result.",
		};
	}
	const truncated = sem.locations.length >= ctx.maxResults;
	const results: QueryToolResultItem[] = sem.locations.slice(0, ctx.maxResults).map((loc) => ({
		kind: "reference",
		path: loc.path,
		startLine: loc.startLine,
		endLine: loc.endLine,
		refKind: "unknown",
		symbol: input.query,
		certainty: sem.certainty,
	}));
	const output: QueryToolOutput = {
		intent: input.intent,
		query: input.query,
		results,
		truncated,
		totalCandidates: sem.locations.length,
		uncertainty: classifyCertainty(sem.certainty),
	};
	if (sem.relation === "reference" && sem.note !== undefined) {
		output.note = sem.note;
	}
	return output;
}

async function runRegexReferences(input: QueryToolInput, ctx: DispatchContext): Promise<QueryToolOutput> {
	const refOptions: {
		maxResults: number;
		includeComments?: boolean;
		includeStringLiterals?: boolean;
		paths?: string[];
	} = { maxResults: ctx.maxResults };
	if (input.options?.includeComments !== undefined) refOptions.includeComments = input.options.includeComments;
	if (input.options?.includeStringLiterals !== undefined) {
		refOptions.includeStringLiterals = input.options.includeStringLiterals;
	}
	if (input.options?.path !== undefined) refOptions.paths = [input.options.path];

	const refResult = await getReferences(input.query, ctx.manifest, ctx.symbolIndex, refOptions);
	const truncated = refResult.truncated;
	const results: QueryToolResultItem[] = refResult.references.map((r: Reference) => ({
		kind: "reference",
		path: r.path,
		startLine: r.startLine,
		endLine: r.endLine,
		refKind: r.kind,
		symbol: r.symbol,
		certainty: r.certainty,
	}));
	return {
		intent: input.intent,
		query: input.query,
		results,
		truncated,
		totalCandidates: refResult.totalMatches,
		uncertainty: classifyUncertainty(results),
		note: `coverage=${refResult.coverage.manifestVersion}`,
	};
}

function findFilesIntent(input: QueryToolInput, ctx: DispatchContext): QueryToolOutput {
	const index = getManifestIndex(ctx.manifest);
	const base: FileManifestEntry[] =
		input.options?.language !== undefined
			? getByLanguage(ctx.manifest, input.options.language)
			: ctx.manifest.slice();

	let filtered: FileManifestEntry[];
	if (input.options?.package !== undefined) {
		const byPkg = new Set(index.byPackage.get(input.options.package)?.map((e) => e.path) ?? []);
		filtered = base.filter((e) => byPkg.has(e.path));
	} else {
		filtered = base;
	}

	const query = input.query;
	const optionPath = input.options?.path;
	if (query.length > 0) {
		filtered = filtered.filter((e) => matchesGlob(e.path, query));
	}
	if (optionPath !== undefined && optionPath.length > 0) {
		filtered = filtered.filter((e) => matchesGlob(e.path, optionPath));
	}

	const truncated = filtered.length > ctx.maxResults;
	const sliced = truncated ? filtered.slice(0, ctx.maxResults) : filtered;
	const results: QueryToolResultItem[] = sliced.map((e) => {
		const item: QueryToolResultItem = {
			kind: "file",
			path: e.path,
			byteLength: e.byteLength,
			language: e.language,
		};
		if (e.package !== undefined) item.package = e.package;
		return item;
	});
	return {
		intent: input.intent,
		query: input.query,
		results,
		truncated,
		totalCandidates: filtered.length,
		uncertainty: classifyUncertainty(results),
	};
}

function mapRelevantContextItem(item: RelevantContextItem): QueryToolResultItem {
	switch (item.kind) {
		case "file":
			return {
				kind: "context-item",
				path: item.path,
				score: item.score,
				reasons: item.reasons,
				certainty: item.coverage,
			};
		case "symbol":
			return {
				kind: "context-item",
				path: item.path,
				startLine: item.startLine,
				endLine: item.endLine,
				score: item.score,
				reasons: item.reasons,
				certainty: item.certainty,
			};
		case "reference":
			return {
				kind: "context-item",
				path: item.path,
				startLine: item.startLine,
				endLine: item.endLine,
				score: 0.5,
				reasons: [`ref:${item.refKind}`],
				certainty: item.certainty,
			};
		case "diagnostic":
			return {
				kind: "context-item",
				path: item.file,
				startLine: item.line,
				endLine: item.line,
				score: 1.0,
				reasons: ["diagnostic"],
				certainty: "exact",
			};
	}
}

async function findRelevantContextIntent(input: QueryToolInput, ctx: DispatchContext): Promise<QueryToolOutput> {
	const hints: TaskQuery["hints"] = {};
	if (input.options?.path !== undefined) hints.explicitPaths = [input.options.path];
	const identifiers = extractIdentifiersFromTask(input.query);
	if (identifiers.length > 0) {
		hints.explicitSymbols = identifiers;
		hints.keywords = identifiers;
	}
	hints.budget = ctx.maxResults;

	// When the user passes a path hint, also pull diagnostics for that
	// path from the semantic adapter and feed them as
	// `hints.diagnostics` so the relevant-context bundle includes any
	// existing compile / lint errors anchored to the same file.
	if (input.options?.path !== undefined) {
		const diagnostics = await ctx.semanticAdapter.getDiagnostics({
			path: input.options.path,
			includeWarnings: input.options?.includeWarnings,
		});
		if (diagnostics.length > 0) {
			hints.diagnostics = diagnostics.map((d) => {
				const entry: { file: string; line: number; code?: string } = {
					file: d.file,
					line: d.line,
				};
				if (d.code !== undefined) {
					// `hints.diagnostics.code` is string-only; coerce
					// numeric TypeScript error codes to their TS-prefixed
					// string form so the relevant-context bundle keeps a
					// single representation.
					entry.code = typeof d.code === "number" ? `TS${d.code}` : d.code;
				}
				return entry;
			});
		}
	}

	const context = await getRelevantContext({ task: input.query, hints }, ctx.manifest, ctx.symbolIndex);

	const truncated = context.truncated;
	const sliced = context.items.slice(0, ctx.maxResults);
	const results: QueryToolResultItem[] = sliced.map(mapRelevantContextItem);
	return {
		intent: input.intent,
		query: input.query,
		results,
		truncated,
		totalCandidates: context.totalCandidates,
		uncertainty: context.uncertainty,
	};
}

async function getDefinitionIntent(input: QueryToolInput, ctx: DispatchContext): Promise<QueryToolOutput> {
	const defOptions: { path?: string } = {};
	if (input.options?.path !== undefined) defOptions.path = input.options.path;
	const result: SemanticResult = await ctx.semanticAdapter.getDefinition(input.query, defOptions);
	if (result.relation !== "definition") {
		return {
			intent: input.intent,
			query: input.query,
			results: [],
			truncated: false,
			totalCandidates: 0,
			uncertainty: "high",
			note: result.note ?? "Adapter did not return a definition result.",
		};
	}
	const head = result.locations[0];
	if (!head) {
		const output: QueryToolOutput = {
			intent: input.intent,
			query: input.query,
			results: [],
			truncated: false,
			totalCandidates: 0,
			uncertainty: classifyCertainty(result.certainty),
		};
		if (result.note !== undefined) output.note = result.note;
		return output;
	}
	const truncated = result.locations.length > ctx.maxResults;
	const item: QueryToolResultItem = {
		kind: "context-item",
		path: head.path,
		startLine: head.startLine,
		endLine: head.endLine,
		score: 1.0,
		reasons: ["explicit-definition"],
		certainty: result.certainty,
	};
	const output: QueryToolOutput = {
		intent: input.intent,
		query: input.query,
		results: [item],
		truncated,
		totalCandidates: result.locations.length,
		uncertainty: classifyCertainty(result.certainty),
	};
	if (result.note !== undefined) output.note = result.note;
	return output;
}

async function getDiagnosticsIntent(input: QueryToolInput, ctx: DispatchContext): Promise<QueryToolOutput> {
	const options: { path?: string; includeWarnings?: boolean } = {};
	if (input.options?.path !== undefined) options.path = input.options.path;
	if (input.options?.includeWarnings !== undefined) options.includeWarnings = input.options.includeWarnings;
	const diagnostics = await ctx.semanticAdapter.getDiagnostics(options);
	const truncated = diagnostics.length > ctx.maxResults;
	const sliced = truncated ? diagnostics.slice(0, ctx.maxResults) : diagnostics;
	const results: QueryToolResultItem[] = sliced.map((d) => {
		const item: QueryToolResultItem = {
			kind: "diagnostic",
			path: d.file,
			line: d.line,
			severity: d.severity,
			message: d.message,
			timestamp: d.timestamp,
			certainty: "exact",
		};
		if (d.column !== undefined) item.column = d.column;
		if (d.code !== undefined) item.code = d.code;
		if (d.source !== undefined) item.source = d.source;
		if (d.snapshotId !== undefined) item.snapshotId = d.snapshotId;
		return item;
	});
	return {
		intent: input.intent,
		query: input.query,
		results,
		truncated,
		totalCandidates: diagnostics.length,
		uncertainty: "low",
	};
}

/* -------------------------------------------------------------------------- */
/* Uncertainty classification                                                  */
/* -------------------------------------------------------------------------- */

function classifyCertainty(certainty: string): "low" | "medium" | "high" {
	if (certainty === "exact") return "low";
	if (certainty === "candidate" || certainty === "lexical") return "medium";
	return "high";
}

function classifyUncertainty(results: QueryToolResultItem[]): "low" | "medium" | "high" {
	if (results.length === 0) return "high";
	let best: "low" | "medium" | "high" = "low";
	for (const item of results) {
		// `file` and `symbol` results come straight from the manifest
		// and syntax index respectively; they are factual and carry
		// no certainty tag to aggregate over.
		if (item.kind === "file" || item.kind === "symbol") continue;
		const c = classifyCertainty(item.certainty);
		if (c === "high") return "high";
		if (c === "medium") best = "medium";
	}
	return best;
}

/* -------------------------------------------------------------------------- */
/* Public factory                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A snapshot of the data the `query` tool needs to answer one query.
 */
export interface QueryToolDataSnapshot {
	manifest: FileManifestEntry[];
	symbolIndex: SymbolEntry[];
	semanticAdapter: SemanticQueryAdapter;
}

/**
 * Live data source for the `query` tool. The tool resolves a fresh
 * snapshot via `getData()` at the start of every `execute()` call, so
 * a worktree mutation (followed by a `LiveQueryToolData.refresh()` in
 * the session's afterToolCall path) is reflected in the very next
 * query without rebuilding the tool or reloading the session.
 *
 * `LiveQueryToolData` itself satisfies this shape: pass
 * `{ getData: () => live.getToolData() }`.
 */
export interface QueryToolDataSource {
	getData(): Promise<QueryToolDataSnapshot>;
}

function isQueryToolDataSource(value: FileManifestEntry[] | QueryToolDataSource): value is QueryToolDataSource {
	return typeof (value as QueryToolDataSource).getData === "function";
}

/**
 * Create the `query` tool. The factory closes over the data layers
 * (manifest, syntax index, semantic adapter) so the model can call the
 * tool with just an intent and a query string.
 *
 * Two forms are supported:
 *
 *   - **Live source** (preferred): a `QueryToolDataSource` whose
 *     `getData()` resolves a fresh snapshot at the start of every
 *     call. Back it with `LiveQueryToolData.getToolData()` so the tool
 *     never serves a stale frozen array.
 *   - **Frozen snapshot**: explicit `manifest` / `symbolIndex` /
 *     `semanticAdapter` arrays, captured once at factory time. Kept
 *     for callers that manage their own data and tests.
 *
 * `options.root` is reserved for future diagnostic logging (e.g. log
 * lines carrying the worktree root); it is not currently used.
 */
export function createQueryTool(
	dataSource: QueryToolDataSource,
	options?: CreateQueryToolOptions,
): AgentTool<typeof querySchema, QueryToolDetails>;
export function createQueryTool(
	manifest: FileManifestEntry[],
	symbolIndex: SymbolEntry[],
	semanticAdapter: SemanticQueryAdapter,
	options?: CreateQueryToolOptions,
): AgentTool<typeof querySchema, QueryToolDetails>;
export function createQueryTool(
	manifestOrSource: FileManifestEntry[] | QueryToolDataSource,
	symbolIndexOrOptions?: SymbolEntry[] | CreateQueryToolOptions,
	semanticAdapterOrOptions?: SemanticQueryAdapter | CreateQueryToolOptions,
	options?: CreateQueryToolOptions,
): AgentTool<typeof querySchema, QueryToolDetails> {
	let getData: () => Promise<QueryToolDataSnapshot>;
	if (isQueryToolDataSource(manifestOrSource)) {
		// Live form: resolve a fresh snapshot at the start of each call.
		const source = manifestOrSource;
		getData = source.getData.bind(source);
	} else {
		// Frozen form: capture the arrays once at factory time.
		const manifest = manifestOrSource;
		const symbolIndex = symbolIndexOrOptions as SymbolEntry[];
		const semanticAdapter = semanticAdapterOrOptions as SemanticQueryAdapter;
		getData = async () => ({ manifest, symbolIndex, semanticAdapter });
	}
	// The `options` argument (live form: `symbolIndexOrOptions`; frozen
	// form: `options`) is reserved for future diagnostic logging (e.g.
	// log lines carrying the worktree root); it is not currently used.
	void symbolIndexOrOptions;
	void semanticAdapterOrOptions;
	void options;

	const definition: ToolDefinition<typeof querySchema, QueryToolDetails> = {
		name: "query",
		label: "query",
		description:
			"Run a structured, read-only query against the repository: symbol lookup, reference search, file filtering, relevant context assembly, or definition lookup. Returns structured results with paths, line numbers, certainty, and uncertainty.",
		promptSnippet: queryToolSystemPromptContribution.snippet,
		promptGuidelines: [...queryToolSystemPromptContribution.guidelines],
		parameters: querySchema,
		async execute(
			_toolCallId,
			params: { intent: string; query: string; options?: QueryToolInputOptions },
			_signal: AbortSignal | undefined,
			_onUpdate: ((update: { content: TextContent[]; details: QueryToolDetails }) => void) | undefined,
			_ctx?: ExtensionContext,
		) {
			if (!isValidIntent(params.intent)) {
				const output: QueryToolOutput = {
					intent: "find-symbol",
					query: params.query,
					results: [],
					truncated: false,
					totalCandidates: 0,
					uncertainty: "high",
					note: `Invalid intent "${params.intent}". Valid: ${Array.from(VALID_INTENTS).join(", ")}.`,
				};
				const content: TextContent[] = [{ type: "text", text: `[query] invalid intent "${params.intent}"` }];
				return { content, details: { output } };
			}
			const input: QueryToolInput = {
				intent: params.intent,
				query: params.query,
				...(params.options !== undefined ? { options: params.options } : {}),
			};
			const maxResults = input.options?.maxResults ?? DEFAULT_MAX_RESULTS;
			// Resolve a fresh data snapshot for THIS call so worktree
			// mutations since the previous query (with a
			// `LiveQueryToolData.refresh()` in between, driven by the
			// session's afterToolCall path) are reflected immediately,
			// without a session reload or tool rebuild.
			const { manifest, symbolIndex, semanticAdapter } = await getData();
			const dispatchCtx: DispatchContext = { manifest, symbolIndex, semanticAdapter, maxResults };

			let output: QueryToolOutput;
			switch (input.intent) {
				case "find-symbol":
					output = findSymbolIntent(input, dispatchCtx);
					break;
				case "find-references":
					output = await findReferencesIntent(input, dispatchCtx);
					break;
				case "find-files":
					output = findFilesIntent(input, dispatchCtx);
					break;
				case "find-relevant-context":
					output = await findRelevantContextIntent(input, dispatchCtx);
					break;
				case "get-definition":
					output = await getDefinitionIntent(input, dispatchCtx);
					break;
				case "get-diagnostics":
					output = await getDiagnosticsIntent(input, dispatchCtx);
					break;
			}

			const lines = output.results.map(formatResultLine);
			let text: string;
			if (lines.length === 0) {
				text = `[${output.intent}] no results for "${output.query}" (uncertainty=${output.uncertainty})`;
			} else {
				text = lines.join("\n");
				const footerParts: string[] = [];
				if (output.truncated) footerParts.push("truncated");
				footerParts.push(`uncertainty=${output.uncertainty}`);
				if (output.totalCandidates !== output.results.length) {
					footerParts.push(`total=${output.totalCandidates}`);
				}
				text += `\n\n[${output.intent} returned ${output.results.length} result(s); ${footerParts.join("; ")}]`;
			}
			if (output.note !== undefined) {
				text += `\n[note: ${output.note}]`;
			}
			const content: TextContent[] = [{ type: "text", text }];
			return { content, details: { output } };
		},
	};

	return wrapToolDefinition(definition) as AgentTool<typeof querySchema, QueryToolDetails>;
}

export type QueryToolSchema = typeof querySchema;

