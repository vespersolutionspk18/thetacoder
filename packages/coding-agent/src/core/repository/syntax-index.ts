/**
 * F1 Phase 2 — syntax index data layer.
 *
 * Builds a flat list of `SymbolEntry` records from a `FileManifestEntry[]`
 * produced by `./manifest.ts`. Per-language regex/heuristic extractors
 * pull out declarations, imports, and exports from each file.
 *
 * ## Why regex and not a real parser
 *
 * The audit (Section 11.3) calls for Tree-sitter here. Tree-sitter
 * would give us a real syntax tree with byte-precise ranges, but it
 * adds a new npm dependency with native bindings. To keep the F1 MVP
 * dependency-free, this layer uses per-language regex extractors. The
 * trade-off is well-known:
 *
 *   - false negatives: we will miss some declarations (e.g. destructured
 *     `const { a, b } = ...` — only `a`/`b` are out of scope for MVP).
 *   - false positives inside string literals containing keywords
 *     (e.g. `const s = "function";`) — we do not currently strip
 *     string contents. Comment stripping is the only mitigation.
 *   - no scope resolution: an `import { Foo } from "./x"` is just
 *     one record; we do not link it to `export ... Foo` in `./x`.
 *
 * The dispatcher's signature is `async` so a future Tree-sitter
 * implementation can drop in without changing call sites. The same
 * applies to the `SymbolEntry` shape — Tree-sitter byte ranges map
 * directly onto `startByte` / `endByte` once a parser is wired up.
 */

import type { FileManifestEntry } from "./manifest.ts";
import { buildSyntaxIndexWithTreeSitter } from "./tree-sitter-syntax-index.ts";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Backend selector for {@link buildSyntaxIndex}. See
 * `SyntaxIndexOptions.backend` for the per-value semantics.
 */
export type SyntaxIndexBackend = "regex" | "tree-sitter" | "auto";

/**
 * Kind of symbol extracted from source. The kind set is intentionally
 * coarse — the MVP does not distinguish e.g. a generator function from
 * a regular one (both are `"function"` with a `generator` modifier).
 */
export type SymbolKind =
	| "function"
	| "class"
	| "interface"
	| "type"
	| "variable"
	| "enum"
	| "import"
	| "export"
	| "method"
	| "property"
	| "heading"
	| "code-block"
	| "json-key";

/** Single symbol / declaration / import / export record. */
export interface SymbolEntry {
	/**
	 * Symbol name. For `"import"` and `"export"` entries this is the
	 * module path or the exported specifier; for `"heading"` it is the
	 * heading text; for `"json-key"` it is the key path (dot-joined).
	 */
	name: string;
	kind: SymbolKind;
	/** Forward-slash relative path of the file containing the symbol. */
	path: string;
	/** 1-indexed line where the symbol starts. */
	startLine: number;
	/** 1-indexed line where the symbol ends (inclusive). */
	endLine: number;
	/**
	 * Optional 0-indexed byte offset of the start of the symbol. The
	 * regex MVP does not compute these — a Tree-sitter implementation
	 * will fill them in. Consumers must treat them as optional.
	 */
	startByte?: number;
	/** Optional 0-indexed byte offset of the end of the symbol. */
	endByte?: number;
	/** For methods/properties: the enclosing class or object name. */
	containerName?: string;
	/**
	 * For functions/methods: the declaration line as it appears in
	 * source (single line; multi-line signatures are flattened).
	 */
	signature?: string;
	/**
	 * Modifiers attached to the declaration, in declaration order.
	 * Typical values: `"export"`, `"default"`, `"async"`, `"const"`,
	 * `"let"`, `"var"`, `"static"`, `"abstract"`, `"readonly"`,
	 * `"public"`, `"private"`, `"protected"`.
	 */
	modifiers?: string[];
	/** Language tag copied from `FileManifestEntry.language`. */
	language: string;
}

export interface SyntaxIndexOptions {
	/**
	 * Restrict extraction to these language tags (e.g. `["typescript"]`).
	 * Default: every supported language. Unsupported languages in the
	 * manifest are silently skipped regardless of this option.
	 */
	languages?: string[];
	/**
	 * Hard cap on the number of symbols produced per file. Used as a
	 * safety net against pathological inputs (e.g. a minified JS file
	 * with thousands of `var` declarations). Default 5000.
	 */
	maxSymbolsPerFile?: number;
	/**
	 * Backend used to build the index.
	 *
	 *   - `"regex"` (default) — the original per-language regex
	 *     extractors. Always available, no native dependency.
	 *   - `"tree-sitter"` — the tree-sitter-backed extractors. When
	 *     a file's language has no registered tree-sitter binding,
	 *     the dispatcher silently falls back to the regex
	 *     extractors for that file. Pass this explicitly when the
	 *     caller has the tree-sitter layer enabled.
	 *   - `"auto"` — prefer tree-sitter for any language that has a
	 *     registered binding, fall back to regex elsewhere. This
	 *     matches the default behaviour of the live data layer
	 *     when `repository.treeSitter.enabled` is true.
	 */
	backend?: SyntaxIndexBackend;
}

