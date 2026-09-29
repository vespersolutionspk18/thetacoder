/**
 * F1 LSP backend — server auto-detection.
 *
 * Given a worktree root and a language tag, find the right language
 * server command. The audit (Section 11.3 "API design") calls for the
 * `lsp` adapter to be backed by an external language server when one
 * is available, with an in-process fallback for TypeScript.
 *
 * Auto-detection is layered:
 *
 *   1. If the worktree has a `.theta/lsp.json` with an entry for the
 *      language, that entry wins. The schema is the LSP server
 *      `command` + `args` + optional `initializationOptions`. Malformed
 *      entries are ignored so a single bad override does not poison
 *      the rest of the map.
 *   2. Otherwise, look in `<root>/node_modules/.bin/<cmd>` for the
 *      built-in command (resolved to an absolute path so the spawn
 *      is deterministic across `cwd`s).
 *   3. Otherwise, look up the built-in command on `PATH`.
 *   4. For TypeScript, the in-process `TypeScriptLanguageServiceAdapter`
 *      is always a valid fallback; the caller decides whether to use
 *      it. The `LspAdapter` consults this only when no spawned server
 *      is found.
 *
 * Each builtin ships the canonical argv to use, including the
 * `--stdio` flag LSP servers expect. The settings override is the
 * only path that lets the user customise the argv.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** A language tag the LSP layer can address. */
export type LspLanguage = "typescript" | "javascript" | "python" | "rust" | "go";

/** Server command + argv + per-server init options. */
export interface LspServerCommand {
	/** Absolute path or `PATH`-resolvable command name. */
	command: string;
	/** Args to pass to the command. `--stdio` is appended for built-ins. */
	args: string[];
	/** Optional `initializationOptions` payload (sent verbatim). */
	initializationOptions?: Record<string, unknown>;
	/** Environment variables to merge into the spawn env. */
	env?: Record<string, string>;
}

/** The `.theta/lsp.json` override file shape. */
export interface LspOverrideFile {
	[language: string]:
		| {
				command?: string;
				args?: string[];
				initializationOptions?: Record<string, unknown>;
				env?: Record<string, string>;
		  }
		| undefined;
}

