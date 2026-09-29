/**
 * F1-backed variants of the read-only structural discovery tools.
 *
 * The standard `grep` / `find` / `ls` tools spawn ripgrep / fd / `readdir`
 * against the filesystem on every call. The F1 layer already maintains a
 * pre-built `FileManifestEntry[]` and `SymbolEntry[]`; this module exposes
 * three tools that query those indexes in-process instead of hitting the
 * filesystem. They are faster, can be used in environments without those
 * binaries, and can run inside sandboxed processes that cannot spawn
 * subprocesses.
 *
 * Each tool advertises in its description that it is F1-backed and may
 * miss files outside the worktree. The caller is responsible for falling
 * back to the original tool when the manifest is empty (e.g. for files
 * the F1 layer was never built for). The tools themselves always return
 * an empty result on an empty manifest — they do NOT silently delegate
 * to the original implementation.
 */

import type { AgentTool } from "@theta/agent-core";
import type { TextContent } from "@theta/ai";
import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import type { FileManifestEntry } from "../repository/manifest.ts";
import type { SymbolEntry } from "../repository/syntax-index.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface F1ReadOnlyToolOptions {
	/**
	 * Frozen snapshot form: the manifest captured at construction time.
	 * Required unless `getData` is provided.
	 */
	manifest?: FileManifestEntry[];
	/**
	 * Frozen snapshot form: the symbol index captured at construction
	 * time. Required unless `getData` is provided.
	 */
	symbolIndex?: SymbolEntry[];
	/**
	 * Live source form (preferred): resolves the current
	 * manifest / symbol index at the start of every tool call. When
	 * supplied it wins over the frozen fields, so a worktree mutation
	 * (with a `LiveQueryToolData.refresh()` in between) is reflected in
	 * the next call without rebuilding the tools.
	 */
	getData?: () => Promise<{ manifest: FileManifestEntry[]; symbolIndex: SymbolEntry[] }>;
	/** Worktree root. Accepted for parity with other tool factories; the manifest is already relative to it. */
	cwd: string;
	/**
	 * Include generated files (dist/, build/, *.generated.*, etc.) in the
	 * results. Default false: the standard F1 generated-file filter applies
	 * to all three tools.
	 */
	includeGenerated?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 1000;
const DEFAULT_LS_LIMIT = 500;

/* -------------------------------------------------------------------------- */
/* Schemas (TypeBox)                                                          */
/* -------------------------------------------------------------------------- */