export interface FindSymbolsOptions {
	/** Restrict to entries of this kind. */
	kind?: SymbolKind;
	/** Restrict to entries in this language. */
	language?: string;
	/** Case-sensitive name matching. Default false. */
	caseSensitive?: boolean;
	/** Maximum number of results to return. Default 100. */
	limit?: number;
}

/* -------------------------------------------------------------------------- */
/* Per-language extractor type                                                */
/* -------------------------------------------------------------------------- */

type Extractor = (content: string, path: string, language: string) => SymbolEntry[];

/* -------------------------------------------------------------------------- */
/* Language dispatch table                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Map from `FileManifestEntry.language` to its regex extractor.
 *
 * For unsupported languages the dispatcher returns `[]` for that file
 * (no throw). To add support for a new language, add a new entry here
 * and write the corresponding extractor.
 */
const EXTRACTORS: Record<string, Extractor> = {
	typescript: extractTypeScriptSymbols,
	javascript: extractJavaScriptSymbols,
	python: extractPythonSymbols,
	json: extractJsonSymbols,
	markdown: extractMarkdownSymbols,
};

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build the syntax index for a manifest. Each entry's `language` is
 * used to dispatch to a per-language extractor. Returns a flat array
 * of `SymbolEntry` sorted by `(path, startLine, kind)`.
 *
 * The function is `async` even though the MVP implementation is
 * synchronous — the signature is forward-compatible with a future
 * Tree-sitter-backed implementation that may need to await parser
 * initialisation per language.
 */
export async function buildSyntaxIndex(
	manifest: FileManifestEntry[],
	options?: SyntaxIndexOptions,
): Promise<SymbolEntry[]> {
	const backend: SyntaxIndexBackend = options?.backend ?? "regex";
	const languages = options?.languages ? new Set(options.languages) : null;
	const maxSymbolsPerFile = options?.maxSymbolsPerFile ?? 5000;

	// `tree-sitter` and `auto` both route through the tree-sitter
	// builder; per-file fallback to the regex extractors happens
	// silently inside that builder for languages without a binding.
	if (backend === "tree-sitter" || backend === "auto") {
		const ts = await runTreeSitterOnly(manifest, options ?? {});
		// For `auto`, also run the regex path for any file whose
		// language has no tree-sitter binding.
		if (backend === "auto") {
			const regexOnly = await runRegexOnly(manifest, languages, maxSymbolsPerFile);
			return sortCombined(ts, regexOnly);
		}
		return ts;
	}

	return runRegexOnly(manifest, languages, maxSymbolsPerFile);
}

/**
 * Run the tree-sitter extractor on every entry in `manifest` whose
 * language has a registered binding. The returned array is sorted
 * by `(path, startByte, kind)` — callers that need the regex
 * `startLine` ordering should re-sort downstream.
 */
async function runTreeSitterOnly(manifest: FileManifestEntry[], options: SyntaxIndexOptions): Promise<SymbolEntry[]> {
	return buildSyntaxIndexWithTreeSitter(manifest, {
		languages: options.languages,
		maxSymbolsPerFile: options.maxSymbolsPerFile,
	});
}

/**
 * Run only the per-language regex extractors. Used by
 * `backend: "regex"` and by `backend: "auto"` for files whose
 * language has no tree-sitter binding.
 */
async function runRegexOnly(
	manifest: FileManifestEntry[],
	languages: Set<string> | null,
	maxSymbolsPerFile: number,
): Promise<SymbolEntry[]> {
	const out: SymbolEntry[] = [];

	for (const entry of manifest) {
		if (entry.language === null) continue;
		if (languages !== null && !languages.has(entry.language)) continue;
		const extractor = EXTRACTORS[entry.language];
		if (!extractor) continue;

		// Read the file. A missing file produces an empty array for
		// that entry rather than throwing — the index should degrade
		// gracefully on I/O errors.
		const content = await readContentOrEmpty(entry.absolutePath);
		if (content === null) continue;

		let symbols: SymbolEntry[];
		try {
			symbols = extractor(content, entry.path, entry.language);
		} catch {
			// A malformed file should not poison the rest of the
			// index. Drop the file's symbols and move on.
			continue;
		}

		if (symbols.length > maxSymbolsPerFile) {
			symbols = symbols.slice(0, maxSymbolsPerFile);
		}
		for (const s of symbols) out.push(s);
	}

	out.sort((a, b) => {
		if (a.path !== b.path) return a.path < b.path ? -1 : 1;
		if (a.startLine !== b.startLine) return a.startLine - b.startLine;
		if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
		return 0;
	});

	return out;
}

