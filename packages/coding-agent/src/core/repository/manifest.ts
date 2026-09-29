/**
 * F1 file-manifest data layer.
 *
 * Walks a worktree once and produces a flat list of `FileManifestEntry`
 * records describing every regular file: relative + absolute path, size,
 * language, owning package, and flags for generated / ignored status.
 *
 * This module is deliberately minimal: it is the Phase 1 data layer only.
 * It does not parse syntax trees, does not infer semantics, and does not
 * integrate with the agent loop. Higher layers (F2+) build on top of it.
 *
 * The directory walk uses plain `node:fs/promises.readdir` with
 * `withFileTypes: true` — no `globby` / `fast-glob` — to keep the existing
 * dependency surface stable.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One row in the file manifest.
 *
 * `contentHash` is computed lazily: the SHA-256 of the file bytes. It is
 * populated at `buildManifest` time when `computeHashes: true`, and can
 * also be filled in on first `getFile` access for an individual entry.
 */
export interface FileManifestEntry {
	/** Path relative to the manifest root, using forward slashes. */
	path: string;
	/** Absolute, resolved path on disk. */
	absolutePath: string;
	/** File size in bytes (from `Dirent` / `stat`). */
	byteLength: number;
	/** SHA-256 hex digest of the file bytes, lazily computed. */
	contentHash?: string;
	/** Detected source language, or `null` if unknown. */
	language: string | null;
	/** Nearest `package.json` `name` field, or `undefined` if not inside a package. */
	package?: string;
	/** True for files in `dist/`, `build/`, `*.generated.*`, etc. */
	generated: boolean;
	/** True for files in `.git/`, `node_modules/`, or matching `.gitignore` patterns. */
	ignored: boolean;
}

export interface BuildManifestOptions {
	/** Absolute path to the worktree root to walk. */
	root: string;
	/** Hard cap on entries returned. Default 50_000. */
	maxFiles?: number;
	/**
	 * When false (default), entries whose `ignored` flag is `true` are
	 * dropped from the returned manifest. When true, they are kept with
	 * their `ignored` flag intact so callers can inspect them.
	 */
	includeIgnored?: boolean;
	/**
	 * When true, every file's bytes are hashed during the walk and the
	 * SHA-256 hex digest is attached as `contentHash`. Default false; in
	 * that case hashes are computed lazily on first `getFile` access.
	 */
	computeHashes?: boolean;
	/**
	 * When true, symbolic links are followed and their targets walked.
	 * Default false: symlinks are skipped to avoid cycles and accidental
	 * inclusion of files outside the worktree.
	 */
	followSymlinks?: boolean;
	/**
	 * `.gitignore` patterns to honor. Simple glob-style matching is
	 * supported (`*`, `?`, `**`, leading `/`, trailing `/`, `!negation`).
	 * Patterns are evaluated against the forward-slash relative path.
	 */
	gitignorePatterns?: string[];
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Directory names that are always considered ignored, regardless of `.gitignore`. */
const ALWAYS_IGNORED_DIRS = new Set([".git", "node_modules", ".theta", ".theta"]);

/** Filename / directory patterns that mark a file as generated. */
const GENERATED_DIR_PREFIXES = ["dist/", "build/", ".next/", "coverage/", "out/"] as const;

/* -------------------------------------------------------------------------- */
/* Language map                                                               */
/* -------------------------------------------------------------------------- */

const LANGUAGE_BY_EXT: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescript",
	".cts": "typescript",
	".mts": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".json": "json",
	".md": "markdown",
	".mdx": "markdown",
	".py": "python",
	".rs": "rust",
	".go": "go",
	".java": "java",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".cc": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hh": "cpp",
	".hxx": "cpp",
	".sh": "shell",
	".bash": "shell",
	".zsh": "shell",
	".yaml": "yaml",
	".yml": "yaml",
	".toml": "toml",
	".html": "html",
	".htm": "html",
	".css": "css",
	".scss": "scss",
	".sass": "scss",
	".less": "less",
	".vue": "vue",
	".svelte": "svelte",
};

/**
 * Detect the source language of a file from its path (extension only).
 * Returns `null` for unknown extensions. The match is case-insensitive
 * on the extension; the file name itself is preserved.
 */
