/**
 * F1 syntax service — tree-sitter parser pool.
 *
 * Wraps the `tree-sitter` native binding behind a per-language parser
 * pool. A `Parser` instance is expensive to allocate (it owns a
 * sizeable C-side state) but cheap to reuse once the language is set,
 * so the pool keys on the language tag and lazily instantiates one
 * `Parser` per registered language.
 *
 * ## Thread safety
 *
 * Tree-sitter parsers are documented as not thread-safe in this
 * version. The agent loop is single-threaded, so the pool is safe
 * under our normal usage. If the pool is ever shared across
 * `worker_threads`, the caller must serialise calls to `parse`.
 *
 * ## Failure modes
 *
 * `getOrCreateParser` swallows the engine's "language not set" /
 * "language version mismatch" errors and returns `null` so callers
 * can fall back to the regex extractors without try/catch noise.
 *
 * The pool never throws on a parse failure either: `parse()` returns
 * `null` when the language is missing or the parser instance could
 * not be created. The actual `tree.parse()` invocation can still
 * surface partial / error trees — those are returned, not raised.
 */

import Parser from "tree-sitter";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** Tree-sitter `Language` object. Re-exported so consumers can narrow. */
export type TreeSitterLanguage = Parser.Language;

/** Result of a single parse call. */
export interface ParseResult {
	/** The tree-sitter `Tree` returned by the parser. */
	tree: Parser.Tree;
	/** The language that was used to parse the source. */
	language: TreeSitterLanguage;
	/** Byte length of the source the tree was built from. */
	sourceByteLength: number;
}

/** Internal record kept by the parser pool. */
interface PooledParser {
	parser: Parser;
	language: TreeSitterLanguage;
}

/* -------------------------------------------------------------------------- */
/* Pool                                                                       */
/* -------------------------------------------------------------------------- */

const parserPool = new Map<TreeSitterLanguage, PooledParser>();

/**
 * Get or create a `Parser` for `language`. The pool keys on the
 * `Language` object identity — two distinct `Language` instances for
 * the same grammar each get their own parser.
 *
 * Returns `null` if the language cannot be assigned (e.g. version
 * mismatch with the bundled `tree-sitter` native module, or the
 * underlying native binding is missing). Callers must treat a
 * `null` return as "fall back to the regex extractor".
 */
export function getOrCreateParser(language: TreeSitterLanguage): Parser | null {
	const cached = parserPool.get(language);
	if (cached) return cached.parser;
	try {
		const parser = new Parser();
		parser.setLanguage(language);
		const record: PooledParser = { parser, language };
		parserPool.set(language, record);
		return parser;
	} catch {
		// Native binding missing, version mismatch, or some other
		// engine-level error. Surface as "no parser available" so
		// callers can degrade gracefully.
		return null;
	}
}

/**
 * Drop the cached parser for `language`. Useful for tests that
 * re-register the same `Language` instance with a different grammar,
 * and for memory-bounded long-running sessions that want to release
 * the per-language C state.
 */
export function releaseParser(language: TreeSitterLanguage): void {
	parserPool.delete(language);
}

/** Drop every cached parser. Intended for test teardown. */
export function resetParserPool(): void {
	parserPool.clear();
}

/* -------------------------------------------------------------------------- */
/* Parse entry point                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Parse `source` with `language`. Returns `null` if the language has
 * no usable parser (e.g. the native binding is not loaded). The
 * returned `tree` may carry `hasError === true` if the source
 * contains syntax errors — partial / error-tolerant trees are
 * returned, not raised, so extractors can still pull symbols out of
 * the parts that parsed successfully.
 */
export function parse(source: string, language: TreeSitterLanguage): ParseResult | null {
	const parser = getOrCreateParser(language);
	if (!parser) return null;
	const tree = parser.parse(source);
	if (!tree) return null;
	return { tree, language, sourceByteLength: Buffer.byteLength(source, "utf-8") };
}

/* -------------------------------------------------------------------------- */
/* Re-exports                                                                 */
/* -------------------------------------------------------------------------- */

/** Re-exported so consumers can construct parsers directly. */
export { Parser };

