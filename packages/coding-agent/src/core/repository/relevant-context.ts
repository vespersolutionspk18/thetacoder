/**
 * F1 `getRelevantContext` — higher-level unified query API.
 *
 * Assembles a bounded candidate context for an agent task from the F1
 * data layers (manifest, syntax index, optional reference results).
 * Selection reasons and uncertainty are exposed alongside the items
 * so callers can decide how much to trust the bundle.
 *
 * ## Design
 *
 * The audit (Section 11.3) calls for a single function that:
 *   - starts with explicit identifiers, paths, diagnostics, changed
 *     symbols, lexical matching, and bounded graph expansion
 *   - exposes selection reasons and uncertainty for every item
 *   - is NOT marketed as exact relevance — natural-language intent
 *     may still require model interpretation
 *
 * This module is the "selection reasons + uncertainty" half. The
 * candidate assembly is intentionally simple: each hint category
 * contributes items with a score, reason, and certainty; lexical
 * matching adds a softer layer; natural-language identifier extraction
 * feeds the symbol lookup path.
 *
 * The function does not perform any I/O. It only consumes the data
 * layers already produced by `manifest.ts` / `syntax-index.ts`. The
 * optional `referenceResults` map is keyed by the symbol name and
 * contains the `Reference[]` returned by `getReferences` (so callers
 * can pre-compute references for `changedSymbols` and pass them in).
 */

import type { FileManifestEntry } from "./manifest.ts";
import type { Reference, ReferenceKind } from "./references.ts";
import type { SymbolEntry } from "./syntax-index.ts";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Hints attached to a `TaskQuery` to steer context selection.
 *
 * Every field is optional. When multiple are set, all of them
 * contribute items — the result is the union, sorted by score, then
 * truncated to the budget.
 */
export interface TaskQueryHints {
	/** Paths the task explicitly mentions. Matched against `FileManifestEntry.path`. */
	explicitPaths?: string[];
	/** Symbol names the task explicitly mentions. Matched against `SymbolEntry.name`. */
	explicitSymbols?: string[];
	/** Symbols known to have changed recently (e.g. from `git diff`). */
	changedSymbols?: string[];
	/** Recent diagnostics (errors / warnings) the task should consider. */
	diagnostics?: { file: string; line: number; code?: string }[];
	/** Free-form keywords for lexical matching against paths and symbol names. */
	keywords?: string[];
	/** Maximum number of items in the result. Default 50. */
	budget?: number;
}

/** A query for relevant context. The `task` is the natural-language description. */
export interface TaskQuery {
	task: string;
	hints?: TaskQueryHints;
}

/** One item in a `RelevantContext`. Discriminated by `kind`. */
export type RelevantContextItem =
	| {
			kind: "file";
			path: string;
			score: number;
			reasons: string[];
			coverage: "exact" | "lexical" | "fuzzy";
	  }
	| {
			kind: "symbol";
			name: string;
			path: string;
			startLine: number;
			endLine: number;
			score: number;
			reasons: string[];
			certainty: "exact" | "lexical";
	  }
	| {
			kind: "reference";
			path: string;
			startLine: number;
			endLine: number;
			symbol: string;
			refKind: ReferenceKind;
			certainty: "exact" | "lexical" | "fuzzy";
	  }
	| {
			kind: "diagnostic";
			file: string;
			line: number;
			code?: string;
			message: string;
			severity: "error" | "warning";
	  };