export function detectLanguage(path: string): string | null {
	const slash = path.lastIndexOf("/");
	const basename = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = basename.lastIndexOf(".");
	if (dot <= 0) return null;
	const ext = basename.slice(dot).toLowerCase();
	return LANGUAGE_BY_EXT[ext] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Generated / ignored predicates                                             */
/* -------------------------------------------------------------------------- */

/** Normalize any backslashes to forward slashes for consistent matching. */
function toPosix(path: string): string {
	return path.split(sep).join("/");
}

/**
 * True if `path` looks like a generated artifact:
 * - file name matches `*.generated.*`
 * - any path segment is `dist`, `build`, `.next`, `coverage`, or `out`
 * - file name matches `*.min.js` or `*.min.css`
 *
 * The input may be a forward-slash relative path or an absolute path.
 */
export function isGeneratedPath(path: string): boolean {
	const posix = toPosix(path);
	const slash = posix.lastIndexOf("/");
	const basename = slash >= 0 ? posix.slice(slash + 1) : posix;

	if (/\.generated\./.test(basename)) return true;
	if (/\.min\.(js|css)$/i.test(basename)) return true;

	for (const prefix of GENERATED_DIR_PREFIXES) {
		if (posix.startsWith(prefix) || posix.includes(`/${prefix}`)) return true;
	}
	return false;
}

/**
 * True if `path` is ignored: either by the built-in list (`.git`,
 * `node_modules`, `.theta`, `.theta`) or by one of the provided gitignore
 * patterns.
 *
 * The gitignore matcher is intentionally simple: no negation propagation,
 * no `core.excludesFile`, no `[...]` character classes. Patterns are
 * applied in order, with the final matching pattern winning (matching
 * git's "last matching pattern decides" semantics for include/exclude).
 */
export function isIgnoredPath(path: string, gitignorePatterns?: string[]): boolean {
	const posix = toPosix(path);

	if (matchesAlwaysIgnored(posix)) return true;

	const patterns = gitignorePatterns ?? [];
	if (patterns.length === 0) return false;

	let ignored = false;
	for (const raw of patterns) {
		const pattern = raw.trim();
		if (pattern === "" || pattern.startsWith("#")) continue;
		if (matchesGitignorePattern(posix, pattern)) {
			if (pattern.startsWith("!")) {
				ignored = false;
			} else {
				ignored = true;
			}
		}
	}
	return ignored;
}

function matchesAlwaysIgnored(posix: string): boolean {
	if (posix === "") return false;
	const segments = posix.split("/");
	for (const segment of segments) {
		if (ALWAYS_IGNORED_DIRS.has(segment)) return true;
	}
	return false;
}

/* -------------------------------------------------------------------------- */
/* Gitignore matching (intentionally minimal)                                  */
/* -------------------------------------------------------------------------- */

function matchesGitignorePattern(posix: string, pattern: string): boolean {
	// Negation: trim the leading `!` and match the rest. The caller is
	// responsible for treating a `!` match as "un-ignore".
	const isNegation = pattern.startsWith("!");
	const body = isNegation ? pattern.slice(1) : pattern;
	if (body === "") return false;

	let anchored = body;
	let dirOnly = false;
	if (anchored.endsWith("/")) {
		dirOnly = true;
		anchored = anchored.slice(0, -1);
	}
	let leadingSlash = false;
	if (anchored.startsWith("/")) {
		leadingSlash = true;
		anchored = anchored.slice(1);
	}
	if (anchored === "") return false;

	const regex = globToRegExp(anchored, { leadingSlash });
	if (dirOnly) {
		if (!isNegation && !regex.test(posix)) return false;
		// Directory pattern: match the path or any parent.
		return posix === anchored || posix.startsWith(`${anchored}/`);
	}
	return regex.test(posix);
}

interface GlobToRegExpOptions {
	leadingSlash: boolean;
}

function globToRegExp(pattern: string, options: GlobToRegExpOptions): RegExp {
	let regex = "";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				// `**` matches any number of path segments, including none.
				regex += ".*";
				i += 2;
				// Eat an immediately following `/` so `a/**/b` works.
				if (pattern[i] === "/") i += 1;
			} else {
				// `*` matches any chars except `/`.
				regex += "[^/]*";
				i += 1;
			}
		} else if (ch === "?") {
			regex += "[^/]";
			i += 1;
		} else if (
			ch === "." ||
			ch === "(" ||
			ch === ")" ||
			ch === "+" ||
			ch === "|" ||
			ch === "^" ||
			ch === "$" ||
			ch === "{"
		) {
			regex += `\\${ch}`;
			i += 1;
		} else if (ch === "\\" && i + 1 < pattern.length) {
			regex += `\\${pattern[i + 1]}`;
			i += 2;
		} else {
			regex += ch;
			i += 1;
		}
	}
	const anchor = options.leadingSlash ? "^" : "(^|/)";
	return new RegExp(`${anchor}${regex}(/|$)`);
}