/**
 * Merge tree-sitter and regex index entries, sorted by
 * `(path, line, kind)`. Tree-sitter entries are preferred when
 * the same `(path, startLine, kind)` triple appears in both —
 * this matches the precedence the per-file fallback contract
 * advertises in `tree-sitter-syntax-index.ts`.
 */
function sortCombined(treeSitterEntries: SymbolEntry[], regexEntries: SymbolEntry[]): SymbolEntry[] {
	const seen = new Set<string>();
	const merged: SymbolEntry[] = [];
	for (const s of treeSitterEntries) {
		const key = `${s.path}|${s.startLine}|${s.kind}|${s.name}|${s.containerName ?? ""}`;
		seen.add(key);
		merged.push(s);
	}
	for (const s of regexEntries) {
		const key = `${s.path}|${s.startLine}|${s.kind}|${s.name}|${s.containerName ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(s);
	}
	merged.sort((a, b) => {
		if (a.path !== b.path) return a.path < b.path ? -1 : 1;
		if (a.startLine !== b.startLine) return a.startLine - b.startLine;
		if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
		return 0;
	});
	return merged;
}

/**
 * Return all symbols belonging to the given file path. The lookup is
 * O(n) over the index but cheap in practice because the index is
 * sorted by path and file clusters are contiguous.
 */
export function getSymbolsForFile(index: SymbolEntry[], path: string): SymbolEntry[] {
	const out: SymbolEntry[] = [];
	for (const entry of index) {
		if (entry.path === path) out.push(entry);
	}
	return out;
}

/**
 * Case-insensitive substring search over symbol names, with optional
 * kind / language filters. Returns at most `options.limit` results
 * (default 100), preserving the index's existing ordering.
 */
export function findSymbols(index: SymbolEntry[], query: string, options?: FindSymbolsOptions): SymbolEntry[] {
	const caseSensitive = options?.caseSensitive ?? false;
	const kindFilter = options?.kind;
	const languageFilter = options?.language;
	const limit = options?.limit ?? 100;

	const needle = caseSensitive ? query : query.toLowerCase();
	const out: SymbolEntry[] = [];

	for (const entry of index) {
		if (kindFilter !== undefined && entry.kind !== kindFilter) continue;
		if (languageFilter !== undefined && entry.language !== languageFilter) continue;
		const hay = caseSensitive ? entry.name : entry.name.toLowerCase();
		if (!hay.includes(needle)) continue;
		out.push(entry);
		if (out.length >= limit) break;
	}
	return out;
}

/* -------------------------------------------------------------------------- */
/* Content loading                                                            */
/* -------------------------------------------------------------------------- */

async function readContentOrEmpty(absolutePath: string): Promise<string | null> {
	try {
		// Use the runtime-concatenated specifier so browser bundlers
		// (the check-browser-smoke script) don't statically resolve
		// `node:fs/promises` if this module is ever imported from a
		// browser entry. Same trick used in `manifest.ts`.
		const moduleName = "node" + ":" + "fs/promises";
		const fs = (await import(/* @vite-ignore */ moduleName)) as typeof import("node:fs/promises");
		return await fs.readFile(absolutePath, "utf-8");
	} catch {
		return null;
	}
}

/* -------------------------------------------------------------------------- */
/* Comment stripping                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Replace comments with spaces of equal length, preserving newlines so
 * 1-indexed line numbers stay accurate. Strings are NOT touched — a
 * false positive inside a string is the accepted cost of the regex
 * MVP (see module header).
 */
function stripJsComments(input: string): string {
	const out = input.split("");
	let i = 0;
	while (i < input.length) {
		const ch = input[i];
		const next = input[i + 1];
		if (ch === "/" && next === "/") {
			out[i] = " ";
			out[i + 1] = " ";
			i += 2;
			while (i < input.length && input[i] !== "\n") {
				out[i] = " ";
				i += 1;
			}
		} else if (ch === "/" && next === "*") {
			out[i] = " ";
			out[i + 1] = " ";
			i += 2;
			while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
				out[i] = " ";
				i += 1;
			}
			if (i < input.length) {
				out[i] = " ";
				out[i + 1] = " ";
				i += 2;
			}
		} else {
			i += 1;
		}
	}
	return out.join("");
}

/**
 * Replace Python `#` comments with spaces, preserving newlines.
 * Triple-quoted strings are NOT treated as comments — they may
 * contain real code.
 */
function stripPythonComments(input: string): string {
	const out = input.split("");
	let i = 0;
	while (i < input.length) {
		const ch = input[i];
		if (ch === "#") {
			while (i < input.length && input[i] !== "\n") {
				out[i] = " ";
				i += 1;
			}
		} else if ((ch === '"' || ch === "'") && input[i + 1] === ch && input[i + 2] === ch) {
			const quote = ch;
			i += 3;
			while (i < input.length) {
				if (input[i] === "\\" && i + 1 < input.length) {
					i += 2;
					continue;
				}
				if (input[i] === quote && input[i + 1] === quote && input[i + 2] === quote) {
					i += 3;
					break;
				}
				i += 1;
			}
		} else {
			i += 1;
		}
	}
	return out.join("");
}

/* -------------------------------------------------------------------------- */
/* Helpers shared by extractors                                                */
/* -------------------------------------------------------------------------- */

const IDENT = `[A-Za-z_$][\\w$]*`;
const IDENT_PY = `[A-Za-z_][\\w]*`;

interface LineMatch {
	line: number;
	text: string;
}

/** Iterate lines of a comment-stripped buffer, yielding 1-indexed lines. */
function* iterateLines(content: string): Generator<LineMatch> {
	let line = 1;
	let start = 0;
	for (let i = 0; i <= content.length; i += 1) {
		if (i === content.length || content[i] === "\n") {
			yield { line, text: content.slice(start, i) };
			line += 1;
			start = i + 1;
		}
	}
}

function makeSymbol(
	kind: SymbolKind,
	name: string,
	path: string,
	startLine: number,
	endLine: number,
	language: string,
	extras: Partial<SymbolEntry> = {},
): SymbolEntry {
	return {
		kind,
		name,
		path,
		startLine,
		endLine,
		language,
		...extras,
	};
}

function countChar(s: string, ch: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i += 1) if (s[i] === ch) n += 1;
	return n;
}

/** Pull a deduplicated, ordered list of modifier keywords out of a prefix string. */
function parseModifiers(raw: string): string[] {
	const tokens = raw.split(/\s+/).filter((t) => t.length > 0);
	const mods: string[] = [];
	for (const t of tokens) {
		if (!mods.includes(t)) mods.push(t);
	}
	return mods;
}

/* -------------------------------------------------------------------------- */
/* TypeScript / JavaScript extractor                                           */
/* -------------------------------------------------------------------------- */

/** Modifiers that may precede a JS/TS declaration. `default` is a keyword
 *  handled separately because it can only follow `export` and is part of
 *  `export default ...` rather than a regular declaration modifier. */
const TS_MODS = `^(?<mods>(?:export\\s+|async\\s+|abstract\\s+|declare\\s+)*)`;

const TS_FUNC_RE = new RegExp(`${TS_MODS}function\\s+(?<name>${IDENT})`);
const TS_CLASS_RE = new RegExp(`${TS_MODS}class\\s+(?<name>${IDENT})`);
const TS_INTERFACE_RE = new RegExp(`${TS_MODS}interface\\s+(?<name>${IDENT})`);
const TS_TYPE_RE = new RegExp(`${TS_MODS}type\\s+(?<name>${IDENT})`);
/** Enum MUST be tried before var so `const enum Foo` is not misread as `const enum`. */
const TS_ENUM_RE = new RegExp(`${TS_MODS}(?:const\\s+)?enum\\s+(?<name>${IDENT})`);
const TS_VAR_RE = new RegExp(`${TS_MODS}(?<kw>const|let|var)\\s+(?<name>${IDENT})`);

const TS_IMPORT_SIDE_RE = /^import\s+['"](?<source>[^'"]+)['"]/;
/** `import { a, b } from "..."` with no default binding. */
const TS_IMPORT_NAMED_RE = /^import\s*\{(?<named>[^}]+)\}\s*from\s*['"](?<source>[^'"]+)['"]/;
const TS_IMPORT_DEFAULT_RE = new RegExp(
	`^import\\s+(?<default>${IDENT})(?:\\s*,\\s*)?(?:\\{(?<named>[^}]*)\\})?\\s*from\\s*['"](?<source>[^'"]+)['"]`,
);
const TS_IMPORT_NAMESPACE_RE = new RegExp(
	`^import\\s+\\*\\s+as\\s+(?<name>${IDENT})\\s+from\\s*['"](?<source>[^'"]+)['"]`,
);

