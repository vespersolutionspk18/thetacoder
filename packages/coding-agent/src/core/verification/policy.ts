/**
 * Policy loader and resolver.
 *
 * The audit calls for a deterministic, file-driven verification
 * policy. The loader accepts a hierarchy of inputs and returns a
 * fully-defaulted `VerificationPolicy`:
 *
 *   1. `.theta/verification.json` in the worktree (explicit file).
 *   2. `theta.verification` block in the worktree's nearest
 *      `package.json` (per-package override).
 *   3. The default resolver, which inspects the worktree's shape
 *      (package.json, vitest.config.*, biome.json, eslint.config.*,
 *      tsconfig.json, …) and produces a sensible baseline.
 *
 * The loader is pure: it returns a policy object, never mutates
 * the filesystem, and never spawns a process. It only reads files
 * that already exist. Tests pass a custom `PolicyLoadInputs` to
 * skip the filesystem entirely.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { VerificationCheck, VerificationParserId, VerificationPolicy, VerificationPolicySource } from "./types.ts";

// ============================================================================
// File format (the JSON schema the policy file uses)
// ============================================================================

/**
 * The shape the policy JSON file or `theta.verification` package.json
 * block must conform to. Every field is optional — the loader fills
 * in defaults. A check is just a `VerificationCheck` with parser
 * optional (we infer from `kind` when absent).
 */
export interface PolicyFileCheck {
	id?: string;
	kind?: VerificationCheck["kind"];
	command?: string;
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	parser?: VerificationParserId;
	blocking?: boolean;
	trigger?: VerificationCheck["trigger"];
	description?: string;
}

export interface PolicyFileFormat {
	version?: number;
	concurrency?: number;
	timeoutMs?: number;
	logDir?: string;
	enabled?: boolean;
	runOnEveryTurn?: boolean;
	checks?: PolicyFileCheck[];
}

// ============================================================================
// Inputs the loader accepts
// ============================================================================

export interface PolicyLoadInputs {
	/** Worktree root for filesystem lookups. */
	worktreeRoot: string;
	/**
	 * Explicit policy file path. When set, the loader reads this
	 * file regardless of whether `.theta/verification.json` exists.
	 */
	explicitPath?: string;
	/**
	 * Optional override of the worktree's `package.json` contents.
	 * When `undefined`, the loader reads the nearest `package.json`.
	 */
	packageJson?: PackageJsonShape;
	/**
	 * Optional override of the default-resolver inputs. When
	 * `undefined`, the loader inspects the worktree via `existsSync`.
	 */
	defaultInputs?: DefaultResolverInputs;
	/**
	 * Master switch from `SettingsManager`. When `false`, the
	 * loader short-circuits and returns a disabled policy.
	 */
	enabled?: boolean;
	/**
	 * `runOnEveryTurn` override from `SettingsManager`. The
	 * default resolver inherits this; the file-based loader
	 * reads it from the file (the explicit setting wins).
	 */
	runOnEveryTurn?: boolean;
}

export interface PackageJsonShape {
	theta?: {
		verification?: PolicyFileFormat;
	};
	[key: string]: unknown;
}

export interface DefaultResolverInputs {
	hasTypeScript: boolean;
	hasVitest: boolean;
	hasJest: boolean;
	hasMocha: boolean;
	hasPytest: boolean;
	hasBiome: boolean;
	hasEslint: boolean;
	hasTscBinary: boolean;
	hasTestScript: boolean;
	hasLintScript: boolean;
	hasTypecheckScript: boolean;
	hasBuildScript: boolean;
}

// ============================================================================
// Loaders
// ============================================================================

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_LOG_DIR = ".theta/verification";
const MAX_CONCURRENCY = 16;

/**
 * Read the policy. Walks the three-tier hierarchy in order and
 * returns the first hit; falls back to the project-shape default
 * when no input is found.
 */
