/**
 * F1 `query` tool — live data layer.
 *
 * The `query` tool is a read-only tool the model can invoke to get
 * structured, factual answers about the repository (see
 * `../tools/query.ts`). It is bound at factory time to three data
 * layers: the file manifest, the syntax index, and a semantic query
 * adapter.
 *
 * Building all three from scratch is expensive — the manifest walk and
 * the syntax extraction are I/O-bound. `LiveQueryToolData` exists to
 * wrap that work behind a `getToolData()` accessor and a `refresh()`
 * method, with a short-lived cache so repeated calls during a single
 * assistant turn don't re-walk the tree.
 *
 * Cache invalidation is the caller's responsibility: whenever the
 * session knows the worktree has changed (e.g. after a `write` /
 * `edit` tool call, a `bash` command that mutates files, or a
 * `git pull`), it should `await liveQueryToolData.refresh()` before
 * the next `getToolData()` so the next tool call sees fresh data.
 * Between refreshes, `getToolData()` returns the same `QueryToolData`
 * object, which keeps the `query` tool's results stable within a
 * single turn.
 */

import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SettingsManager } from "../settings-manager.ts";
import type { FileWatcher } from "./file-watcher.ts";
import type { LiveSyntaxIndex } from "./live-syntax-index.ts";
import { createLiveSyntaxIndex } from "./live-syntax-index.ts";
import { LspManager } from "./lsp-manager.ts";
import type { FileManifestEntry } from "./manifest.ts";
import { buildManifest } from "./manifest.ts";
import type { SemanticQueryAdapter } from "./semantic-queries.ts";
import { createSemanticQueryAdapter, MockSemanticQueryAdapter } from "./semantic-queries.ts";
import type { SymbolEntry, SyntaxIndexBackend } from "./syntax-index.ts";
import { buildSyntaxIndex } from "./syntax-index.ts";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A snapshot of the data the F1 `query` tool needs to answer a query.
 *
 * `manifest` lists every file in the worktree; `symbolIndex` lists
 * every extracted declaration / import / export; `semanticAdapter`
 * is the LSP-shaped backend the tool consults for `get-definition`
 * and `find-references`. `root` is the absolute worktree root the
 * manifest was built from — used for diagnostics.
 */
export interface QueryToolData {
	manifest: FileManifestEntry[];
	symbolIndex: SymbolEntry[];
	semanticAdapter: SemanticQueryAdapter;
	root: string;
	/**
	 * Watcher-driven live view of the syntax index. Only present when
	 * `createLiveQueryToolData` was constructed with a `watcher`
	 * option. The `symbolIndex` field above is a snapshot of this
	 * live view at the time of the `getToolData()` call.
	 */
	liveSyntaxIndex?: LiveSyntaxIndex;
}

/**
 * The live data layer the F1 `query` tool binds to. Callers obtain
 * a fresh `QueryToolData` via `getToolData()` and force a rebuild via
 * `refresh()`.
 */
export interface LiveQueryToolData {
	/**
	 * Return the current `QueryToolData`. If the cached snapshot is
	 * younger than `maxAgeMs` (set at construction time) it is returned
	 * directly; otherwise the data is rebuilt before being returned.
	 * When a `watcher` was supplied, a cached return re-snapshots the
	 * watcher-driven symbol index so events observed since the last
	 * rebuild are reflected.
	 */
	getToolData(): Promise<QueryToolData>;
	/**
	 * Force a rebuild. Resets the cache and re-runs the manifest
	 * walk + (optionally) syntax extraction. The next `getToolData()`
	 * call returns the fresh snapshot. The underlying watcher (if any)
	 * is NOT stopped: it survives rebuilds and is only stopped by
	 * `dispose()`.
	 */
	refresh(): Promise<void>;
	/**
	 * Tear down the data layer: detach the live syntax index and stop
	 * the underlying file watcher (if one was supplied). Idempotent;
	 * safe to call from a session dispose path. After `dispose()` the
	 * layer still serves its last snapshot via `getToolData()`, but no
	 * further events are observed.
	 */
	dispose(): Promise<void>;
}

