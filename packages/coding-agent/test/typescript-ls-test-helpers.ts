/**
 * Shared helpers for the typescript-ls adapter test suite.
 *
 * Each test sets up a small TypeScript project in a fresh temp
 * directory so the real `TypeScriptLanguageServiceAdapter` can be
 * exercised end-to-end against a real `ts.Program`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

/** Shape of a test project. */
export interface TsTestProject {
	/** Absolute path of the project root (worktree). */
	rootDir: string;
	/** Forward-slash relative path of the entry file under the root. */
	entry: string;
	/** The created `ts.Program`. */
	program: import("typescript").Program;
	/** Absolute path of the entry file. */
	entryAbs: string;
}

export interface TsTestFile {
	/** Forward-slash relative path under the project root. */
	path: string;
	/** File content. */
	content: string;
}

export interface CreateTestProjectOptions {
	files: TsTestFile[];
	/** Extra compiler options applied to the synthesized tsconfig. */
	compilerOptions?: Record<string, unknown>;
}

/**
 * Materialize a tiny TypeScript project on disk, write a tsconfig +
 * package.json, and return a `ts.Program` plus worktree.
 */
export async function createTestProject(options: CreateTestProjectOptions): Promise<TsTestProject> {
	const tsModule = await loadTs();
	const rootDir = mkdtempSync(join(tmpdir(), "ts-ls-test-"));
	mkdirSync(join(rootDir, "src"), { recursive: true });

	for (const file of options.files) {
		const abs = join(rootDir, file.path);
		const dir = abs.split(/[\\/]/).slice(0, -1).join(sep);
		mkdirSync(dir, { recursive: true });
		writeFileSync(abs, file.content, "utf-8");
	}

	// package.json so the adapter's worktree heuristic finds a root.
	writeFileSync(join(rootDir, "package.json"), JSON.stringify({ name: "ts-ls-test", version: "0.0.0" }), "utf-8");

	const entry = options.files[0]?.path ?? "src/index.ts";
	const entryAbs = join(rootDir, entry);

	const compilerOptions: Record<string, unknown> = {
		target: tsModule.ScriptTarget.ES2022,
		module: tsModule.ModuleKind.NodeNext,
		moduleResolution: tsModule.ModuleResolutionKind.NodeNext,
		strict: true,
		skipLibCheck: true,
		esModuleInterop: true,
		noEmit: true,
		...options.compilerOptions,
	};

	const program = tsModule.createProgram({
		rootNames: options.files.map((f) => join(rootDir, f.path)),
		options: compilerOptions as never,
	});

	return { rootDir, entry, program, entryAbs };
}

/** Recursively delete a directory. Best-effort; ignores errors. */
export function removeProject(rootDir: string): void {
	try {
		rmSync(rootDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

/* -------------------------------------------------------------------------- */
/* Lazy typescript loader (mirror of the adapter's loader so tests can use   */
/* the same indirection).                                                     */
/* -------------------------------------------------------------------------- */

let cached: typeof import("typescript") | undefined;

async function loadTs(): Promise<typeof import("typescript")> {
	if (!cached) {
		const moduleName = "type" + "script";
		cached = (await import(moduleName)) as typeof import("typescript");
	}
	return cached;
}