export function loadVerificationPolicy(inputs: PolicyLoadInputs): VerificationPolicy {
	// Disabled override wins over every tier.
	if (inputs.enabled === false) {
		return {
			version: 1,
			concurrency: DEFAULT_CONCURRENCY,
			timeoutMs: DEFAULT_TIMEOUT_MS,
			logDir: DEFAULT_LOG_DIR,
			enabled: false,
			runOnEveryTurn: inputs.runOnEveryTurn ?? false,
			checks: [],
			source: { kind: "default", reason: "verification.enabled = false" },
		};
	}

	// Tier 1: explicit policy file.
	if (inputs.explicitPath) {
		const explicit = readPolicyFile(inputs.explicitPath, inputs.worktreeRoot);
		if (explicit) {
			return finalize(explicit.policy, { kind: "explicit-file", path: explicit.path }, inputs);
		}
	}

	// Tier 1b: `.theta/verification.json` in the worktree.
	const defaultFile = join(inputs.worktreeRoot, ".theta", "verification.json");
	const fromFile = readPolicyFile(defaultFile, inputs.worktreeRoot);
	if (fromFile) {
		return finalize(fromFile.policy, { kind: "explicit-file", path: fromFile.path }, inputs);
	}

	// Tier 2: per-package override in `package.json`.
	const pkg = inputs.packageJson ?? readPackageJson(inputs.worktreeRoot);
	if (pkg?.theta?.verification) {
		return finalize(
			pkg.theta.verification,
			{ kind: "package-json", path: join(inputs.worktreeRoot, "package.json") },
			inputs,
		);
	}

	// Tier 3: shape-based default.
	const defaultInputs = inputs.defaultInputs ?? detectDefaultInputs(inputs.worktreeRoot);
	const defaultPolicy = buildDefaultPolicy(defaultInputs);
	return finalize(defaultPolicy, { kind: "default", reason: "no policy file present" }, inputs);
}

// ============================================================================
// Internal helpers
// ============================================================================

function readPolicyFile(path: string, _worktreeRoot: string): { policy: PolicyFileFormat; path: string } | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return undefined;
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content) as PolicyFileFormat;
		return { policy: parsed, path };
	} catch {
		return undefined;
	}
}

function readPackageJson(worktreeRoot: string): PackageJsonShape | undefined {
	const path = join(worktreeRoot, "package.json");
	if (!existsSync(path)) return undefined;
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return undefined;
		const content = readFileSync(path, "utf-8");
		return JSON.parse(content) as PackageJsonShape;
	} catch {
		return undefined;
	}
}

function clampConcurrency(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CONCURRENCY;
	const floored = Math.floor(value);
	if (floored < 1) return 1;
	if (floored > MAX_CONCURRENCY) return MAX_CONCURRENCY;
	return floored;
}

function clampTimeoutMs(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
	const floored = Math.floor(value);
	if (floored < 1_000) return 1_000;
	return floored;
}

/** Map a `kind` to a default parser when the policy file omits one. */
function defaultParserForKind(kind: VerificationCheck["kind"]): VerificationParserId {
	switch (kind) {
		case "test":
			return "vitest";
		case "lint":
			return "biome";
		case "typecheck":
			return "tsc";
		case "snapshot":
		case "manual":
		case "user-accepted":
			return "raw";
	}
}

/**
 * Normalize a single check. The policy file allows some fields to be
 * omitted; this fills them in and returns a fully-formed
 * `VerificationCheck` or `null` when the check is unrunnable.
 */
function normalizeCheck(raw: PolicyFileCheck, index: number): VerificationCheck | null {
	if (!raw || typeof raw !== "object") return null;
	const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : `check-${index}`;
	const kind = raw.kind ?? "test";
	const command = typeof raw.command === "string" ? raw.command : null;
	if (!command) return null;
	const parser = raw.parser ?? defaultParserForKind(kind);
	return {
		id,
		kind,
		command,
		cwd: typeof raw.cwd === "string" && raw.cwd.length > 0 ? raw.cwd : undefined,
		env: raw.env && typeof raw.env === "object" ? { ...raw.env } : undefined,
		timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : undefined,
		parser,
		blocking: raw.blocking ?? true,
		trigger: raw.trigger ?? "on-demand",
		description: typeof raw.description === "string" ? raw.description : undefined,
	};
}