const f1GrepSchema = Type.Object({
	pattern: Type.String({
		description: "Substring to match against symbol names (case-insensitive by default)",
	}),
	path: Type.Optional(Type.String({ description: "Restrict to files under this path prefix (e.g. 'src/agent/')" })),
	kind: Type.Optional(Type.String({ description: "Filter by symbol kind (e.g. 'function', 'class', 'interface')" })),
	language: Type.Optional(Type.String({ description: "Filter by source language (e.g. 'typescript')" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive name match (default: true)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum matches to return (default: 100)" })),
});

const f1FindSchema = Type.Object({
	pattern: Type.Optional(Type.String({ description: "Glob pattern to match against file paths (default: '**/*')" })),
	language: Type.Optional(Type.String({ description: "Restrict to this source language (e.g. 'typescript')" })),
	package: Type.Optional(Type.String({ description: "Restrict to this package name" })),
	limit: Type.Optional(Type.Number({ description: "Maximum files to return (default: 1000)" })),
});

const f1LsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory prefix to list (default: entire manifest)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum entries to return (default: 500)" })),
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Convert native path separators to forward slashes for consistent matching. */
function toPosix(p: string): string {
	return p.split("\\").join("/");
}

/**
 * Normalize a directory-prefix argument into a canonical forward-slash
 * form: strip a leading `./`, drop any trailing `/`. An empty string is
 * returned for `.` or `/`.
 */
function normalizePrefix(p: string): string {
	let normalized = toPosix(p);
	if (normalized.startsWith("./")) normalized = normalized.slice(2);
	while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
	return normalized;
}

const REGEX_META = /[.+^${}()|[\]\\]/g;
function escapeRegex(s: string): string {
	return s.replace(REGEX_META, "\\$&");
}

/**
 * Convert a glob pattern to a RegExp. Mirrors the semantics used in
 * `query.ts` (f1 `query` tool): `**` matches any path segments, `*`
 * matches a single segment, `?` matches a single character, leading `/`
 * anchors to the path root.
 */
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

function textResult(text: string): { content: TextContent[]; details: undefined } {
	return { content: [{ type: "text", text }], details: undefined };
}

/* -------------------------------------------------------------------------- */
/* Dispatch context shared by all three tools                                 */
/* -------------------------------------------------------------------------- */

interface DispatchContext {
	manifest: FileManifestEntry[];
	symbolIndex: SymbolEntry[];
	includeGenerated: boolean;
}

function filterByGenerated(ctx: DispatchContext, entries: FileManifestEntry[]): FileManifestEntry[] {
	if (ctx.includeGenerated) return entries;
	return entries.filter((e) => !e.generated);
}

/* -------------------------------------------------------------------------- */
/* grep-f1                                                                    */
/* -------------------------------------------------------------------------- */

const F1_GREP_DESCRIPTION =
	"F1-backed grep: scan the syntax index for symbols whose name matches the pattern. " +
	"Returns one 'file:line:kind:symbol' line per match. " +
	"Faster than the standard `grep` tool but only sees files present in the worktree manifest. " +
	"May miss files outside the worktree (caller should fall back to `grep` for those).";

function buildGrepF1Tool(resolveCtx: () => Promise<DispatchContext>): AgentTool<any> {
	const definition: ToolDefinition<typeof f1GrepSchema> = {
		name: "grep-f1",
		label: "grep-f1",
		description: F1_GREP_DESCRIPTION,
		promptSnippet: "F1-backed symbol grep (manifest + syntax index)",
		parameters: f1GrepSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path,
				kind,
				language,
				ignoreCase,
				limit,
			}: {
				pattern: string;
				path?: string;
				kind?: string;
				language?: string;
				ignoreCase?: boolean;
				limit?: number;
			},
			_signal?: AbortSignal,
			_onUpdate?: unknown,
			_ctx?: ExtensionContext,
		) {
			const ctx = await resolveCtx();
			const effectiveLimit = limit ?? DEFAULT_GREP_LIMIT;
			const caseSensitive = ignoreCase === false;
			const needle = caseSensitive ? pattern : pattern.toLowerCase();
			const pathPrefix = path !== undefined ? normalizePrefix(path) : "";
			const wantPath = pathPrefix.length > 0;

			const lines: string[] = [];
			for (const sym of ctx.symbolIndex) {
				if (lines.length >= effectiveLimit) break;
				if (kind !== undefined && sym.kind !== kind) continue;
				if (language !== undefined && sym.language !== language) continue;
				if (wantPath && !sym.path.startsWith(pathPrefix)) continue;
				const hay = caseSensitive ? sym.name : sym.name.toLowerCase();
				if (!hay.includes(needle)) continue;
				lines.push(`${sym.path}:${sym.startLine}:${sym.kind}:${sym.name}`);
			}

			if (lines.length === 0) {
				return textResult("No matches found");
			}
			return textResult(lines.join("\n"));
		},
	};
	return wrapToolDefinition(definition);
}

/* -------------------------------------------------------------------------- */
/* find-f1                                                                    */
/* -------------------------------------------------------------------------- */

const F1_FIND_DESCRIPTION =
	"F1-backed find: filter the file manifest by glob, language, and/or package. " +
	"Returns one path per line. " +
	"Faster than the standard `find` tool but only sees files present in the worktree manifest. " +
	"May miss files outside the worktree (caller should fall back to `find` for those).";

function buildFindF1Tool(resolveCtx: () => Promise<DispatchContext>): AgentTool<any> {
	const definition: ToolDefinition<typeof f1FindSchema> = {
		name: "find-f1",
		label: "find-f1",
		description: F1_FIND_DESCRIPTION,
		promptSnippet: "F1-backed file find (manifest filter)",
		parameters: f1FindSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				language,
				package: packageName,
				limit,
			}: {
				pattern?: string;
				language?: string;
				package?: string;
				limit?: number;
			},
			_signal?: AbortSignal,
			_onUpdate?: unknown,
			_ctx?: ExtensionContext,
		) {
			const ctx = await resolveCtx();
			const effectiveLimit = limit ?? DEFAULT_FIND_LIMIT;
			const patternStr = pattern ?? "**/*";
			const wantLanguage = language !== undefined;
			const wantPackage = packageName !== undefined;

			const results: string[] = [];
			for (const entry of filterByGenerated(ctx, ctx.manifest)) {
				if (results.length >= effectiveLimit) break;
				if (wantLanguage && entry.language !== language) continue;
				if (wantPackage && entry.package !== packageName) continue;
				if (!matchesGlob(entry.path, patternStr)) continue;
				results.push(entry.path);
			}

			if (results.length === 0) {
				return textResult("No files found matching pattern");
			}
			return textResult(results.join("\n"));
		},
	};
	return wrapToolDefinition(definition);
}