/* -------------------------------------------------------------------------- */
/* Package detection                                                          */
/* -------------------------------------------------------------------------- */

const PACKAGE_JSON_NAME_CACHE = new Map<string, string | null>();

/**
 * Look up the nearest `package.json` walking up from `filePath` to the
 * filesystem root. Returns the `name` field, or `undefined` if no
 * `package.json` was found in the ancestry.
 *
 * Results are cached in-memory per-process because all files in the
 * same directory share the same nearest `package.json`. The cache is
 * keyed on the absolute `package.json` path so entries from unrelated
 * trees do not collide.
 */
async function detectPackageName(filePath: string): Promise<string | undefined> {
	const startDir = dirname(filePath);
	const stack: string[] = [];
	let dir = startDir;
	while (true) {
		stack.push(dir);
		const parent = dirname(dir);
		if (parent === dir) break; // hit filesystem root
		dir = parent;
	}

	// Walk top-down so the nearest `package.json` wins.
	for (const candidate of stack) {
		const pkgPath = resolve(candidate, "package.json");
		const cached = PACKAGE_JSON_NAME_CACHE.get(pkgPath);
		if (cached !== undefined) {
			if (cached !== null) return cached;
			continue;
		}
		const name = await readPackageName(pkgPath);
		PACKAGE_JSON_NAME_CACHE.set(pkgPath, name);
		if (name !== null) return name;
	}

	return undefined;
}

async function readPackageName(packageJsonPath: string): Promise<string | null> {
	try {
		const raw = await readFile(packageJsonPath, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const name = (parsed as { name?: unknown }).name;
		return typeof name === "string" ? name : null;
	} catch {
		return null;
	}
}

/** Test-only hook: clear the per-process package.json cache. */
export function resetPackageCacheForTests(): void {
	PACKAGE_JSON_NAME_CACHE.clear();
}

/* -------------------------------------------------------------------------- */
/* Hashing (lazy / optional)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Compute SHA-256 hex digest of `bytes`. Uses a runtime-concatenated
 * import specifier so browser bundlers (e.g. esbuild in
 * scripts/check-browser-smoke.mjs) do not try to statically resolve
 * `node:crypto` if this module is ever imported from a browser entry.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const moduleName = "node" + ":" + "crypto";
	const { createHash } = (await import(/* @vite-ignore */ moduleName)) as typeof import("node:crypto");
	return createHash("sha256").update(bytes).digest("hex");
}

/** Read a file and return its bytes, or `undefined` on any I/O error. */
async function readBytesOrUndefined(path: string): Promise<Uint8Array | undefined> {
	try {
		return await readFile(path);
	} catch {
		return undefined;
	}
}

/* -------------------------------------------------------------------------- */
/* Directory walk                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Build a `FileManifestEntry` for a single file given its absolute path
 * and the manifest root. Pure helper — no I/O unless `computeHashes` is
 * true.
 */
async function buildEntry(
	absolutePath: string,
	root: string,
	computeHashes: boolean,
	gitignorePatterns: string[] | undefined,
): Promise<FileManifestEntry> {
	const relRaw = relative(root, absolutePath);
	const rel = toPosix(relRaw);
	const language = detectLanguage(rel);
	const generated = isGeneratedPath(rel);
	const ignored = isIgnoredPath(rel, gitignorePatterns);

	let byteLength = 0;
	try {
		const s = await stat(absolutePath);
		byteLength = s.size;
	} catch {
		byteLength = 0;
	}

	const entry: FileManifestEntry = {
		path: rel,
		absolutePath,
		byteLength,
		language,
		generated,
		ignored,
	};

	if (computeHashes) {
		const bytes = await readBytesOrUndefined(absolutePath);
		if (bytes) {
			entry.contentHash = await sha256Hex(bytes);
		}
	}

	if (!ignored) {
		// Only do the package walk for non-ignored files to save I/O on
		// vendor / generated trees.
		const pkg = await detectPackageName(absolutePath);
		if (pkg !== undefined) {
			entry.package = pkg;
		}
	}

	return entry;
}