function finalize(
	raw: PolicyFileFormat,
	source: VerificationPolicySource,
	inputs: PolicyLoadInputs,
): VerificationPolicy {
	const checks: VerificationCheck[] = [];
	const rawChecks = Array.isArray(raw.checks) ? raw.checks : [];
	for (let i = 0; i < rawChecks.length; i++) {
		const c = normalizeCheck(rawChecks[i] as PolicyFileCheck, i);
		if (c) checks.push(c);
	}

	return {
		version: 1,
		concurrency: clampConcurrency(raw.concurrency),
		timeoutMs: clampTimeoutMs(raw.timeoutMs),
		logDir: typeof raw.logDir === "string" && raw.logDir.length > 0 ? raw.logDir : DEFAULT_LOG_DIR,
		enabled: raw.enabled ?? true,
		runOnEveryTurn: raw.runOnEveryTurn ?? inputs.runOnEveryTurn ?? false,
		checks,
		source,
	};
}

// ============================================================================
// Default resolver
// ============================================================================

/**
 * Inspect the worktree and return the inputs the default resolver
 * needs. Tests can pre-build a `DefaultResolverInputs` and skip
 * the filesystem walk.
 */
export function detectDefaultInputs(worktreeRoot: string): DefaultResolverInputs {
	const pkg = readPackageJson(worktreeRoot);
	const scripts =
		(pkg && typeof pkg === "object" && "scripts" in pkg && typeof pkg.scripts === "object"
			? (pkg.scripts as Record<string, unknown>)
			: null) ?? null;

	return {
		hasTypeScript:
			existsSync(join(worktreeRoot, "tsconfig.json")) || existsSync(join(worktreeRoot, "tsconfig.base.json")),
		hasVitest:
			existsSync(join(worktreeRoot, "vitest.config.ts")) ||
			existsSync(join(worktreeRoot, "vitest.config.js")) ||
			existsSync(join(worktreeRoot, "vitest.config.mjs")),
		hasJest: existsSync(join(worktreeRoot, "jest.config.ts")) || existsSync(join(worktreeRoot, "jest.config.js")),
		hasMocha: existsSync(join(worktreeRoot, ".mocharc.cjs")) || existsSync(join(worktreeRoot, ".mocharc.json")),
		hasPytest:
			existsSync(join(worktreeRoot, "pytest.ini")) ||
			existsSync(join(worktreeRoot, "pyproject.toml")) ||
			existsSync(join(worktreeRoot, "conftest.py")),
		hasBiome: existsSync(join(worktreeRoot, "biome.json")) || existsSync(join(worktreeRoot, "biome.jsonc")),
		hasEslint:
			existsSync(join(worktreeRoot, ".eslintrc.json")) ||
			existsSync(join(worktreeRoot, ".eslintrc.js")) ||
			existsSync(join(worktreeRoot, "eslint.config.js")) ||
			existsSync(join(worktreeRoot, "eslint.config.mjs")),
		hasTscBinary: existsSync(
			join(worktreeRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc"),
		),
		hasTestScript: typeof scripts?.test === "string",
		hasLintScript: typeof scripts?.lint === "string",
		hasTypecheckScript: typeof scripts?.typecheck === "string" || typeof scripts?.["type-check"] === "string",
		hasBuildScript: typeof scripts?.build === "string",
	};
}

/**
 * Build the default policy from the worktree shape. Conservative:
 * only adds a check when the corresponding tool actually exists.
 * A TypeScript repo with no `tsc` binary still gets the typecheck
 * check (it just produces a `tsc: not found` error which the gate
 * surfaces — that is exactly the audit's "exit 0 not trusted" intent).
 */
export function buildDefaultPolicy(inputs: DefaultResolverInputs): PolicyFileFormat {
	const checks: NonNullable<PolicyFileFormat["checks"]> = [];

	if (inputs.hasTypeScript) {
		checks.push({
			id: "tsc-noEmit",
			kind: "typecheck",
			command: "npx -y tsc --noEmit",
			parser: "tsc",
			blocking: true,
			trigger: "on-demand",
			description: "TypeScript noEmit typecheck (audit default)",
		});
	}

	if (inputs.hasVitest) {
		checks.push({
			id: "vitest-run",
			kind: "test",
			command: "npx -y vitest run",
			parser: "vitest",
			blocking: true,
			trigger: "on-demand",
			description: "Run vitest once (no watch)",
		});
	} else if (inputs.hasJest) {
		checks.push({
			id: "jest-run",
			kind: "test",
			command: "npx -y jest --runInBand",
			parser: "jest",
			blocking: true,
			trigger: "on-demand",
			description: "Run jest once (banded)",
		});
	} else if (inputs.hasMocha) {
		checks.push({
			id: "mocha-run",
			kind: "test",
			command: "npx -y mocha",
			parser: "mocha",
			blocking: true,
			trigger: "on-demand",
			description: "Run mocha once",
		});
	} else if (inputs.hasPytest) {
		checks.push({
			id: "pytest-run",
			kind: "test",
			command: "pytest -q",
			parser: "pytest",
			blocking: true,
			trigger: "on-demand",
			description: "Run pytest once (quiet)",
		});
	} else if (inputs.hasTestScript) {
		checks.push({
			id: "npm-test",
			kind: "test",
			command: "npm test -- --watch=false",
			parser: "raw",
			blocking: true,
			trigger: "on-demand",
			description: "Run npm test (no watch)",
		});
	}

	if (inputs.hasBiome) {
		checks.push({
			id: "biome-check",
			kind: "lint",
			command: "npx -y @biomejs/biome check",
			parser: "biome",
			blocking: false,
			trigger: "on-demand",
			description: "Biome check (errors only block)",
		});
	} else if (inputs.hasEslint) {
		checks.push({
			id: "eslint-run",
			kind: "lint",
			command: "npx -y eslint .",
			parser: "eslint",
			blocking: false,
			trigger: "on-demand",
			description: "ESLint over the worktree (errors only block)",
		});
	} else if (inputs.hasLintScript) {
		checks.push({
			id: "npm-lint",
			kind: "lint",
			command: "npm run lint",
			parser: "raw",
			blocking: false,
			trigger: "on-demand",
			description: "Run npm run lint",
		});
	}

	return {
		version: 1,
		concurrency: DEFAULT_CONCURRENCY,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		logDir: DEFAULT_LOG_DIR,
		enabled: true,
		runOnEveryTurn: false,
		checks,
	};
}

// ============================================================================
// Convenience: resolve a worktree-relative path
// ============================================================================

/**
 * Resolve `cwd` for a check. The check's `cwd` is interpreted as
 * relative to the worktree root; an absolute path is used as-is.
 * Exported so the runner can reuse the same rules.
 */
export function resolveCheckCwd(check: VerificationCheck, worktreeRoot: string): string {
	const raw = check.cwd;
	if (!raw) return worktreeRoot;
	if (isAbsolute(raw)) return resolve(raw);
	return resolve(worktreeRoot, raw);
}

/** Coarse-grained helper for log file names: makes a path safe and short. */
export function safeCheckIdForLog(id: string): string {
	return id.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64) || "check";
}

// Silence unused-import warnings for utility functions kept for
// future use (the runner re-uses `safeCheckIdForLog`).
void relative;
void sep;
void dirname;