export interface CreateLiveQueryToolDataOptions {
	/** Worktree root the manifest will be built from. */
	root: string;
	/**
	 * Semantic query adapter. Defaults to one built from
	 * `semanticBackend` (or auto-detection); when supplied it always
	 * wins and `semanticBackend` is ignored.
	 */
	adapter?: SemanticQueryAdapter;
	/**
	 * Select the semantic query backend. When unset, the data layer
	 * auto-detects: it probes the worktree for a usable language
	 * server (e.g. `typescript-language-server` on `PATH` or in
	 * `node_modules/.bin`); if one is found, `"lsp"` is selected
	 * and a real `LspAdapter` is wired in. Otherwise, if the
	 * worktree root has a `tsconfig.json` and the manifest contains
	 * at least one `.ts` / `.tsx` / `.mts` / `.cts` file,
	 * `"typescript-ls"` is selected and a real
	 * `TypeScriptLanguageServiceAdapter` is built from the manifest;
	 * otherwise `"mock"`. `adapter` always wins over this option.
	 */
	semanticBackend?: LiveQuerySemanticBackend;
	/**
	 * Whether to compute the syntax index alongside the manifest.
	 * Default `true`. Set to `false` if the caller only needs the
	 * manifest (e.g. for `find-files` queries).
	 */
	computeSymbolIndex?: boolean;
	/**
	 * Maximum age (in milliseconds) of a cached snapshot before
	 * `getToolData()` triggers a rebuild. Default 5_000ms (5 seconds).
	 * Pass a very large value to effectively disable the time-based
	 * refresh, or call `refresh()` manually when the worktree changes.
	 */
	maxAgeMs?: number;
	/**
	 * Optional file watcher. When supplied, the data layer starts it
	 * (start failures degrade to the no-watcher behavior) and a
	 * `LiveSyntaxIndex` is constructed from the initial syntax index
	 * and exposed via `QueryToolData.liveSyntaxIndex`. Watcher events
	 * then keep the symbol index in sync without requiring an explicit
	 * `refresh()`. The layer owns the watcher's lifecycle: `refresh()`
	 * keeps it running across rebuilds and `dispose()` stops it.
	 */
	watcher?: FileWatcher;
	/**
	 * Optional settings manager. When supplied, the data layer reads
	 * `settingsManager.getRepositoryTreeSitterEnabled()` and routes
	 * `buildSyntaxIndex` through the tree-sitter backend when the
	 * flag is true. When omitted, the dispatcher defaults to regex.
	 */
	settingsManager?: SettingsManager;
}

/**
 * Backend the live data layer uses to answer semantic queries.
 *
 *   - `"mock"`          — `MockSemanticQueryAdapter`. Returns
 *                         `certainty: "unknown"` placeholders.
 *   - `"typescript-ls"` — A real `TypeScriptLanguageServiceAdapter`
 *                         backed by a `ts.Program` built from the
 *                         manifest's source files.
 *   - `"lsp"`           — A real `LspAdapter` driven by an external
 *                         language server (typescript-language-server,
 *                         pylsp, rust-analyzer, gopls, …) over stdio.
 *                         The live data layer constructs an
 *                         `LspManager` for the worktree and binds it
 *                         to the adapter; if no server is on `PATH`
 *                         and no `.theta/lsp.json` override exists,
 *                         the adapter degrades to a
 *                         `certainty: "unknown"` result with an
 *                         honest note.
 */
export type LiveQuerySemanticBackend = "mock" | "typescript-ls" | "lsp";

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_MAX_AGE_MS = 5_000;
const TS_FILE_RE = /\.(?:ts|tsx|mts|cts)$/i;
const TSCONFIG_FILENAME = "tsconfig.json";

/* -------------------------------------------------------------------------- */
/* Backend resolution                                                         */
/* -------------------------------------------------------------------------- */

async function hasTsConfigAt(root: string): Promise<boolean> {
	try {
		const s = await stat(join(root, TSCONFIG_FILENAME));
		return s.isFile();
	} catch {
		return false;
	}
}

function hasTsFileInManifest(manifest: FileManifestEntry[]): boolean {
	for (const entry of manifest) {
		if (entry.ignored) continue;
		if (TS_FILE_RE.test(entry.path)) return true;
	}
	return false;
}

/**
 * Build a `ts.Program` from the `.ts` / `.tsx` / `.mts` / `.cts`
 * files in the manifest. Returns `undefined` when the manifest has
 * no TypeScript source files, so callers can fall back to the mock.
 *
 * Pass the previous program via `oldProgram` so the TypeScript
 * compiler reuses unchanged `SourceFile`s and only re-reads files
 * whose mtime/size changed (plus newly added roots). The probe in
 * `test/ts-program-incremental.test.ts` pins the semantics: content
 * changes surface, added/removed roots are honored, and semantic
 * diagnostics still fire. This is the audit's "incrementally
 * maintained repository intelligence" for the semantic layer — a
 * full re-parse per `refresh()` would dominate refresh cost on
 * every `edit`/`write`/`bash` mutation.
 *
 * The `typescript` module is loaded via the same string-indirection
 * `import("type" + "script")` pattern that
 * `TypeScriptLanguageServiceAdapter` uses, so the package keeps
 * `typescript` as a devDependency.
 */