export interface ResolveLspServerOptions {
	/** Worktree root. Used to find `.theta/lsp.json` and `node_modules/.bin`. */
	worktree: string;
	/** Language to resolve a server for. */
	language: LspLanguage;
	/** Custom `PATH`. Defaults to `process.env.PATH`. */
	pathEnv?: string;
	/**
	 * The platform-specific extension for executables in `node_modules/.bin`.
	 * Defaults to `".cmd"` on `win32`, `""` on others. The default mirrors
	 * how npm lays out the bin links so the lookup is deterministic
	 * without spawning a shell.
	 */
	binExt?: string;
	/**
	 * When `true`, return `undefined` instead of a `LspServerCommand` for
	 * the TypeScript language if no `typescript-language-server` is on
	 * `PATH` or in the local `node_modules`. The caller (the
	 * `LspAdapter`) then uses the in-process `TypeScriptLanguageServiceAdapter`
	 * as a fallback. Default `true`.
	 */
	allowTypescriptFallback?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Built-in command table                                                     */
/* -------------------------------------------------------------------------- */

interface BuiltinServer {
	/** Resolvable on `PATH` (or `<root>/node_modules/.bin`). */
	command: string;
	/** Args appended after the command. `--stdio` is the LSP convention. */
	args: string[];
}

const BUILTIN_SERVERS: Record<LspLanguage, BuiltinServer> = {
	typescript: { command: "typescript-language-server", args: ["--stdio"] },
	javascript: { command: "typescript-language-server", args: ["--stdio"] },
	python: { command: "pylsp", args: [] },
	rust: { command: "rust-analyzer", args: [] },
	go: { command: "gopls", args: [] },
};

/**
 * Python has two popular servers. We try the first; if it is not on
 * `PATH`, the lookup falls through to the second. Both speak LSP, so
 * the caller does not need to know which one was selected.
 */
const PYTHON_FALLBACKS: BuiltinServer[] = [
	{ command: "pylsp", args: [] },
	{ command: "pyright-langserver", args: ["--stdio"] },
];

/* -------------------------------------------------------------------------- */
/* Filesystem helpers                                                         */
/* -------------------------------------------------------------------------- */

const DEFAULT_BIN_EXT_WIN32 = ".cmd";
const DEFAULT_BIN_EXT_POSIX = "";

function defaultBinExt(platform: NodeJS.Platform = process.platform, explicit?: string): string {
	if (explicit !== undefined) return explicit;
	return platform === "win32" ? DEFAULT_BIN_EXT_WIN32 : DEFAULT_BIN_EXT_POSIX;
}

function isExecutable(path: string): boolean {
	try {
		const st = statSync(path);
		if (!st.isFile()) return false;
		// On POSIX, an executable bit check is cheap. On Windows,
		// `.cmd` / `.bat` files do not have a stable executable bit;
		// we just trust their existence.
		if (process.platform !== "win32") {
			try {
				// `mode` exists on Unix file systems; 0o111 marks the
				// execute bits. We accept any of user / group / other.
				// Skip the check on platforms where `statSync` does
				// not surface `mode` — falling through to "exists"
				// is fine for the dev-only test path.
				const mode = (st as { mode?: unknown }).mode;
				if (typeof mode === "number" && (mode & 0o111) === 0) return false;
			} catch {
				// ignore
			}
		}
		return true;
	} catch {
		return false;
	}
}

function pathDirs(pathEnv: string | undefined): string[] {
	const raw = pathEnv ?? process.env.PATH ?? "";
	if (!raw) return [];
	return raw.split(delimiter).filter((p) => p.length > 0);
}

/**
 * Look up a command on `PATH` (or in `<root>/node_modules/.bin`) and
 * return an absolute path if one is found, `undefined` otherwise.
 */
function findOnPath(
	command: string,
	worktree: string,
	pathEnv: string | undefined,
	binExt: string,
): string | undefined {
	const candidates: string[] = [];
	const localBin = join(worktree, "node_modules", ".bin", command);
	candidates.push(localBin + binExt);
	candidates.push(localBin);
	for (const dir of pathDirs(pathEnv)) {
		candidates.push(join(dir, command + binExt));
		candidates.push(join(dir, command));
	}
	for (const candidate of candidates) {
		if (isExecutable(candidate)) return candidate;
	}
	return undefined;
}

/* -------------------------------------------------------------------------- */
/* Override file parsing                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Read the optional `.theta/lsp.json` override file from `worktree`.
 * Returns `undefined` when the file is missing, unreadable, or
 * malformed; the caller falls back to the built-in table.
 */
export function readLspOverrideFile(worktree: string): LspOverrideFile | undefined {
	const overridePath = join(worktree, ".theta", "lsp.json");
	if (!existsSync(overridePath)) return undefined;
	let raw: string;
	try {
		raw = readFileSync(overridePath, "utf-8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}
	return parsed as LspOverrideFile;
}

/**
 * Pull a single language entry out of the override map, validating
 * the per-language shape. Returns `undefined` for malformed entries
 * so the resolver can fall back to the built-in table.
 */
export function validateOverrideEntry(
	entry: unknown,
):
	| { command: string; args?: string[]; initializationOptions?: Record<string, unknown>; env?: Record<string, string> }
	| undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const obj = entry as Record<string, unknown>;
	const command = obj.command;
	if (typeof command !== "string" || command.length === 0) return undefined;
	const argsRaw = obj.args;
	let args: string[] | undefined;
	if (argsRaw !== undefined) {
		if (!Array.isArray(argsRaw)) return undefined;
		const collected: string[] = [];
		for (const a of argsRaw) {
			if (typeof a !== "string") return undefined;
			collected.push(a);
		}
		args = collected;
	}
	const initRaw = obj.initializationOptions;
	let initializationOptions: Record<string, unknown> | undefined;
	if (initRaw !== undefined) {
		if (typeof initRaw !== "object" || initRaw === null || Array.isArray(initRaw)) return undefined;
		initializationOptions = initRaw as Record<string, unknown>;
	}
	const envRaw = obj.env;
	let env: Record<string, string> | undefined;
	if (envRaw !== undefined) {
		if (typeof envRaw !== "object" || envRaw === null || Array.isArray(envRaw)) return undefined;
		const collected: Record<string, string> = {};
		for (const [k, v] of Object.entries(envRaw as Record<string, unknown>)) {
			if (typeof v !== "string") return undefined;
			collected[k] = v;
		}
		env = collected;
	}
	return {
		command,
		...(args ? { args } : {}),
		...(initializationOptions ? { initializationOptions } : {}),
		...(env ? { env } : {}),
	};
}

/* -------------------------------------------------------------------------- */
/* Public resolver                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a language server command for the given worktree and
 * language. Returns `undefined` when no server is on `PATH` and no
 * override exists; the caller (the LSP manager) then either picks an
 * in-process fallback (for TypeScript) or surfaces a
 * `certainty: "unknown"` to the audit.
 *
 * The `allowTypescriptFallback` option does not change the value
 * returned; it is a hint passed through to callers that build a
 * typed language service. The function returns the spawned server
 * when one is found, `undefined` otherwise.
 */
export function resolveLspServer(options: ResolveLspServerOptions): LspServerCommand | undefined {
	const { worktree, language, pathEnv, allowTypescriptFallback: _allowTypescriptFallback } = options;
	const binExt = defaultBinExt(process.platform, options.binExt);

	// (1) Per-worktree override wins.
	const overrides = readLspOverrideFile(worktree);
	if (overrides) {
		const entry = overrides[language];
		if (entry !== undefined) {
			const validated = validateOverrideEntry(entry);
			if (validated) {
				const resolved = findOnPath(validated.command, worktree, pathEnv, binExt);
				if (resolved) {
					return {
						command: resolved,
						args: validated.args ?? [],
						...(validated.initializationOptions
							? { initializationOptions: validated.initializationOptions }
							: {}),
						...(validated.env ? { env: validated.env } : {}),
					};
				}
				// Override present but command not on PATH. Treat as
				// "user wanted this exact command"; preserve it so the
				// spawn error tells the user what's missing.
				return {
					command: validated.command,
					args: validated.args ?? [],
					...(validated.initializationOptions ? { initializationOptions: validated.initializationOptions } : {}),
					...(validated.env ? { env: validated.env } : {}),
				};
			}
		}
	}

	// (2) Built-in command, on `PATH` or local `node_modules/.bin`.
	if (language === "python") {
		for (const fallback of PYTHON_FALLBACKS) {
			const resolved = findOnPath(fallback.command, worktree, pathEnv, binExt);
			if (resolved) {
				return { command: resolved, args: [...fallback.args] };
			}
		}
		return undefined;
	}

	const builtin = BUILTIN_SERVERS[language];
	const resolved = findOnPath(builtin.command, worktree, pathEnv, binExt);
	if (resolved) {
		return { command: resolved, args: [...builtin.args] };
	}
	return undefined;
}

/* -------------------------------------------------------------------------- */
/* Fallback signal                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Returns `true` when the language has a working in-process
 * fallback the adapter can use without spawning a server. Today
 * only TypeScript qualifies (via the `TypeScriptLanguageServiceAdapter`).
 * Other languages return `false` — the adapter must report
 * `certainty: "unknown"` to the audit.
 */
export function hasInProcessFallback(language: LspLanguage): boolean {
	return language === "typescript" || language === "javascript";
}

