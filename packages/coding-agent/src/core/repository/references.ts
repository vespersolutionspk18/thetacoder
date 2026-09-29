/**
 * F1 reference-resolution data layer.
 *
 * Finds all references to a symbol across the file manifest using
 * regex-based whole-word matching. No Tree-sitter, no LSP — by design.
 *
 * This is the W2 "find callers / references / implementations"
 * replacement for the structural search loop in the agent. The agent's
 * tools call `getReferences` rather than spawning a sub-agent to grep.
 *
 * ## Algorithm
 *
 * For each path in the manifest (filtered by `options.paths`):
 *   1. Read the file content.
 *   2. For each line, scan whole-word matches of `query` via `\b<q>\b`.
 *   3. Look up the comment / string / code zone of each match via a
 *      per-file zone array built in a single pass. Skip the match if
 *      the zone is `comment` and `includeComments` is unset, or
 *      `string` and `includeStringLiterals` is unset.
 *   4. Classify the line into a `ReferenceKind`.
 *   5. Mark certainty as `"exact"` if `symbolIndex` already has a
 *      `SymbolEntry` on the same path / line / name; otherwise
 *      `"lexical"`.
 *
 * Files are read in parallel via `Promise.all`. The function keeps
 * scanning every candidate file so `totalMatches` reflects the full
 * match count even when `maxResults` truncates the returned array.
 *
 * ## Large-manifest optimization
 *
 * For manifests with more than 1000 entries, the function only scans
 * files that the syntax index flagged as relevant to the query — i.e.
 * files containing a `SymbolEntry` whose `name === query`, plus files
 * that have a `kind: "import"` entry with the same name. Other files
 * are counted in `coverage.filesSkipped` but not opened. This keeps
 * the call cheap on monorepos where the agent rarely wants a
 * full-tree grep.
 */

import type { FileManifestEntry } from "./manifest.ts";
import type { SymbolEntry } from "./syntax-index.ts";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export type ReferenceKind =
	| "declaration"
	| "call"
	| "type-use"
	| "import"
	| "export"
	| "assignment"
	| "comment-mention"
	| "string-mention"
	| "unknown";

export interface Reference {
	/** Forward-slash relative path of the file containing the match. */
	path: string;
	/** 1-indexed start line. */
	startLine: number;
	/** 1-indexed end line (inclusive; for a single-line match equal to `startLine`). */
	endLine: number;
	kind: ReferenceKind;
	/** The looked-up symbol name (echoes the query). */
	symbol: string;
	/** Surrounding line, truncated to 200 characters. */
	context?: string;
	/** How confident the matcher is in this hit. */
	certainty: "exact" | "lexical" | "fuzzy";
}

export interface GetReferencesOptions {
	/** Restrict to these `ReferenceKind` values. Default: all kinds. */
	kinds?: ReferenceKind[];
	/** Restrict the scan to these forward-slash relative paths. Default: every file in the manifest. */
	paths?: string[];
	/** Cap on returned references. Default 100. */
	maxResults?: number;
	/** Whether the query match is case-sensitive. Default `true`. */
	caseSensitive?: boolean;
	/** Include matches whose zone is a comment. Default `false`. */
	includeComments?: boolean;
	/** Include matches whose zone is a string literal. Default `false`. */
	includeStringLiterals?: boolean;
}

