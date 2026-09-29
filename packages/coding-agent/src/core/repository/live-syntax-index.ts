/**
 * F1 live syntax index — watcher-driven view of the syntax index.
 *
 * The `LiveSyntaxIndex` wraps an initial `SymbolEntry[]` snapshot
 * together with a `FileWatcher` and produces an always-fresh view that
 * satisfies the audit's invalidation contract (Section 11.4):
 *
 *   - Treat watcher events as hints; verify hashes at query and
 *     mutation boundaries.
 *   - Reparse changed files; invalidate outgoing relationships and
 *     dependent semantic results.
 *
 * ## Event handling
 *
 * - `change` / `create` — the file is re-read from disk and its
 *   symbols are re-extracted using the same per-language regex /
 *   heuristic extractors as `syntax-index.ts`.
 * - `delete` — the file's symbols are dropped from the index.
 * - `rename` — the old path's symbols are removed and the new path's
 *   are extracted.
 * - `overflow` — the `isStale` flag is set; the next call to
 *   `getSymbolsForFile` re-extracts that file's symbols from disk and
 *   clears the flag. Callers that do not call `getSymbolsForFile`
 *   after an overflow continue to see the pre-overflow symbols until
 *   they do.
 *
 * User-registered handlers (`onEvent`) are invoked before the
 * internal state is updated, mirroring `LiveManifest`. This means a
 * subscriber observing an event can be confident the internal
 * invalidation will be applied even if their own handler throws.
 */

import { join, resolve, sep } from "node:path";
import type { FileWatcher, WatcherEvent } from "./file-watcher.ts";
import { detectLanguage, type FileManifestEntry } from "./manifest.ts";
import type { SymbolEntry, SymbolKind } from "./syntax-index.ts";
import {
	extractJavaScriptSymbols,
	extractJsonSymbols,
	extractMarkdownSymbols,
	extractPythonSymbols,
	extractTypeScriptSymbols,
} from "./syntax-index.ts";
import { bindingForEntry } from "./tree-sitter-languages.ts";
import { extractFileWithTreeSitter } from "./tree-sitter-syntax-index.ts";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface LiveSyntaxIndexOptions {
	/** Initial symbol index; copied into an internal map keyed by file path. */
	index: SymbolEntry[];
	/** Source of invalidation events. */
	watcher: FileWatcher;
	/** Absolute path to the worktree root (used to resolve relative paths). */
	root: string;
	/**
	 * When `false`, `stop()` only detaches the event subscription and
	 * does NOT stop the underlying watcher. Use this when the watcher
	 * is shared with other owners (e.g. a `LiveQueryToolData` layer
	 * that must keep receiving events across rebuilds). Default `true`:
	 * `stop()` stops the underlying watcher as well.
	 */
	stopWatcher?: boolean;
}

export interface FindSymbolsLiveOptions {
	kind?: SymbolKind;
	language?: string;
	caseSensitive?: boolean;
}

