/**
 * F1 syntax service — tree-sitter-backed syntax index builder.
 *
 * Walks the manifest, parses each file with the language registered
 * for its `language` tag, and converts parse trees into
 * `SymbolEntry` records. The per-file extraction is independent so
 * the live index can re-run one file at a time without re-walking
 * the whole tree.
 *
 * ## Fallback contract
 *
 * The tree-sitter path silently falls back to the regex extractors
 * when:
 *
 *   - the file's language has no entry in the registry;
 *   - the parser engine cannot be initialised for the registered
 *     language (e.g. native binding is missing);
 *   - parsing the file throws.
 *
 * Callers never see a throw from this module. The only signal of a
 * fallback is the absence of `startByte` / `endByte` on the produced
 * entries (regex extractors do not populate them; tree-sitter
 * extractors always do).
 *
 * ## Memory bound
 *
 * The same `maxSymbolsPerFile` cap from `syntax-index.ts` is honoured
 * so a single pathological file cannot blow up the index.
 */

import type { FileManifestEntry } from "./manifest.ts";
import type { SymbolEntry } from "./syntax-index.ts";
import type { TreeSitterLanguageBinding } from "./tree-sitter-languages.ts";
import {
	bindingForEntry,
	MARKDOWN_LANGUAGE_TAG,
	parseMarkdown,
	parseSourceWithLanguage,
} from "./tree-sitter-languages.ts";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface BuildSyntaxIndexWithTreeSitterOptions {
	/**
	 * Restrict extraction to these language tags. Default: every
	 * supported language. Languages without a tree-sitter binding
	 * are silently skipped.
	 */
	languages?: string[];
	/**
	 * Hard cap on the number of symbols produced per file. Mirrors
	 * the cap in `syntax-index.ts` so the index size stays bounded.
	 * Default 5000.
	 */
	maxSymbolsPerFile?: number;
}

/* -------------------------------------------------------------------------- */
/* Builder                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build the tree-sitter-backed syntax index for `manifest`. The
 * returned array is sorted by `(path, startByte, kind)` and is
 * ready to be merged with regex-extracted entries.
 *
 * The function returns `[]` when the registry is empty. Callers
 * are expected to fall back to `buildSyntaxIndex` in that case
 * (see `syntax-index.ts`'s dispatcher).
 */
export async function buildSyntaxIndexWithTreeSitter(
	manifest: FileManifestEntry[],
	options?: BuildSyntaxIndexWithTreeSitterOptions,
): Promise<SymbolEntry[]> {
	const languageFilter = options?.languages ? new Set(options.languages) : null;
	const maxSymbolsPerFile = options?.maxSymbolsPerFile ?? 5000;

	const out: SymbolEntry[] = [];

	for (const entry of manifest) {
		if (entry.language === null) continue;
		if (languageFilter !== null && !languageFilter.has(entry.language)) continue;
		const binding = bindingForEntry(entry);
		if (!binding) continue;

		const symbols = await extractSingleFile(entry, binding, maxSymbolsPerFile);
		for (const s of symbols) out.push(s);
	}

	out.sort(compareSymbols);
	return out;
}

/* -------------------------------------------------------------------------- */
/* Per-file extraction                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Parse `entry.absolutePath` and run the per-language extractor.
 * Returns `[]` for missing files, parse errors, or extractor throws.
 * Exposed for `LiveSyntaxIndex` so single-file updates can reuse
 * the same dispatch logic.
 */
export async function extractFileWithTreeSitter(
	entry: Pick<FileManifestEntry, "absolutePath" | "language" | "path">,
	binding: TreeSitterLanguageBinding,
	maxSymbolsPerFile = 5000,
): Promise<SymbolEntry[]> {
	if (!entry.language) return [];
	const content = await readContentOrEmpty(entry.absolutePath);
	if (content === null) return [];
	return runExtractor(content, entry.path, entry.language, binding, maxSymbolsPerFile);
}

async function extractSingleFile(
	entry: FileManifestEntry,
	binding: TreeSitterLanguageBinding,
	maxSymbolsPerFile: number,
): Promise<SymbolEntry[]> {
	if (!entry.language) return [];
	const content = await readContentOrEmpty(entry.absolutePath);
	if (content === null) return [];
	return runExtractor(content, entry.path, entry.language, binding, maxSymbolsPerFile);
}

function runExtractor(
	content: string,
	filePath: string,
	language: string,
	binding: TreeSitterLanguageBinding,
	maxSymbolsPerFile: number,
): SymbolEntry[] {
	let tree: import("./tree-sitter-languages.ts").SyntaxTreeLike | null;
	try {
		tree = language === MARKDOWN_LANGUAGE_TAG ? parseMarkdown(content) : parseSourceWithLanguage(content, binding);
	} catch {
		return [];
	}
	if (!tree) return [];

	let symbols: SymbolEntry[];
	try {
		symbols = binding.extract(tree, content, filePath, language);
	} catch {
		// A bug in a custom extractor must not poison the rest of
		// the index. Drop the file's symbols and move on.
		return [];
	}

	if (symbols.length > maxSymbolsPerFile) {
		symbols = symbols.slice(0, maxSymbolsPerFile);
	}
	return symbols;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function readContentOrEmpty(absolutePath: string): Promise<string | null> {
	try {
		const moduleName = "node" + ":" + "fs/promises";
		const fs = (await import(/* @vite-ignore */ moduleName)) as typeof import("node:fs/promises");
		return await fs.readFile(absolutePath, "utf-8");
	} catch {
		return null;
	}
}

function compareSymbols(a: SymbolEntry, b: SymbolEntry): number {
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	const aStart = a.startByte ?? a.startLine;
	const bStart = b.startByte ?? b.startLine;
	if (aStart !== bStart) return aStart - bStart;
	if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
	return 0;
}