const TS_EXPORT_NAMED_RE = /^export\s*\{(?<names>[^}]+)\}\s*(?:from\s*['"](?<source>[^'"]+)['"])?/;
const TS_EXPORT_STAR_RE = new RegExp(
	`^export\\s+(?:\\*\\s*(?:as\\s+(?<alias>${IDENT})\\s+)?from\\s+|)(?<source>['"](?<sourceStr>[^'"]+)['"]|)`,
);
/** `export default` followed by a class/function/interface/type/expression. */
const TS_EXPORT_DEFAULT_RE = new RegExp(`${TS_MODS}(?<defaultKw>default)\\s+(?<tail>.*)$`);

const JS_BLOCK_KEYWORDS = new Set([
	"if",
	"for",
	"while",
	"switch",
	"return",
	"throw",
	"try",
	"catch",
	"finally",
	"do",
	"else",
	"new",
	"typeof",
	"void",
	"delete",
	"yield",
	"await",
	"case",
]);

/** TypeScript extractor (superset of JavaScript). Exported for tests. */
export function extractTypeScriptSymbols(content: string, path: string, language: string): SymbolEntry[] {
	const stripped = stripJsComments(content);
	const out: SymbolEntry[] = [];

	const classRanges: Array<{ name: string; startLine: number; endLine: number }> = [];
	let currentClass: { name: string; startLine: number } | null = null;
	let classBraceDepth = 0;

	for (const { line, text } of iterateLines(stripped)) {
		if (currentClass !== null) {
			classBraceDepth += countChar(text, "{") - countChar(text, "}");
			if (classBraceDepth <= 0) {
				classRanges.push({
					name: currentClass.name,
					startLine: currentClass.startLine,
					endLine: line,
				});
				currentClass = null;
				classBraceDepth = 0;
			}
			// While inside a class, do not try to match other top-level
			// declarations on indented lines.
			continue;
		}

		const trimmed = text.replace(/^\s+/, "");

		// Class first — entering "in class" mode for the rest of the body.
		const classMatch = TS_CLASS_RE.exec(trimmed);
		if (classMatch?.groups) {
			const name = classMatch.groups.name ?? "";
			const mods = parseModifiers(classMatch.groups.mods ?? "");
			const openBraces = countChar(text, "{");
			out.push(
				makeSymbol("class", name, path, line, line, language, {
					modifiers: mods.length > 0 ? mods : undefined,
					signature: trimmed,
				}),
			);
			if (openBraces > 0) {
				classBraceDepth = openBraces - countChar(text, "}");
				if (classBraceDepth > 0) {
					currentClass = { name, startLine: line };
				} else {
					// `class Foo {}` — closed on the same line.
					classRanges.push({ name, startLine: line, endLine: line });
				}
			}
			// If no `{` on the line, treat as declaration-only (no body).
			continue;
		}

		const funcMatch = TS_FUNC_RE.exec(trimmed);
		if (funcMatch?.groups) {
			const mods = parseModifiers(funcMatch.groups.mods ?? "");
			out.push(
				makeSymbol("function", funcMatch.groups.name ?? "", path, line, line, language, {
					modifiers: mods.length > 0 ? mods : undefined,
					signature: trimmed,
				}),
			);
			continue;
		}

		const ifaceMatch = TS_INTERFACE_RE.exec(trimmed);
		if (ifaceMatch?.groups) {
			const mods = parseModifiers(ifaceMatch.groups.mods ?? "");
			out.push(
				makeSymbol("interface", ifaceMatch.groups.name ?? "", path, line, line, language, {
					modifiers: mods.length > 0 ? mods : undefined,
					signature: trimmed,
				}),
			);
			continue;
		}

		const typeMatch = TS_TYPE_RE.exec(trimmed);
		if (typeMatch?.groups) {
			const mods = parseModifiers(typeMatch.groups.mods ?? "");
			out.push(
				makeSymbol("type", typeMatch.groups.name ?? "", path, line, line, language, {
					modifiers: mods.length > 0 ? mods : undefined,
					signature: trimmed,
				}),
			);
			continue;
		}

		// Enum BEFORE var so `const enum Foo` does not match var.
		const enumMatch = TS_ENUM_RE.exec(trimmed);
		if (enumMatch?.groups) {
			const mods = parseModifiers(enumMatch.groups.mods ?? "");
			const hasConst = /\bconst\s+enum\b/.test(trimmed);
			out.push(
				makeSymbol("enum", enumMatch.groups.name ?? "", path, line, line, language, {
					modifiers: hasConst ? [...mods, "const"] : mods.length > 0 ? mods : undefined,
					signature: trimmed,
				}),
			);
			continue;
		}

		const varMatch = TS_VAR_RE.exec(trimmed);
		if (varMatch?.groups) {
			const mods = parseModifiers(varMatch.groups.mods ?? "");
			const kw = varMatch.groups.kw ?? "";
			out.push(
				makeSymbol("variable", varMatch.groups.name ?? "", path, line, line, language, {
					modifiers: [...mods, kw],
					signature: trimmed,
				}),
			);
			continue;
		}

		// Imports.
		const impSide = TS_IMPORT_SIDE_RE.exec(trimmed);
		if (impSide?.groups) {
			out.push(
				makeSymbol("import", impSide.groups.source ?? "", path, line, line, language, {
					modifiers: ["side-effect"],
				}),
			);
			continue;
		}
		const impNs = TS_IMPORT_NAMESPACE_RE.exec(trimmed);
		if (impNs?.groups) {
			out.push(
				makeSymbol("import", impNs.groups.source ?? "", path, line, line, language, {
					modifiers: ["namespace"],
					containerName: impNs.groups.name ?? undefined,
				}),
			);
			continue;
		}
		const impNamed = TS_IMPORT_NAMED_RE.exec(trimmed);
		if (impNamed?.groups) {
			const names = (impNamed.groups.named ?? "")
				.split(",")
				.map((s) => s.trim().split(/\s+as\s+/i)[0] ?? "")
				.filter((s) => s.length > 0);
			for (const n of names) {
				out.push(
					makeSymbol("import", impNamed.groups.source ?? "", path, line, line, language, {
						modifiers: ["named"],
						containerName: n,
					}),
				);
			}
			continue;
		}
		const impDef = TS_IMPORT_DEFAULT_RE.exec(trimmed);
		if (impDef?.groups) {
			out.push(
				makeSymbol("import", impDef.groups.source ?? "", path, line, line, language, {
					modifiers: ["default"],
					containerName: impDef.groups.default ?? undefined,
				}),
			);
			continue;
		}

		// Exports.
		const expStar = TS_EXPORT_STAR_RE.exec(trimmed);
		if (expStar?.groups?.sourceStr) {
			out.push(
				makeSymbol("export", expStar.groups.sourceStr, path, line, line, language, {
					modifiers: ["star"],
					containerName: expStar.groups.alias ?? undefined,
				}),
			);
			continue;
		}
		const expNamed = TS_EXPORT_NAMED_RE.exec(trimmed);
		if (expNamed?.groups) {
			const names = (expNamed.groups.names ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
			for (const exported of names) {
				out.push(
					makeSymbol("export", exported, path, line, line, language, {
						modifiers: ["named"],
					}),
				);
			}
			continue;
		}
		const expDefault = TS_EXPORT_DEFAULT_RE.exec(trimmed);
		if (expDefault?.groups && /export\s+default\b/.test(trimmed)) {
			const tail = (expDefault.groups.tail ?? "").trim();
			// Try to pull a name out of the tail — class/function/identifier.
			const funcInTail = new RegExp(`^(?:async\\s+)?function\\s+(${IDENT})`).exec(tail);
			const classInTail = new RegExp(`^class\\s+(${IDENT})`).exec(tail);
			const identInTail = new RegExp(`^(${IDENT})`).exec(tail);
			const name = funcInTail?.[1] ?? classInTail?.[1] ?? identInTail?.[1] ?? "<anonymous>";
			const mods = [...parseModifiers(expDefault.groups.mods ?? ""), "default"];
			out.push(makeSymbol("export", name, path, line, line, language, { modifiers: mods }));
		}
	}

	// Fill in class endLine for class entries whose body spans multiple lines.
	for (const sym of out) {
		if (sym.kind !== "class") continue;
		if (sym.endLine === sym.startLine) {
			const range = classRanges.find((r) => r.name === sym.name && r.startLine === sym.startLine);
			if (range && range.endLine > sym.startLine) sym.endLine = range.endLine;
		}
	}

	// Second pass: extract class members for each detected class.
	for (const cls of classRanges) {
		extractClassMembers(stripped, path, language, cls, out);
	}
	return out;
}

/** JavaScript extractor: same as TS, but drop interface/type/enum. Exported for tests. */
export function extractJavaScriptSymbols(content: string, path: string, language: string): SymbolEntry[] {
	return extractTypeScriptSymbols(content, path, language).filter((s) => {
		if (s.kind === "interface" || s.kind === "type" || s.kind === "enum") return false;
		return true;
	});
}

/**
 * Extract methods / properties from a class body. Indented lines that
 * are not JS control-flow keywords are candidates.
 */
function extractClassMembers(
	stripped: string,
	path: string,
	language: string,
	cls: { name: string; startLine: number; endLine: number },
	out: SymbolEntry[],
): void {
	const methodRe = new RegExp(
		`^[ \\t]+(?<mods>(?:public|private|protected|static|readonly|async|get|set|override|abstract)\\s+)*(?<name>${IDENT})\\s*\\(`,
	);
	const propRe = new RegExp(
		`^[ \\t]+(?<mods>(?:public|private|protected|static|readonly)\\s+)*(?<name>${IDENT})\\s*[?:]?\\s*[:=]`,
	);
	const ctorRe = /^[ \t]+constructor\s*\(/;
	const lineIter = iterateLines(stripped);
	for (let i = 0; i < cls.startLine - 1; i += 1) lineIter.next();
	for (const { line, text } of lineIter) {
		if (line > cls.endLine) return;
		const trimmed = text.replace(/^\s+/, "");
		if (trimmed.length === 0) continue;
		if (trimmed.startsWith("}")) continue;

		const firstWord = trimmed.split(/[\s(:]+/, 1)[0] ?? "";
		if (JS_BLOCK_KEYWORDS.has(firstWord)) continue;

		const ctor = ctorRe.exec(text);
		if (ctor) {
			out.push(
				makeSymbol("method", "constructor", path, line, line, language, {
					containerName: cls.name,
					modifiers: ["constructor"],
					signature: trimmed,
				}),
			);
			continue;
		}

		const m = methodRe.exec(text);
		if (m?.groups) {
			const mods = parseModifiers(m.groups.mods ?? "");
			out.push(
				makeSymbol("method", m.groups.name ?? "", path, line, line, language, {
					containerName: cls.name,
					modifiers: mods.length > 0 ? mods : undefined,
					signature: trimmed,
				}),
			);
			continue;
		}

		const p = propRe.exec(text);
		if (p?.groups) {
			const mods = parseModifiers(p.groups.mods ?? "");
			out.push(
				makeSymbol("property", p.groups.name ?? "", path, line, line, language, {
					containerName: cls.name,
					modifiers: mods.length > 0 ? mods : undefined,
					signature: trimmed,
				}),
			);
		}
	}
}

/* -------------------------------------------------------------------------- */
/* Python extractor                                                            */
/* -------------------------------------------------------------------------- */

const PY_STMT_KEYWORDS = new Set([
	"if",
	"elif",
	"else",
	"for",
	"while",
	"with",
	"try",
	"except",
	"finally",
	"return",
	"yield",
	"raise",
	"assert",
	"pass",
	"break",
	"continue",
	"del",
	"lambda",
	"global",
	"nonlocal",
	"async",
	"await",
	"True",
	"False",
	"None",
	"class",
	"def",
	"import",
	"from",
]);

const PY_DEF_RE = new RegExp(`^(?<mods>async\\s+)*def\\s+(?<name>${IDENT_PY})\\s*\\(`);
const PY_CLASS_RE = new RegExp(`^class\\s+(?<name>${IDENT_PY})`);
const PY_IMPORT_RE = /^import\s+(?<modules>.+)$/;
const PY_FROM_IMPORT_RE = /^from\s+(?<source>[\w.]+)\s+import\s+(?<names>.+)$/;
const PY_ASSIGN_RE = new RegExp(`^(?<name>${IDENT_PY})\\s*[:=]`);

export function extractPythonSymbols(content: string, path: string, language: string): SymbolEntry[] {
	const stripped = stripPythonComments(content);
	const out: SymbolEntry[] = [];

	for (const { line, text } of iterateLines(stripped)) {
		const trimmed = text.replace(/^\s+/, "");
		if (trimmed.length === 0) continue;

		const def = PY_DEF_RE.exec(trimmed);
		if (def?.groups) {
			const mods: string[] = [];
			if (def.groups.mods) mods.push("async");
			out.push(
				makeSymbol("function", def.groups.name ?? "", path, line, line, language, {
					modifiers: mods.length > 0 ? mods : undefined,
					signature: trimmed,
				}),
			);
			continue;
		}

		const cls = PY_CLASS_RE.exec(trimmed);
		if (cls?.groups) {
			out.push(
				makeSymbol("class", cls.groups.name ?? "", path, line, line, language, {
					signature: trimmed,
				}),
			);
			continue;
		}

		const fromImp = PY_FROM_IMPORT_RE.exec(trimmed);
		if (fromImp?.groups) {
			const namesRaw = (fromImp.groups.names ?? "").trim();
			const names = splitPythonImportNames(namesRaw);
			for (const n of names) {
				out.push(
					makeSymbol("import", fromImp.groups.source ?? "", path, line, line, language, {
						containerName: n,
					}),
				);
			}
			continue;
		}

		const imp = PY_IMPORT_RE.exec(trimmed);
		if (imp?.groups) {
			const modules = (imp.groups.modules ?? "")
				.split(",")
				.map(
					(s) =>
						s
							.trim()
							.split(/\s+as\s+/i)[0]
							?.split(".")[0] ?? "",
				)
				.filter((s) => s.length > 0);
			for (const m of modules) {
				out.push(makeSymbol("import", m, path, line, line, language));
			}
			continue;
		}

		// Module-level assignment: column 0, identifier first, not a
		// keyword, not followed by `==` (comparison).
		if (!/^\s/.test(text)) {
			const assign = PY_ASSIGN_RE.exec(trimmed);
			if (assign?.groups) {
				const name = assign.groups.name ?? "";
				if (!PY_STMT_KEYWORDS.has(name)) {
					const after = trimmed[name.length] ?? "";
					if (after !== "=") {
						out.push(
							makeSymbol("variable", name, path, line, line, language, {
								modifiers: ["module-level"],
								signature: trimmed,
							}),
						);
					}
				}
			}
		}
	}
	return out;
}

/**
 * Split a Python `from X import a, b as c, d` clause into the
 * imported local names. Returns the local name (after `as` if present,
 * otherwise before it).
 */
function splitPythonImportNames(raw: string): string[] {
	const out: string[] = [];
	for (const part of raw.split(",")) {
		const t = part.trim();
		if (t.length === 0) continue;
		if (t.startsWith("(") || t.endsWith(")")) continue;
		const asMatch = /^(\w+)\s+as\s+(\w+)$/i.exec(t);
		out.push(asMatch ? asMatch[2] : t.split(".")[0]);
	}
	return out;
}

/* -------------------------------------------------------------------------- */
/* JSON extractor                                                              */
/* -------------------------------------------------------------------------- */

export function extractJsonSymbols(content: string, path: string, language: string): SymbolEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return [];
	}
	if (typeof parsed !== "object" || parsed === null) return [];

	const out: SymbolEntry[] = [];
	walkJsonKeys(parsed as Record<string, unknown> | unknown[], "", path, language, out);
	return out;
}

function walkJsonKeys(node: unknown, parent: string, path: string, language: string, out: SymbolEntry[]): void {
	if (Array.isArray(node)) return;
	if (typeof node !== "object" || node === null) return;
	for (const key of Object.keys(node)) {
		const fullPath = parent === "" ? key : `${parent}.${key}`;
		out.push(makeSymbol("json-key", fullPath, path, 0, 0, language));
		walkJsonKeys((node as Record<string, unknown>)[key], fullPath, path, language, out);
	}
}

/* -------------------------------------------------------------------------- */
/* Markdown extractor                                                          */
/* -------------------------------------------------------------------------- */

const MD_HEADING_RE = /^(?<hashes>#{1,6})\s+(?<text>.+?)\s*#*\s*$/;
const MD_FENCE_RE = /^(?<indent>\s{0,3})(?<fence>`{3,}|~{3,})(?<lang>\w*)/;

export function extractMarkdownSymbols(content: string, path: string, language: string): SymbolEntry[] {
	const out: SymbolEntry[] = [];
	let inFence = false;
	let fenceMarker = "";
	let fenceStart = 0;
	let fenceLang = "";

	for (const { line, text } of iterateLines(content)) {
		const fenceMatch = MD_FENCE_RE.exec(text);
		if (fenceMatch?.groups) {
			const marker = fenceMatch.groups.fence ?? "";
			if (!inFence) {
				inFence = true;
				fenceMarker = marker[0] ?? "`";
				fenceStart = line;
				fenceLang = fenceMatch.groups.lang ?? "";
			} else if (marker.startsWith(fenceMarker) && marker.length >= fenceMarker.length) {
				out.push(
					makeSymbol("code-block", fenceLang, path, fenceStart, line, language, {
						modifiers: ["fenced"],
					}),
				);
				inFence = false;
				fenceMarker = "";
				fenceLang = "";
			}
			continue;
		}

		if (inFence) continue;

		const h = MD_HEADING_RE.exec(text);
		if (h?.groups) {
			const hashes = h.groups.hashes ?? "";
			const headingText = h.groups.text ?? "";
			const modifiers: string[] = [`h${hashes.length}`];
			out.push(
				makeSymbol("heading", headingText, path, line, line, language, {
					modifiers,
				}),
			);
		}
	}
	// Unterminated fence: still record it as a code-block ending at
	// the last line. Keeps the index consistent when a file was
	// truncated mid-fence.
	if (inFence) {
		const lastLine = content.split("\n").length;
		out.push(
			makeSymbol("code-block", fenceLang, path, fenceStart, lastLine, language, {
				modifiers: ["fenced", "unterminated"],
			}),
		);
	}
	return out;
}