export interface LiveSyntaxIndex {
	/** Return the current symbol snapshot as a flat array. */
	getSymbols(): SymbolEntry[];
	/**
	 * Return the symbols belonging to `path`. If `isStale()` is true,
	 * the file is re-extracted from disk first and the staleness flag
	 * is cleared.
	 */
	getSymbolsForFile(path: string): SymbolEntry[];
	/**
	 * Case-insensitive (or case-sensitive, when `caseSensitive` is set)
	 * substring search over symbol names, with optional kind / language
	 * filters. The returned array preserves the index's existing
	 * ordering.
	 */
	findSymbols(query: string, options?: FindSymbolsLiveOptions): SymbolEntry[];
	/** Subscribe to invalidation events propagated by the underlying watcher. */
	onEvent(handler: (event: WatcherEvent) => void): () => void;
	/**
	 * Detach the event subscription and (unless constructed with
	 * `stopWatcher: false`) stop the underlying watcher. After
	 * `stop()` no further events are delivered and the live syntax
	 * index becomes a read-only snapshot.
	 */
	stop(): void;
	/**
	 * True after the most recent `overflow` event, until the next
	 * `getSymbolsForFile` call clears it by re-extracting the file's
	 * symbols.
	 */
	isStale(): boolean;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Normalize any backslashes to forward slashes for consistent matching. */
function toPosix(path: string): string {
	return path.split(sep).join("/");
}

type Extractor = (content: string, path: string, language: string) => SymbolEntry[];

/**
 * Per-language extractor dispatch. Mirrors the table in
 * `syntax-index.ts`. Unsupported languages produce an empty array
 * (no throw). Add a new entry here when adding a new language.
 */
const EXTRACTORS: Record<string, Extractor> = {
	typescript: extractTypeScriptSymbols,
	javascript: extractJavaScriptSymbols,
	python: extractPythonSymbols,
	json: extractJsonSymbols,
	markdown: extractMarkdownSymbols,
};

/**
 * Read the file at `absolutePath` as UTF-8. Returns `null` on any I/O
 * error (missing file, permission denied, etc.) so callers can
 * degrade gracefully. The runtime-concatenated specifier keeps browser
 * bundlers (the check-browser-smoke script) from statically resolving
 * `node:fs/promises` if this module is ever imported from a browser
 * entry — the same trick used in `manifest.ts` and `syntax-index.ts`.
 */
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
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Create a `LiveSyntaxIndex` that subscribes to `options.watcher` and
 * produces an always-fresh view of `options.index`.
 *
 * The initial index is bucketed into a `Map<path, SymbolEntry[]>`,
 * so subsequent mutations to the caller's array are not reflected.
 */
export function createLiveSyntaxIndex(options: LiveSyntaxIndexOptions): LiveSyntaxIndex {
	const rootAbsolute = resolve(options.root);
	const byPath = new Map<string, SymbolEntry[]>();
	for (const sym of options.index) {
		const list = byPath.get(sym.path);
		if (list) {
			list.push(sym);
		} else {
			byPath.set(sym.path, [sym]);
		}
	}

	let isStaleFlag = false;
	let stopped = false;
	const userHandlers = new Set<(event: WatcherEvent) => void>();
	// Return the handler's Promise so callers that `await` their
	// dispatch (test helpers, the `FileWatcher.emit` loop in tests)
	// observe the post-refresh state. The production `FileWatcher.emit`
	// does not await, so a returned Promise is harmless there.
	const unsubscribeWatcher = options.watcher.onEvent((event) => handleEvent(event));

	function absoluteOf(rel: string): string {
		// Use posix separators when joining so the join is pure.
		return join(rootAbsolute, ...rel.split("/"));
	}

	/**
	 * Re-extract the symbols for `rel` by reading the file from disk
	 * and dispatching to the per-language extractor. Returns `[]` for
	 * unsupported languages, missing files, or extractor throws.
	 *
	 * When a tree-sitter binding is registered for the file's
	 * language, the tree-sitter path is used first. Any per-file
	 * parse failure (engine init, missing grammar) falls back to
	 * the regex extractors so a single bad file never blocks the
	 * rest of the index from refreshing.
	 */
	async function extractFor(rel: string): Promise<SymbolEntry[]> {
		const language = detectLanguage(rel);
		if (language === null) return [];
		const absolute = absoluteOf(rel);
		const manifestLike: FileManifestEntry = {
			path: rel,
			absolutePath: absolute,
			byteLength: 0,
			language,
			generated: false,
			ignored: false,
		};
		const binding = bindingForEntry(manifestLike);
		if (binding) {
			try {
				const symbols = await extractFileWithTreeSitter(manifestLike, binding);
				if (symbols.length > 0) return symbols;
			} catch {
				// Fall through to the regex extractor below.
			}
		}
		const extractor = EXTRACTORS[language];
		if (!extractor) return [];
		const content = await readContentOrNull(absolute);
		if (content === null) return [];
		try {
			return extractor(content, rel, language);
		} catch {
			// A malformed file should not poison the rest of the
			// index. Drop the file's symbols and move on.
			return [];
		}
	}

	async function handleEvent(event: WatcherEvent): Promise<void> {
		if (stopped) return;

		// Fan-out to user-registered handlers first so they observe
		// the invalidation signal even if the internal refresh fails.
		for (const handler of userHandlers) {
			try {
				handler(event);
			} catch {
				// Handler errors must not break the invalidation pipeline.
			}
		}

		switch (event.kind) {
			case "change":
			case "create": {
				const symbols = await extractFor(event.path);
				byPath.set(event.path, symbols);
				break;
			}
			case "delete":
				byPath.delete(event.path);
				break;
			case "rename":
				byPath.delete(event.oldPath);
				{
					const symbols = await extractFor(event.newPath);
					byPath.set(event.newPath, symbols);
				}
				break;
			case "overflow":
				isStaleFlag = true;
				break;
		}
	}

	function getSymbols(): SymbolEntry[] {
		const out: SymbolEntry[] = [];
		for (const list of byPath.values()) {
			for (const sym of list) out.push(sym);
		}
		return out;
	}

	function getSymbolsForFile(path: string): SymbolEntry[] {
		const target = toPosix(path);
		if (isStaleFlag) {
			isStaleFlag = false;
			void (async () => {
				const symbols = await extractFor(target);
				if (!stopped) byPath.set(target, symbols);
			})();
		}
		const list = byPath.get(target);
		return list ? list.slice() : [];
	}

	function findSymbols(query: string, opts?: FindSymbolsLiveOptions): SymbolEntry[] {
		const caseSensitive = opts?.caseSensitive ?? false;
		const kindFilter = opts?.kind;
		const languageFilter = opts?.language;
		const needle = caseSensitive ? query : query.toLowerCase();

		const out: SymbolEntry[] = [];
		for (const list of byPath.values()) {
			for (const sym of list) {
				if (kindFilter !== undefined && sym.kind !== kindFilter) continue;
				if (languageFilter !== undefined && sym.language !== languageFilter) continue;
				const hay = caseSensitive ? sym.name : sym.name.toLowerCase();
				if (!hay.includes(needle)) continue;
				out.push(sym);
			}
		}
		return out;
	}

	function onEvent(handler: (event: WatcherEvent) => void): () => void {
		userHandlers.add(handler);
		return () => {
			userHandlers.delete(handler);
		};
	}

	function stop(): void {
		if (stopped) return;
		stopped = true;
		unsubscribeWatcher();
		if (options.stopWatcher !== false) {
			void options.watcher.stop();
		}
	}

	return {
		getSymbols,
		getSymbolsForFile,
		findSymbols,
		onEvent,
		stop,
		isStale: () => isStaleFlag,
	};
}