/** Bounded candidate context assembled from the F1 data layers. */
export interface RelevantContext {
	items: RelevantContextItem[];
	/** Number of candidate items considered before truncation. */
	totalCandidates: number;
	/** `true` when `items.length` hit the budget. */
	truncated: boolean;
	/** How many items each source category produced before truncation. */
	selectionSummary: {
		filesConsidered: number;
		symbolsConsidered: number;
		referencesConsidered: number;
		diagnosticsConsidered: number;
	};
	/**
	 * Aggregate confidence in the bundle.
	 *   - "low" when every item is `certainty: "exact"` and at least one
	 *     reason is `"explicit-..."` or `"diagnostic"`.
	 *   - "high" when the bundle is empty, or when no items are exact.
	 *   - "medium" otherwise.
	 */
	uncertainty: "low" | "medium" | "high";
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const DEFAULT_BUDGET = 50;

/** Words that the natural-language extractor skips (English stopwords). */
const STOPWORDS = new Set([
	"a",
	"an",
	"the",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"should",
	"could",
	"may",
	"might",
	"must",
	"can",
	"this",
	"that",
	"these",
	"those",
	"it",
	"its",
]);

/**
 * Regex used to extract identifiers from the natural-language `task`.
 * Matches: CamelCase, lowerCamel with an internal upper, snake_case,
 * and kebab-case tokens. Dotted paths are also captured via the
 * `[^.\s]+` group, but only after one of the other patterns has
 * matched — see `extractIdentifiersFromTask`.
 */
const IDENTIFIER_RE = /[A-Z][a-zA-Z0-9]+|[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*|[a-z][a-z0-9_]+|[a-z][a-z0-9-]+/g;

/* -------------------------------------------------------------------------- */
/* Natural-language identifier extraction                                      */
/* -------------------------------------------------------------------------- */

/**
 * Pull identifiers out of a free-form task description.
 *
 * Skips tokens shorter than 2 characters and the English stopword set.
 * The output is deduplicated in first-seen order so the result is
 * stable for a given input.
 */
export function extractIdentifiersFromTask(task: string): string[] {
	if (task.length === 0) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const match of task.matchAll(IDENTIFIER_RE)) {
		const raw = match[0];
		if (raw.length < 2) continue;
		if (STOPWORDS.has(raw.toLowerCase())) continue;
		if (seen.has(raw)) continue;
		seen.add(raw);
		out.push(raw);
	}
	return out;
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

function normalizePath(path: string): string {
	return path.split("\\").join("/");
}

interface MatchResult<T> {
	items: T[];
	considered: number;
}

function matchExplicitPaths(
	hints: string[],
	manifest: FileManifestEntry[],
): MatchResult<RelevantContextItem & { kind: "file" }> {
	const wanted = new Set(hints.map(normalizePath));
	const items: RelevantContextItem[] = [];
	for (const entry of manifest) {
		if (wanted.has(entry.path)) {
			items.push({
				kind: "file",
				path: entry.path,
				score: 1.0,
				reasons: ["explicit-path"],
				coverage: "exact",
			});
		}
	}
	return { items: items as Array<RelevantContextItem & { kind: "file" }>, considered: items.length };
}

function matchExplicitSymbols(
	hints: string[],
	symbolIndex: SymbolEntry[],
): MatchResult<RelevantContextItem & { kind: "symbol" }> {
	const wanted = new Set(hints);
	const items: RelevantContextItem[] = [];
	for (const sym of symbolIndex) {
		if (wanted.has(sym.name)) {
			items.push({
				kind: "symbol",
				name: sym.name,
				path: sym.path,
				startLine: sym.startLine,
				endLine: sym.endLine,
				score: 1.0,
				reasons: ["explicit-symbol"],
				certainty: "exact",
			});
		}
	}
	return {
		items: items as Array<RelevantContextItem & { kind: "symbol" }>,
		considered: items.length,
	};
}

interface ReferenceBundle {
	symbolItems: RelevantContextItem[];
	referenceItems: RelevantContextItem[];
	referencesConsidered: number;
}

function matchChangedSymbols(
	hints: string[],
	symbolIndex: SymbolEntry[],
	referenceResults: Map<string, Reference[]> | undefined,
): ReferenceBundle {
	const wanted = new Set(hints);
	const symbolItems: RelevantContextItem[] = [];
	const seenSymbolKeys = new Set<string>();
	let referencesConsidered = 0;

	for (const sym of symbolIndex) {
		if (!wanted.has(sym.name)) continue;
		const key = `${sym.path}::${sym.startLine}::${sym.name}`;
		if (seenSymbolKeys.has(key)) continue;
		seenSymbolKeys.add(key);
		symbolItems.push({
			kind: "symbol",
			name: sym.name,
			path: sym.path,
			startLine: sym.startLine,
			endLine: sym.endLine,
			score: 0.9,
			reasons: ["changed-symbol"],
			certainty: "exact",
		});
	}

	const referenceItems: RelevantContextItem[] = [];
	if (referenceResults !== undefined) {
		for (const name of hints) {
			const refs = referenceResults.get(name) ?? [];
			referencesConsidered += refs.length;
			for (const ref of refs) {
				referenceItems.push({
					kind: "reference",
					path: ref.path,
					startLine: ref.startLine,
					endLine: ref.endLine,
					symbol: ref.symbol,
					refKind: ref.kind,
					certainty: ref.certainty,
				});
			}
		}
	}

	return { symbolItems, referenceItems, referencesConsidered };
}

function matchDiagnostics(
	hints: { file: string; line: number; code?: string }[],
): MatchResult<RelevantContextItem & { kind: "diagnostic" }> {
	const items: RelevantContextItem[] = [];
	for (const d of hints) {
		items.push({
			kind: "diagnostic",
			file: normalizePath(d.file),
			line: d.line,
			code: d.code,
			message: "diagnostic",
			severity: "error",
		});
	}
	return {
		items: items as Array<RelevantContextItem & { kind: "diagnostic" }>,
		considered: items.length,
	};
}

/**
 * Lexical match against file paths and symbol names.
 *
 * Each keyword contributes to a file's score when it appears in the
 * path; each contributes to a symbol's score when it appears in the
 * name. Per-item score = 0.3 + 0.1 * matches, capped at 0.7. Items
 * with no matches are dropped.
 */
function matchKeywords(
	hints: string[],
	manifest: FileManifestEntry[],
	symbolIndex: SymbolEntry[],
): { items: RelevantContextItem[]; filesConsidered: number; symbolsConsidered: number } {
	if (hints.length === 0) {
		return { items: [], filesConsidered: 0, symbolsConsidered: 0 };
	}
	const lowered = hints.map((k) => k.toLowerCase());
	const items: RelevantContextItem[] = [];

	// File-path lexical matches.
	const fileHits = new Map<string, number>();
	for (const entry of manifest) {
		const path = entry.path.toLowerCase();
		let hits = 0;
		for (const k of lowered) {
			if (path.includes(k)) hits += 1;
		}
		if (hits > 0) fileHits.set(entry.path, hits);
	}
	for (const [path, hits] of fileHits) {
		const score = Math.min(0.7, 0.3 + 0.1 * hits);
		items.push({
			kind: "file",
			path,
			score,
			reasons: ["keyword"],
			coverage: "lexical",
		});
	}

	// Symbol-name lexical matches.
	const symbolHits = new Map<string, number>();
	for (const sym of symbolIndex) {
		const name = sym.name.toLowerCase();
		let hits = 0;
		for (const k of lowered) {
			if (name.includes(k)) hits += 1;
		}
		if (hits > 0) symbolHits.set(`${sym.path}::${sym.startLine}::${sym.name}`, hits);
	}
	for (const sym of symbolIndex) {
		const key = `${sym.path}::${sym.startLine}::${sym.name}`;
		const hits = symbolHits.get(key);
		if (hits === undefined) continue;
		const score = Math.min(0.7, 0.3 + 0.1 * hits);
		items.push({
			kind: "symbol",
			name: sym.name,
			path: sym.path,
			startLine: sym.startLine,
			endLine: sym.endLine,
			score,
			reasons: ["keyword"],
			certainty: "lexical",
		});
	}

	return { items, filesConsidered: fileHits.size, symbolsConsidered: symbolHits.size };
}

function matchNaturalLanguage(
	task: string,
	manifest: FileManifestEntry[],
	symbolIndex: SymbolEntry[],
): { items: RelevantContextItem[]; filesConsidered: number; symbolsConsidered: number } {
	const identifiers = extractIdentifiersFromTask(task);
	if (identifiers.length === 0) {
		return { items: [], filesConsidered: 0, symbolsConsidered: 0 };
	}
	// Reuse keyword path with the identifier set.
	return matchKeywords(identifiers, manifest, symbolIndex);
}

/* -------------------------------------------------------------------------- */
/* Deduplication                                                              */
/* -------------------------------------------------------------------------- */

const COVERAGE_RANK: Record<"exact" | "lexical" | "fuzzy", number> = { exact: 2, lexical: 1, fuzzy: 0 };
const CERTAINTY_RANK: Record<"exact" | "lexical" | "fuzzy", number> = { exact: 2, lexical: 1, fuzzy: 0 };

function dedupKey(item: RelevantContextItem): string {
	switch (item.kind) {
		case "file":
			return `file:${item.path}`;
		case "symbol":
			return `symbol:${item.path}:${item.startLine}:${item.name}`;
		case "reference":
			return `reference:${item.path}:${item.startLine}:${item.symbol}:${item.refKind}`;
		case "diagnostic":
			return `diagnostic:${item.file}:${item.line}:${item.code ?? ""}`;
	}
}

/**
 * Merge an incoming item into the existing one stored at `key`. The
 * merged item keeps the higher score, the best coverage / certainty,
 * and the union of reasons.
 */
function mergeItem(existing: RelevantContextItem, incoming: RelevantContextItem): RelevantContextItem {
	if (existing.kind !== incoming.kind) return existing; // mixed kinds shouldn't share a key
	if (existing.kind === "file" && incoming.kind === "file") {
		const reasons = unionReasons(existing.reasons, incoming.reasons);
		const coverage =
			COVERAGE_RANK[existing.coverage] >= COVERAGE_RANK[incoming.coverage] ? existing.coverage : incoming.coverage;
		return {
			kind: "file",
			path: existing.path,
			score: Math.max(existing.score, incoming.score),
			reasons,
			coverage,
		};
	}
	if (existing.kind === "symbol" && incoming.kind === "symbol") {
		const reasons = unionReasons(existing.reasons, incoming.reasons);
		const certainty =
			CERTAINTY_RANK[existing.certainty] >= CERTAINTY_RANK[incoming.certainty]
				? existing.certainty
				: incoming.certainty;
		return {
			kind: "symbol",
			name: existing.name,
			path: existing.path,
			startLine: existing.startLine,
			endLine: existing.endLine,
			score: Math.max(existing.score, incoming.score),
			reasons,
			certainty,
		};
	}
	// References and diagnostics: first writer wins, no merge needed.
	return existing;
}

function unionReasons(a: string[], b: string[]): string[] {
	const out = [...a];
	for (const r of b) if (!out.includes(r)) out.push(r);
	return out;
}

/* -------------------------------------------------------------------------- */
/* Uncertainty classification                                                 */
/* -------------------------------------------------------------------------- */

function classifyUncertainty(items: RelevantContextItem[]): "low" | "medium" | "high" {
	if (items.length === 0) return "high";

	let allExact = true;
	let allFuzzy = true;
	let hasExplicitOrDiagnostic = false;

	for (const item of items) {
		const itemExact = itemIsExact(item);
		const itemFuzzy = itemIsFuzzy(item);

		if (!itemExact) allExact = false;
		if (!itemFuzzy) allFuzzy = false;

		if (itemHasExplicitOrDiagnosticReason(item)) hasExplicitOrDiagnostic = true;
	}

	if (allFuzzy) return "high";
	if (allExact && hasExplicitOrDiagnostic) return "low";
	return "medium";
}

function itemIsExact(item: RelevantContextItem): boolean {
	switch (item.kind) {
		case "file":
			return item.coverage === "exact";
		case "symbol":
		case "reference":
			return item.certainty === "exact";
		case "diagnostic":
			return true;
	}
}

function itemIsFuzzy(item: RelevantContextItem): boolean {
	switch (item.kind) {
		case "file":
			return item.coverage === "fuzzy";
		case "symbol":
		case "reference":
			return item.certainty === "fuzzy";
		case "diagnostic":
			return false;
	}
}

function itemHasExplicitOrDiagnosticReason(item: RelevantContextItem): boolean {
	if (item.kind === "diagnostic") return true;
	if (item.kind === "reference") return false;
	const explicitReasons = new Set(["explicit-path", "explicit-symbol", "changed-symbol", "diagnostic"]);
	return item.reasons.some((r) => explicitReasons.has(r));
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build a `RelevantContext` for the given `TaskQuery`.
 *
 * The function is async only to keep the API forward-compatible with
 * a future implementation that may need to await per-file reads or
 * async reference scans. The current implementation is purely
 * synchronous over the inputs.
 *
 * Items are collected from every source and deduplicated by a stable
 * key (file path, symbol path+line+name, reference path+line+symbol+
 * kind, diagnostic file+line+code). On a duplicate, the higher score
 * wins, the better coverage/certainty wins, and reasons are unioned.
 */
export async function getRelevantContext(
	query: TaskQuery,
	manifest: FileManifestEntry[],
	symbolIndex: SymbolEntry[],
	referenceResults?: Map<string, Reference[]>,
): Promise<RelevantContext> {
	const hints = query.hints ?? {};
	const budget = hints.budget ?? DEFAULT_BUDGET;

	const itemsByKey = new Map<string, RelevantContextItem>();
	const insert = (item: RelevantContextItem): void => {
		const key = dedupKey(item);
		const existing = itemsByKey.get(key);
		if (existing === undefined) {
			itemsByKey.set(key, item);
		} else {
			itemsByKey.set(key, mergeItem(existing, item));
		}
	};

	let filesConsidered = 0;
	let symbolsConsidered = 0;
	let referencesConsidered = 0;
	let diagnosticsConsidered = 0;

	// 1. Explicit paths.
	if (hints.explicitPaths && hints.explicitPaths.length > 0) {
		const r = matchExplicitPaths(hints.explicitPaths, manifest);
		filesConsidered += r.considered;
		for (const item of r.items) insert(item);
	}

	// 2. Explicit symbols.
	if (hints.explicitSymbols && hints.explicitSymbols.length > 0) {
		const r = matchExplicitSymbols(hints.explicitSymbols, symbolIndex);
		symbolsConsidered += r.considered;
		for (const item of r.items) insert(item);
	}

	// 3. Changed symbols (+ their pre-computed references).
	if (hints.changedSymbols && hints.changedSymbols.length > 0) {
		const r = matchChangedSymbols(hints.changedSymbols, symbolIndex, referenceResults);
		symbolsConsidered += r.symbolItems.length;
		referencesConsidered += r.referencesConsidered;
		for (const item of r.symbolItems) insert(item);
		for (const item of r.referenceItems) insert(item);
	}

	// 4. Diagnostics.
	if (hints.diagnostics && hints.diagnostics.length > 0) {
		const r = matchDiagnostics(hints.diagnostics);
		diagnosticsConsidered += r.considered;
		for (const item of r.items) insert(item);
	}

	// 5. Keywords (lexical).
	if (hints.keywords && hints.keywords.length > 0) {
		const r = matchKeywords(hints.keywords, manifest, symbolIndex);
		filesConsidered += r.filesConsidered;
		symbolsConsidered += r.symbolsConsidered;
		for (const item of r.items) insert(item);
	}

	// 6. Natural-language identifier extraction from `query.task`.
	const nl = matchNaturalLanguage(query.task, manifest, symbolIndex);
	filesConsidered += nl.filesConsidered;
	symbolsConsidered += nl.symbolsConsidered;
	for (const item of nl.items) insert(item);

	// 7. For every explicit/changed symbol, also include the references
	//    from `referenceResults` if they were not already contributed.
	if (referenceResults !== undefined) {
		const symbolNames = new Set<string>();
		for (const item of itemsByKey.values()) {
			if (item.kind === "symbol") symbolNames.add(item.name);
		}
		for (const name of symbolNames) {
			const refs = referenceResults.get(name) ?? [];
			referencesConsidered += refs.length;
			for (const ref of refs) {
				insert({
					kind: "reference",
					path: ref.path,
					startLine: ref.startLine,
					endLine: ref.endLine,
					symbol: ref.symbol,
					refKind: ref.kind,
					certainty: ref.certainty,
				});
			}
		}
	}

	// 8. Sort by score desc, then by kind/file/line for stability, then truncate.
	const allItems = Array.from(itemsByKey.values());
	const totalCandidates = allItems.length;
	const sorted = [...allItems].sort(compareItems);
	const truncated = sorted.length > budget;
	const items = truncated ? sorted.slice(0, budget) : sorted;

	const uncertainty = classifyUncertainty(items);

	return {
		items,
		totalCandidates,
		truncated,
		selectionSummary: {
			filesConsidered,
			symbolsConsidered,
			referencesConsidered,
			diagnosticsConsidered,
		},
		uncertainty,
	};
}

function compareItems(a: RelevantContextItem, b: RelevantContextItem): number {
	const scoreA = itemScore(a);
	const scoreB = itemScore(b);
	if (scoreA !== scoreB) return scoreB - scoreA;
	return stableKey(a).localeCompare(stableKey(b));
}

function itemScore(item: RelevantContextItem): number {
	if (item.kind === "file" || item.kind === "symbol") return item.score;
	// References and diagnostics have no explicit score; use 0.5 as a
	// neutral middle so they sort between high-score hints and
	// discardable lexical noise. Diagnostics are surfaced separately
	// for callers, but here we just need a stable comparator.
	return 0.5;
}

function stableKey(item: RelevantContextItem): string {
	switch (item.kind) {
		case "file":
			return `file:${item.path}`;
		case "symbol":
			return `symbol:${item.path}:${item.startLine}:${item.name}`;
		case "reference":
			return `reference:${item.path}:${item.startLine}:${item.symbol}:${item.refKind}`;
		case "diagnostic":
			return `diagnostic:${item.file}:${item.line}:${item.code ?? ""}`;
	}
}