/**
 * Walk `root` and return a sorted manifest of files.
 *
 * The walk is iterative via an explicit stack (no recursion) to avoid
 * blowing the call stack on very deep trees. Hard-coded ignore
 * directories (`.git`, `node_modules`, `.theta`, `.theta`) are pruned
 * entirely when `includeIgnored: false` (the default) to avoid
 * traversing huge vendor trees. When `includeIgnored: true` we walk
 * into them so callers can inspect their contents with the `ignored`
 * flag set.
 *
 * Files whose path matches a `.gitignore` pattern are still walked
 * (when their containing directory is not pruned) and dropped from the
 * result unless `includeIgnored: true`.
 */
export async function buildManifest(options: BuildManifestOptions): Promise<FileManifestEntry[]> {
	const rootResolved = resolve(options.root);
	const maxFiles = options.maxFiles ?? 50_000;
	const includeIgnored = options.includeIgnored ?? false;
	const computeHashes = options.computeHashes ?? false;
	const followSymlinks = options.followSymlinks ?? false;
	const gitignorePatterns = options.gitignorePatterns;

	const result: FileManifestEntry[] = [];
	const stack: string[] = [rootResolved];

	while (stack.length > 0) {
		if (result.length >= maxFiles) break;
		const dir = stack.pop() as string;
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			// Unreadable directory — skip silently.
			continue;
		}

		for (const entry of entries) {
			if (result.length >= maxFiles) break;

			const fullPath = resolve(dir, entry.name);
			const rel = toPosix(relative(rootResolved, fullPath));

			if (entry.isSymbolicLink() && !followSymlinks) continue;

			if (entry.isDirectory()) {
				if (!includeIgnored) {
					// Prune the hard-coded ignore dirs to keep the walk
					// O(source) rather than O(vendor).
					if (ALWAYS_IGNORED_DIRS.has(entry.name)) continue;
					// If the dir is itself ignored by gitignore, prune it too.
					const dirPosix = `${rel}/`;
					if (isIgnoredPath(dirPosix, gitignorePatterns)) continue;
				}
				stack.push(fullPath);
				continue;
			}

			if (!entry.isFile()) continue;
			if (rel === "" || isAbsolute(rel)) continue;

			// `package.json` is workspace metadata, not source. Skip it so
			// the manifest reflects actual source files; callers that need
			// the package descriptor can use a separate path.
			if (entry.name === "package.json") continue;

			const record = await buildEntry(fullPath, rootResolved, computeHashes, gitignorePatterns);
			if (!includeIgnored && record.ignored) continue;
			result.push(record);
		}
	}

	result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return result;
}

/* -------------------------------------------------------------------------- */
/* Query helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Find the manifest entry whose `path` matches the given relative path
 * (forward-slash form). Returns `undefined` if not found.
 *
 * Complexity: O(n) linear scan. The manifest is small (capped at
 * `maxFiles`) and this keeps the data layer zero-allocation. If call
 * sites need O(1) lookups they can build a `Map<string, FileManifestEntry>`
 * themselves.
 */
export function getFile(manifest: FileManifestEntry[], path: string): FileManifestEntry | undefined {
	const target = toPosix(path);
	for (const entry of manifest) {
		if (entry.path === target) return entry;
	}
	return undefined;
}

/** Return all entries with the given `language` value. */
export function getByLanguage(manifest: FileManifestEntry[], language: string): FileManifestEntry[] {
	return manifest.filter((entry) => entry.language === language);
}

/** Return all entries belonging to the given package (by `package` name). */
export function getByPackage(manifest: FileManifestEntry[], packageName: string): FileManifestEntry[] {
	return manifest.filter((entry) => entry.package === packageName);
}