export interface GetReferencesResult {
	query: string;
	references: Reference[];
	/** Total matches found across the scanned files (before `maxResults` truncation). */
	totalMatches: number;
	/** `true` when `references.length` hit the `maxResults` cap. */
	truncated: boolean;
	coverage: {
		/** Number of files actually opened and scanned. */
		filesScanned: number;
		/** Number of files skipped due to the large-manifest filter. */
		filesSkipped: number;
		/** Deterministic manifest signature: `${len}:${first.path}:${last.path}`, or `"empty"`. */
		manifestVersion: string;
	};
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const DEFAULT_MAX_RESULTS = 100;
const CONTEXT_MAX_CHARS = 200;
const LARGE_MANIFEST_THRESHOLD = 1000;

const ZONE_CODE = 0;
const ZONE_COMMENT = 1;
const ZONE_STRING = 2;

const DECL_KEYWORDS = ["function", "class", "interface", "type", "const", "let", "var", "enum", "def"] as const;

/* -------------------------------------------------------------------------- */
/* File reading (runtime-concatenated specifier — see manifest.ts)            */
/* -------------------------------------------------------------------------- */

async function readContentOrNull(absolutePath: string): Promise<string | null> {
	try {
		const moduleName = "node" + ":" + "fs/promises";
		const fs = (await import(/* @vite-ignore */ moduleName)) as typeof import("node:fs/promises");
		return await fs.readFile(absolutePath, "utf-8");
	} catch {
		return null;
	}
}

/* -------------------------------------------------------------------------- */
/* Small string / regex helpers                                               */
/* -------------------------------------------------------------------------- */

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateContext(s: string): string {
	return s.length > CONTEXT_MAX_CHARS ? s.slice(0, CONTEXT_MAX_CHARS) : s;
}

function computeManifestVersion(manifest: FileManifestEntry[]): string {
	if (manifest.length === 0) return "empty";
	return `${manifest.length}:${manifest[0].path}:${manifest[manifest.length - 1].path}`;
}

function buildExactLookup(symbolIndex: SymbolEntry[]): Map<string, Set<number>> {
	// key: `${path}::${name}` -> set of startLine values.
	const out = new Map<string, Set<number>>();
	for (const entry of symbolIndex) {
		const key = `${entry.path}::${entry.name}`;
		let set = out.get(key);
		if (!set) {
			set = new Set();
			out.set(key, set);
		}
		set.add(entry.startLine);
	}
	return out;
}

/* -------------------------------------------------------------------------- */
/* Zone tracking (per-character: code / comment / string)                     */
/* -------------------------------------------------------------------------- */

/**
 * Build a per-character zone array for the file content.
 *
 * Zone 0 = code, 1 = comment, 2 = string literal. The parser is a
 * single-pass state machine that understands:
 *
 *   - JS / TS line comments (`//`) and block comments (`/* ... *\/`)
 *   - JS / TS strings with `'`, `"`, or backticks (with `\` escape)
 *   - Python `#` line comments
 *   - Python triple-quoted strings (`"""` / `'''`) — these are strings,
 *     not comments
 *   - Python single-line strings with `'` or `"`
 *
 * Other languages fall back to all-code (every character is zone 0).
 * This is intentional for the F1 regex MVP: a per-language parser
 * framework is out of scope.
 */
function buildZones(content: string, language: string | null): Uint8Array {
	const len = content.length;
	const zones = new Uint8Array(len);
	let i = 0;
	const isPy = language === "python";

	while (i < len) {
		const ch = content[i];
		const next = i + 1 < len ? content[i + 1] : "";

		if (isPy) {
			if (ch === "#") {
				while (i < len && content[i] !== "\n") {
					zones[i] = ZONE_COMMENT;
					i++;
				}
				continue;
			}
			if ((ch === '"' || ch === "'") && next === ch && content[i + 2] === ch) {
				const quote = ch;
				const blockStart = i;
				i += 3;
				for (let j = blockStart; j < i; j++) zones[j] = ZONE_STRING;
				while (i < len) {
					if (content[i] === quote && content[i + 1] === quote && content[i + 2] === quote) {
						for (let j = 0; j < 3; j++) zones[i + j] = ZONE_STRING;
						i += 3;
						break;
					}
					if (content[i] === "\\" && i + 1 < len) {
						zones[i] = ZONE_STRING;
						zones[i + 1] = ZONE_STRING;
						i += 2;
					} else {
						zones[i] = ZONE_STRING;
						i++;
					}
				}
				continue;
			}
			if (ch === '"' || ch === "'") {
				const quote = ch;
				zones[i] = ZONE_STRING;
				i++;
				while (i < len && content[i] !== quote) {
					if (content[i] === "\\" && i + 1 < len) {
						zones[i] = ZONE_STRING;
						zones[i + 1] = ZONE_STRING;
						i += 2;
					} else {
						zones[i] = ZONE_STRING;
						i++;
					}
				}
				if (i < len) {
					zones[i] = ZONE_STRING;
					i++;
				}
				continue;
			}
			zones[i] = ZONE_CODE;
			i++;
			continue;
		}

		// JS / TS path.
		if (ch === "/" && next === "/") {
			while (i < len && content[i] !== "\n") {
				zones[i] = ZONE_COMMENT;
				i++;
			}
			continue;
		}
		if (ch === "/" && next === "*") {
			while (i < len) {
				zones[i] = ZONE_COMMENT;
				if (content[i] === "*" && i + 1 < len && content[i + 1] === "/") {
					zones[i + 1] = ZONE_COMMENT;
					i += 2;
					break;
				}
				i++;
			}
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			const quote = ch;
			zones[i] = ZONE_STRING;
			i++;
			while (i < len && content[i] !== quote) {
				if (content[i] === "\\" && i + 1 < len) {
					zones[i] = ZONE_STRING;
					zones[i + 1] = ZONE_STRING;
					i += 2;
				} else {
					zones[i] = ZONE_STRING;
					i++;
				}
			}
			if (i < len) {
				zones[i] = ZONE_STRING;
				i++;
			}
			continue;
		}
		zones[i] = ZONE_CODE;
		i++;
	}
	return zones;
}

/* -------------------------------------------------------------------------- */
/* Line classification                                                        */
/* -------------------------------------------------------------------------- */

function isDeclarationLine(line: string, query: string): boolean {
	const trimmed = line.replace(/^\s+/, "");
	const esc = escapeRegex(query);
	for (const kw of DECL_KEYWORDS) {
		if (new RegExp(`^${kw}\\s+${esc}\\b`).test(trimmed)) return true;
	}
	return false;
}

function isCallLine(line: string, query: string): boolean {
	return new RegExp(`\\b${escapeRegex(query)}\\s*\\(`).test(line);
}

function isTypeUseLine(line: string, query: string): boolean {
	const esc = escapeRegex(query);
	const patterns: RegExp[] = [
		new RegExp(`:\\s*${esc}\\b`),
		new RegExp(`\\bas\\s+${esc}\\b`),
		new RegExp(`<${esc}>`),
		new RegExp(`<${esc}\\s*[,>]`),
		new RegExp(`\\b${esc}\\s*\\[`),
		new RegExp(`\\b${esc}\\s*[|&]`),
	];
	for (const p of patterns) if (p.test(line)) return true;
	return false;
}

function isImportLine(line: string, query: string): boolean {
	const trimmed = line.replace(/^\s+/, "");
	if (!/^import\b/.test(trimmed)) return false;
	return new RegExp(`\\b${escapeRegex(query)}\\b`).test(line);
}

function isExportLine(line: string, query: string): boolean {
	const trimmed = line.replace(/^\s+/, "");
	if (!/^export\b/.test(trimmed)) return false;
	return new RegExp(`\\b${escapeRegex(query)}\\b`).test(line);
}

function isAssignmentLine(line: string, query: string): boolean {
	const esc = escapeRegex(query);
	return new RegExp(`=\\s*${esc}\\b`).test(line) || new RegExp(`\\b${esc}\\s*=`).test(line);
}

function classifyLine(line: string, query: string): ReferenceKind {
	if (isDeclarationLine(line, query)) return "declaration";
	if (isCallLine(line, query)) return "call";
	if (isTypeUseLine(line, query)) return "type-use";
	if (isImportLine(line, query)) return "import";
	if (isExportLine(line, query)) return "export";
	if (isAssignmentLine(line, query)) return "assignment";
	return "unknown";
}

/* -------------------------------------------------------------------------- */
/* Large-manifest filter                                                      */
/* -------------------------------------------------------------------------- */

function relevantFilesForLargeManifest(
	_manifest: FileManifestEntry[],
	query: string,
	symbolIndex: SymbolEntry[],
): Set<string> {
	// Primary: files that have a `SymbolEntry` whose `name === query`.
	// "1 level of imports": files that have a `kind: "import"` entry
	// whose `name === query` (typically a namespace or side-effect
	// import). The syntax index stores the module path as `name` for
	// named imports, so this filter only catches queries that are
	// themselves import sources — but it never returns the wrong
	// answer, it just under-includes. A future Tree-sitter-backed
	// pass can resolve actual import chains.
	const out = new Set<string>();
	for (const entry of symbolIndex) {
		if (entry.name === query) out.add(entry.path);
	}
	for (const entry of symbolIndex) {
		if (entry.kind === "import" && entry.name === query) out.add(entry.path);
	}
	return out;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function getReferences(
	query: string,
	manifest: FileManifestEntry[],
	symbolIndex: SymbolEntry[],
	options: GetReferencesOptions = {},
): Promise<GetReferencesResult> {
	const kindsFilter = options.kinds ? new Set(options.kinds) : null;
	const pathsFilter = options.paths ? new Set(options.paths) : null;
	const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
	const caseSensitive = options.caseSensitive ?? true;
	const includeComments = options.includeComments ?? false;
	const includeStringLiterals = options.includeStringLiterals ?? false;
	const manifestVersion = computeManifestVersion(manifest);

	if (query.length === 0) {
		return {
			query,
			references: [],
			totalMatches: 0,
			truncated: false,
			coverage: { filesScanned: 0, filesSkipped: 0, manifestVersion },
		};
	}

	const pathFiltered = pathsFilter ? manifest.filter((e) => pathsFilter.has(e.path)) : manifest;

	let filesToScan: FileManifestEntry[];
	let filesSkipped = 0;
	if (manifest.length > LARGE_MANIFEST_THRESHOLD) {
		const relevant = relevantFilesForLargeManifest(manifest, query, symbolIndex);
		filesToScan = pathFiltered.filter((e) => relevant.has(e.path));
		filesSkipped = pathFiltered.length - filesToScan.length;
	} else {
		filesToScan = pathFiltered;
	}

	// Build the whole-word regex. The `g` flag lets `matchAll` walk
	// every occurrence in a line; the case flag is conditional.
	const flags = `g${caseSensitive ? "" : "i"}`;
	const wordRegex = new RegExp(`\\b${escapeRegex(query)}\\b`, flags);

	const exactLookup = buildExactLookup(symbolIndex);

	// Read all files in parallel. I/O errors degrade to `null` and
	// the file is treated as if it had no content.
	const fileContents = await Promise.all(
		filesToScan.map(async (entry) => ({
			entry,
			content: await readContentOrNull(entry.absolutePath),
		})),
	);

	const references: Reference[] = [];
	let totalMatches = 0;
	let filesScanned = 0;

	for (const { entry, content } of fileContents) {
		if (content === null) continue;
		filesScanned++;
		const zones = buildZones(content, entry.language);

		// Walk lines via explicit index lookup so the line start in
		// the file is known exactly — no off-by-one from a missing
		// trailing newline.
		let lineStart = 0;
		let lineNumber = 1;
		while (lineStart <= content.length) {
			const nl = content.indexOf("\n", lineStart);
			const lineEnd = nl === -1 ? content.length : nl;
			const text = content.slice(lineStart, lineEnd);

			// `matchAll` resets the regex's `lastIndex` per call, so
			// reusing the regex across lines is safe.
			for (const m of text.matchAll(wordRegex)) {
				const matchCol = m.index ?? 0;
				const fileOffset = lineStart + matchCol;
				const zone = fileOffset < zones.length ? zones[fileOffset] : ZONE_CODE;

				if (zone === ZONE_COMMENT && !includeComments) continue;
				if (zone === ZONE_STRING && !includeStringLiterals) continue;

				totalMatches++;

				let kind: ReferenceKind;
				if (zone === ZONE_COMMENT) kind = "comment-mention";
				else if (zone === ZONE_STRING) kind = "string-mention";
				else kind = classifyLine(text, query);

				if (kindsFilter && !kindsFilter.has(kind)) continue;
				if (references.length >= maxResults) continue;

				const key = `${entry.path}::${query}`;
				const set = exactLookup.get(key);
				const certainty: "exact" | "lexical" = set?.has(lineNumber) ? "exact" : "lexical";

				references.push({
					path: entry.path,
					startLine: lineNumber,
					endLine: lineNumber,
					kind,
					symbol: query,
					context: truncateContext(text),
					certainty,
				});
			}

			if (nl === -1) break;
			lineStart = nl + 1;
			lineNumber++;
		}
	}

	return {
		query,
		references,
		totalMatches,
		truncated: references.length >= maxResults,
		coverage: { filesScanned, filesSkipped, manifestVersion },
	};
}