async function buildProgramForManifest(
	manifest: FileManifestEntry[],
	oldProgram: import("typescript").Program | undefined,
): Promise<import("typescript").Program | undefined> {
	const rootNames: string[] = [];
	for (const entry of manifest) {
		if (entry.ignored) continue;
		if (!TS_FILE_RE.test(entry.path)) continue;
		rootNames.push(entry.absolutePath);
	}
	if (rootNames.length === 0) return undefined;
	const moduleName = "type" + "script";
	const ts = (await import(moduleName)) as typeof import("typescript");
	return ts.createProgram({
		rootNames,
		options: {
			noEmit: true,
			skipLibCheck: true,
			allowJs: false,
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
		},
		oldProgram: rootNames.length > 0 && oldProgram !== undefined ? oldProgram : undefined,
	});
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Create a `LiveQueryToolData` rooted at `options.root`. The first
 * `getToolData()` call walks the worktree and (by default) extracts
 * symbols; subsequent calls return the cached snapshot until
 * `maxAgeMs` elapses, or until `refresh()` is invoked.
 *
 * The mock adapter is used unless `options.adapter` is supplied or
 * the worktree auto-detects as a TypeScript project. The mock returns
 * `certainty: "unknown"` placeholders so callers see "the adapter
 * has no answer" rather than a silent "no references found" — see
 * `MockSemanticQueryAdapter` for the contract.
 */
export function createLiveQueryToolData(options: CreateLiveQueryToolDataOptions): LiveQueryToolData {
	const rootResolved = resolve(options.root);
	const explicitAdapter = options.adapter;
	const explicitBackend = options.semanticBackend;
	const computeSymbolIndex = options.computeSymbolIndex ?? true;
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	const watcher = options.watcher;
	const settingsManager = options.settingsManager;

	// Start the supplied watcher now (degrade gracefully on failure —
	// e.g. an unavailable backend — to the no-watcher behavior). The
	// first `build()` subscribes the live index to it; events that
	// fire before that are hints we may miss, which the audit
	// contract ("hints, not truth") accepts.
	if (watcher !== undefined) {
		void watcher.start().catch(() => {
			// Start failed: the live index will simply never receive
			// events. `dispose()` still stops the watcher idempotently.
		});
	}

	let cached: QueryToolData | undefined;
	let lastRefreshedAt = 0;
	let disposed = false;
	// Owns the live syntax index when a watcher is supplied. Tracked
	// separately from the snapshot so the cached `QueryToolData` can
	// hold a stable array reference for `symbolIndex` even while the
	// live index is updated by watcher events.
	let liveSyntaxIndex: LiveSyntaxIndex | undefined;
	// Cached snapshot of `liveSyntaxIndex.getSymbols()`. Re-snapshotted
	// on `refresh()` and on each cached `getToolData()` call so the
	// `symbolIndex` field reflects the watcher's latest state.
	let liveSymbolSnapshot: SymbolEntry[] | undefined;
	// Previous `ts.Program` from the last successful `typescript-ls`
	// build. Passed as `oldProgram` on the next rebuild so the compiler
	// reuses unchanged `SourceFile`s instead of re-parsing the whole
	// worktree after every edit/write/bash mutation (audit F1:
	// incrementally maintained repository intelligence).
	let previousProgram: import("typescript").Program | undefined;

	async function resolveAdapter(manifest: FileManifestEntry[]): Promise<SemanticQueryAdapter> {
		// Explicit adapter always wins.
		if (explicitAdapter) return explicitAdapter;

		// Explicit backend chooses the path without auto-detect.
		if (explicitBackend !== undefined) {
			return buildAdapterForBackend(explicitBackend, manifest);
		}

		// Auto-detect: prefer LSP when a server is on PATH (with a
		// `.theta/lsp.json` override or in `node_modules/.bin`).
		// Fall back to the in-process `typescript-ls` for TypeScript
		// projects that have not installed a language server, and
		// finally to the mock.
		const manager = new LspManager({ worktree: rootResolved });
		const lspProbe = manager.probe("typescript");
		if (lspProbe.command) {
			return createSemanticQueryAdapter({
				backend: "lsp",
				config: { manager, language: "typescript" },
			});
		}
		// The manager is only useful when we end up on the LSP path.
		// For the typecheck / mock paths, dispose it eagerly so the
		// child process slot is not held.
		const disposeManager = async (): Promise<void> => {
			try {
				await manager.dispose();
			} catch {
				// Already disposed.
			}
		};
		if (!hasTsFileInManifest(manifest)) {
			await disposeManager();
			return new MockSemanticQueryAdapter();
		}
		const hasConfig = await hasTsConfigAt(rootResolved);
		if (!hasConfig) {
			await disposeManager();
			return new MockSemanticQueryAdapter();
		}
		// TypeScript LS is a working in-process fallback when no
		// external server is present. The manager is no longer
		// needed for the typecheck path.
		await disposeManager();
		return buildAdapterForBackend("typescript-ls", manifest);
	}

	async function buildAdapterForBackend(
		backend: LiveQuerySemanticBackend,
		manifest: FileManifestEntry[],
	): Promise<SemanticQueryAdapter> {
		if (backend === "mock") return new MockSemanticQueryAdapter();
		if (backend === "lsp") {
			const manager = new LspManager({ worktree: rootResolved });
			return createSemanticQueryAdapter({
				backend: "lsp",
				config: { manager, language: "typescript" },
			});
		}
		// backend === "typescript-ls"
		const program = await buildProgramForManifest(manifest, previousProgram);
		if (!program) return new MockSemanticQueryAdapter();
		previousProgram = program;
		return createSemanticQueryAdapter({
			backend: "typescript-ls",
			config: { program, worktree: rootResolved },
		});
	}

	async function build(): Promise<QueryToolData> {
		const manifest = await buildManifest({ root: rootResolved });
		// Resolve the syntax index backend from the settings manager
		// when one is supplied; otherwise default to regex. The
		// `buildSyntaxIndex` dispatcher in `syntax-index.ts` falls
		// back per-file when the chosen backend cannot parse a
		// given language, so this knob only ever narrows the
		// default.
		const syntaxBackend: SyntaxIndexBackend =
			settingsManager?.getRepositoryTreeSitterEnabled() === false ? "regex" : "auto";
		const symbolIndex = computeSymbolIndex
			? await buildSyntaxIndex(manifest, syntaxBackend === "regex" ? undefined : { backend: syntaxBackend })
			: [];

		// Tear down the previous live index (if any) so the new
		// manifest gets a fresh subscription to the watcher. The
		// `stopWatcher: false` flag detaches the old subscription
		// without stopping the shared watcher, which must keep
		// running across rebuilds (only `dispose()` stops it).
		if (liveSyntaxIndex !== undefined) {
			liveSyntaxIndex.stop();
			liveSyntaxIndex = undefined;
		}
		liveSymbolSnapshot = undefined;

		const adapter = await resolveAdapter(manifest);

		const data: QueryToolData = {
			manifest,
			symbolIndex,
			semanticAdapter: adapter,
			root: rootResolved,
		};
		if (watcher !== undefined && computeSymbolIndex && !disposed) {
			liveSyntaxIndex = createLiveSyntaxIndex({
				index: symbolIndex,
				watcher,
				root: rootResolved,
				stopWatcher: false,
			});
			data.liveSyntaxIndex = liveSyntaxIndex;
		}
		return data;
	}

	async function refresh(): Promise<void> {
		const next = await build();
		// If a live index is in use, refresh the cached snapshot from
		// it so `data.symbolIndex` reflects the new baseline.
		if (next.liveSyntaxIndex !== undefined) {
			liveSymbolSnapshot = next.liveSyntaxIndex.getSymbols();
			next.symbolIndex = liveSymbolSnapshot;
		}
		cached = next;
		lastRefreshedAt = Date.now();
	}

	async function getToolData(): Promise<QueryToolData> {
		if (cached !== undefined && (disposed || Date.now() - lastRefreshedAt < maxAgeMs)) {
			// When a watcher-driven live index is attached, re-snapshot
			// the `symbolIndex` field so watcher events observed since
			// the last rebuild are reflected in the returned snapshot.
			// Without a watcher the field is untouched, keeping the
			// stable-array-reference behavior tested by
			// `query-data-cache.test.ts`.
			if (liveSyntaxIndex !== undefined) {
				liveSymbolSnapshot = liveSyntaxIndex.getSymbols();
				cached.symbolIndex = liveSymbolSnapshot;
			}
			return cached;
		}
		await refresh();
		// `refresh` is guaranteed to assign `cached`; the cast documents
		// the post-condition without adding a non-null operator at every
		// call site.
		return cached as QueryToolData;
	}

	async function dispose(): Promise<void> {
		disposed = true;
		if (liveSyntaxIndex !== undefined) {
			liveSyntaxIndex.stop();
			liveSyntaxIndex = undefined;
		}
		// Release the retained `ts.Program` so a disposed layer does not
		// pin its SourceFile graph in memory.
		previousProgram = undefined;
		if (watcher !== undefined) {
			try {
				await watcher.stop();
			} catch {
				// Stop errors must not propagate to the dispose caller.
			}
		}
	}

	return { getToolData, refresh, dispose };
}