/* -------------------------------------------------------------------------- */
/* ls-f1                                                                      */
/* -------------------------------------------------------------------------- */

const F1_LS_DESCRIPTION =
	"F1-backed ls: list manifest entries under a directory prefix, with byte length and language. " +
	"Returns one 'path<tab>byteLength<tab>language' line per entry. " +
	"Faster than the standard `ls` tool but only sees files present in the worktree manifest. " +
	"May miss files outside the worktree (caller should fall back to `ls` for those).";

function buildLsF1Tool(resolveCtx: () => Promise<DispatchContext>): AgentTool<any> {
	const definition: ToolDefinition<typeof f1LsSchema> = {
		name: "ls-f1",
		label: "ls-f1",
		description: F1_LS_DESCRIPTION,
		promptSnippet: "F1-backed directory listing (manifest)",
		parameters: f1LsSchema,
		async execute(
			_toolCallId,
			{ path, limit }: { path?: string; limit?: number },
			_signal?: AbortSignal,
			_onUpdate?: unknown,
			_ctx?: ExtensionContext,
		) {
			const ctx = await resolveCtx();
			const effectiveLimit = limit ?? DEFAULT_LS_LIMIT;
			const prefix = path !== undefined ? normalizePrefix(path) : "";
			const wantPrefix = prefix.length > 0;

			const results: string[] = [];
			for (const entry of filterByGenerated(ctx, ctx.manifest)) {
				if (results.length >= effectiveLimit) break;
				if (wantPrefix && !entry.path.startsWith(prefix)) continue;
				const lang = entry.language ?? "";
				results.push(`${entry.path}\t${entry.byteLength}\t${lang}`);
			}

			if (results.length === 0) {
				return textResult("(empty directory)");
			}
			return textResult(results.join("\n"));
		},
	};
	return wrapToolDefinition(definition);
}

/* -------------------------------------------------------------------------- */
/* Public factory                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Build the three F1-backed read-only tools: `grep-f1`, `find-f1`, `ls-f1`.
 *
 * When `options.getData` is supplied, the tools resolve a fresh
 * manifest / symbol index at the start of every call (live source form);
 * otherwise they share the frozen snapshot supplied via `options.manifest`
 * and `options.symbolIndex`. They are registered alongside the standard
 * read-only tools by `createReadOnlyToolDefinitions` when
 * `options.f1ReadOnly` is provided.
 *
 * If the manifest is empty, the tools return empty results. The caller is
 * responsible for falling back to the original (filesystem-backed) tools
 * when the manifest has no coverage of the requested path.
 */
export function createF1ReadOnlyToolDefinitions(options: F1ReadOnlyToolOptions): AgentTool<any>[] {
	// `cwd` is accepted for parity with the other tool factories; the
	// manifest is already rooted relative to the worktree, so we do not
	// need to resolve paths against it here.
	void options.cwd;
	const getData = options.getData;
	const manifest = options.manifest;
	const symbolIndex = options.symbolIndex;
	const includeGenerated = options.includeGenerated === true;
	const frozen =
		getData === undefined && manifest !== undefined && symbolIndex !== undefined
			? { manifest, symbolIndex }
			: undefined;

	// Resolve the dispatch context per invocation: the live source when
	// supplied (fresh manifest + symbol index each call), otherwise the
	// frozen snapshot. Neither supplied yields empty indexes so the
	// tools degrade to empty results (caller falls back to the
	// filesystem-backed tools).
	async function resolveCtx(): Promise<DispatchContext> {
		if (getData !== undefined) {
			const { manifest: m, symbolIndex: s } = await getData();
			return { manifest: m, symbolIndex: s, includeGenerated };
		}
		if (frozen !== undefined) {
			return { manifest: frozen.manifest, symbolIndex: frozen.symbolIndex, includeGenerated };
		}
		return { manifest: [], symbolIndex: [], includeGenerated };
	}

	return [buildGrepF1Tool(resolveCtx), buildFindF1Tool(resolveCtx), buildLsF1Tool(resolveCtx)];
}

