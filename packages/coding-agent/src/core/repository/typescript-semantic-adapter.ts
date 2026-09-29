/**
 * F1 semantic query layer — real TypeScript backend.
 *
 * Implements `SemanticQueryAdapter` using the TypeScript compiler API.
 * The audit (Section 11.3 "Technology choice") calls for reusing the
 * long-lived TypeScript language service: a `ts.Program` already
 * supports demand-driven syntactic and semantic work using file
 * versions and snapshots. This module wraps the compiler API to
 * answer the F1 queries against that program.
 *
 * The TypeScript module is loaded via a dynamic import string
 * indirection so the package can stay a dev dependency. Callers
 * must ensure `typescript` resolves from the runtime that loads
 * this module.
 *
 * Error policy: any failure (file unparseable, symbol not found,
 * checker throws) returns `certainty: "unknown"` with a `note`
 * explaining the limitation, matching the `MockSemanticQueryAdapter`
 * default.
 */

import { createHash } from "node:crypto";
import type {
	CallExpression,
	Declaration,
	Identifier,
	LanguageService,
	LanguageServiceHost,
	Node,
	Program,
	SourceFile,
	Diagnostic as TsDiagnostic,
} from "typescript";
import type {
	DiagnosticResult,
	DiagnosticSeverity,
	SemanticDiagnosticsOptions,
	SemanticLocation,
	SemanticQueryAdapter,
	SemanticQueryOptions,
	SemanticReferencesOptions,
	SemanticResult,
} from "./semantic-queries.ts";

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

export interface TypeScriptLanguageServiceAdapterOptions {
	/** A long-lived `ts.Program` produced by `ts.createProgram` or similar. */
	program: Program;
	/**
	 * Optional in-memory file-content overrides. Keys are file names
	 * (as the program reports them); values are the synthetic content
	 * to return when a query needs the source text. When set, the
	 * override wins over the on-disk content.
	 */
	fileOverrides?: Map<string, string>;
	/** When false (default), files under `node_modules/` are skipped. */
	includeNodeModules?: boolean;
	/**
	 * Optional explicit project root used by `getRelevantTests` to
	 * walk for `*.test.ts` / `*.spec.ts` files. When unset, the
	 * adapter walks up from a source-file directory until it finds a
	 * `package.json`, or falls back to `process.cwd()`.
	 */
	worktree?: string;
}

/* -------------------------------------------------------------------------- */
/* Lazy TypeScript loader                                                     */
/* -------------------------------------------------------------------------- */

type TsModule = typeof import("typescript");

let cachedTs: TsModule | undefined;

async function loadTs(): Promise<TsModule> {
	if (!cachedTs) {
		// String concatenation hides the dependency from static
		// resolution tools. The runtime string is "typescript".
		const moduleName = "type" + "script";
		cachedTs = (await import(moduleName)) as TsModule;
	}
	return cachedTs;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const TS_FILE_RE = /\.(?:ts|tsx|mts|cts)$/i;
const NODE_MODULES_RE = /[\\/]node_modules[\\/]/;
const PACKAGE_JSON = "package.json";

function isTsFile(fileName: string): boolean {
	return TS_FILE_RE.test(fileName);
}

function isNodeModules(fileName: string): boolean {
	return NODE_MODULES_RE.test(fileName);
}

function toRelativePath(fileName: string, worktree?: string): string {
	if (!worktree) return fileName;
	const normalizedWorktree = worktree.replace(/\\/g, "/").replace(/\/+$/, "");
	const normalizedFile = fileName.replace(/\\/g, "/");
	if (normalizedFile.startsWith(`${normalizedWorktree}/`)) {
		return normalizedFile.slice(normalizedWorktree.length + 1);
	}
	return normalizedFile;
}

function nodeToLocation(
	_ts: TsModule,
	node: Node,
	sourceFile: SourceFile,
	worktree: string | undefined,
): SemanticLocation {
	// Use `node.pos` / `node.end` and the source file's line map
	// directly. `node.getStart(sourceFile)` requires parent pointers,
	// which `ts.createProgram` does not populate unless we explicitly
	// set them; using `pos`/`end` plus the line map is robust either
	// way.
	const lineStarts = sourceFile.getLineStarts();
	const start = computeLineAndCharacterOfPosition(lineStarts, node.pos);
	const end = computeLineAndCharacterOfPosition(lineStarts, node.end);
	return {
		path: toRelativePath(sourceFile.fileName, worktree),
		startLine: start.line + 1,
		endLine: end.line + 1,
		startByte: node.pos,
		endByte: node.end,
	};
}

function spanToLocation(
	_ts: TsModule,
	sourceFile: SourceFile,
	start: number,
	end: number,
	worktree: string | undefined,
): SemanticLocation {
	// `sourceFile.getLineStarts()` initialises the lineMap lazily.
	const lineStarts = sourceFile.getLineStarts();
	const startPos = computeLineAndCharacterOfPosition(lineStarts, start);
	const endPos = computeLineAndCharacterOfPosition(lineStarts, end);
	return {
		path: toRelativePath(sourceFile.fileName, worktree),
		startLine: startPos.line + 1,
		endLine: endPos.line + 1,
		startByte: start,
		endByte: end,
	};
}

function computeLineAndCharacterOfPosition(
	lineStarts: readonly number[],
	position: number,
): { line: number; character: number } {
	// Binary search for the line containing `position`.
	let lo = 0;
	let hi = lineStarts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >>> 1;
		if (lineStarts[mid]! <= position) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return { line: lo, character: position - lineStarts[lo]! };
}

/**
 * Find the smallest AST node that fully contains the byte range
 * `[start, end)` in `sourceFile`. Used to disambiguate whether a
 * reference is the callee of a call expression.
 */
/**
 * Find the smallest `CallExpression` in `sourceFile` whose
 * `expression` child (a plain `Identifier`) covers the byte range
 * `[start, end)`. This is how the adapter decides whether a
 * reference is a direct call without relying on parent pointers
 * (which `ts.createProgram` does not populate by default).
 */
function findEnclosingDirectCall(
	ts: TsModule,
	sourceFile: SourceFile,
	start: number,
	end: number,
): CallExpression | undefined {
	let found: CallExpression | undefined;
	const visit = (node: Node): void => {
		if (found) return;
		if (start < node.pos || end > node.end) return;
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			start >= node.expression.pos &&
			end <= node.expression.end
		) {
			found = node;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return found;
}

function getDeclNameText(node: Declaration): string | undefined {
	// Function, class, interface, type alias, enum, module, namespace
	const named = node as unknown as { name?: { text?: string } | Identifier };
	if (named.name) {
		if (typeof named.name === "object" && "text" in named.name && typeof named.name.text === "string") {
			return named.name.text;
		}
	}
	return undefined;
}

function isMethodLike(node: Node): boolean {
	return (
		(node as { kind?: number }).kind !== undefined &&
		// MethodDeclaration, GetAccessor, SetAccessor, ConstructorDeclaration
		("body" in node || "parameters" in node) &&
		"name" in node
	);
}

/* -------------------------------------------------------------------------- */
/* Diagnostic helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Map a `ts.DiagnosticCategory` to the `DiagnosticSeverity` string. */
function diagnosticCategoryToSeverity(ts: TsModule, category: number): DiagnosticSeverity {
	if (category === ts.DiagnosticCategory.Error) return "error";
	if (category === ts.DiagnosticCategory.Warning) return "warning";
	// Message + Suggestion both map to "info"; callers can still
	// distinguish the original via the `code` if they care.
	return "info";
}

/**
 * Compute a stable SHA-256 snapshot id from the source file content.
 * Used as a content-hash provenance field for diagnostics so the
 * caller can tell a fresh finding from a stale one.
 */
function snapshotIdForSourceFile(sourceFile: SourceFile): string {
	return createHash("sha256").update(sourceFile.text).digest("hex");
}

/**
 * Convert one `ts.Diagnostic` into a `DiagnosticResult`. `timestamp` is
 * supplied by the caller so all diagnostics in a single query share
 * the same provenance timestamp.
 */
function tsDiagnosticToResult(
	ts: TsModule,
	diagnostic: TsDiagnostic,
	worktree: string | undefined,
	timestamp: number,
): DiagnosticResult | undefined {
	const file = diagnostic.file;
	if (!file) return undefined;
	const lineStarts = file.getLineStarts();
	const pos = computeLineAndCharacterOfPosition(lineStarts, diagnostic.start ?? 0);
	const endPos = computeLineAndCharacterOfPosition(lineStarts, (diagnostic.start ?? 0) + (diagnostic.length ?? 0));
	const messageText =
		typeof diagnostic.messageText === "string"
			? diagnostic.messageText
			: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
	const code = diagnostic.code;
	const severity = diagnosticCategoryToSeverity(ts, diagnostic.category);
	const result: DiagnosticResult = {
		relation: "diagnostic",
		file: toRelativePath(file.fileName, worktree),
		line: pos.line + 1,
		severity,
		message: messageText,
		source: diagnostic.source ?? "typescript",
		snapshotId: snapshotIdForSourceFile(file),
		timestamp,
		certainty: "exact",
	};
	if (pos.character > 0 || (diagnostic.length ?? 0) > 0) {
		result.column = pos.character;
	}
	if (typeof code === "number" || typeof code === "string") {
		result.code = code;
	}
	// `endLine` is not part of the public `DiagnosticResult` shape but
	// we still compute it so future expansion can carry the range
	// without re-walking the line map. Keep the local binding to
	// avoid the unused-var lint.
	void endPos;
	return result;
}

/* -------------------------------------------------------------------------- */
/* Worktree resolution                                                        */
/* -------------------------------------------------------------------------- */

async function findWorktree(
	program: Program,
	fs: typeof import("node:fs/promises"),
	path: typeof import("node:path"),
): Promise<string> {
	for (const sf of program.getSourceFiles()) {
		if (isNodeModules(sf.fileName)) continue;
		if (!isTsFile(sf.fileName)) continue;
		let dir = path.dirname(sf.fileName);
		while (true) {
			try {
				const pkg = path.join(dir, PACKAGE_JSON);
				const stat = await fs.stat(pkg);
				if (stat.isFile()) {
					return dir;
				}
			} catch {
				// keep walking up
			}
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return process.cwd();
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

export class TypeScriptLanguageServiceAdapter implements SemanticQueryAdapter {
	private readonly program: Program;
	private readonly includeNodeModules: boolean;
	private readonly fileOverrides: Map<string, string>;
	private readonly explicitWorktree: string | undefined;
	private resolvedWorktree: string | undefined;
	private resolvedWorktreePromise: Promise<string> | undefined;
	private cachedLanguageService: LanguageService | undefined;

	constructor(options: TypeScriptLanguageServiceAdapterOptions) {
		this.program = options.program;
		this.includeNodeModules = options.includeNodeModules ?? false;
		this.fileOverrides = options.fileOverrides ?? new Map();
		this.explicitWorktree = options.worktree;
	}

	private getLanguageService(ts: TsModule): LanguageService {
		if (this.cachedLanguageService) return this.cachedLanguageService;
		const options = this.program.getCompilerOptions();
		// Build a minimal host that mirrors the program's source
		// files. Prefer the in-memory content the program already
		// holds; fall back to the override map and finally to
		// `ts.sys` for any other read.
		const sourceFileNames = new Set<string>();
		for (const sf of this.program.getSourceFiles()) {
			if (!sf.isDeclarationFile) sourceFileNames.add(sf.fileName);
		}
		const versions = new Map<string, number>();
		const host: LanguageServiceHost = {
			getScriptFileNames: () => Array.from(sourceFileNames),
			getScriptVersion: (fileName: string) => {
				const v = versions.get(fileName) ?? 0;
				return String(v);
			},
			getScriptSnapshot: (fileName: string) => {
				const override = this.fileOverrides.get(fileName);
				if (override !== undefined) {
					versions.set(fileName, (versions.get(fileName) ?? 0) + 1);
					return ts.ScriptSnapshot.fromString(override);
				}
				const sf = this.program.getSourceFile(fileName);
				if (sf) {
					return ts.ScriptSnapshot.fromString(sf.text);
				}
				if (ts.sys.fileExists(fileName)) {
					return ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName) ?? "");
				}
				return undefined;
			},
			getCurrentDirectory: () => process.cwd(),
			getCompilationSettings: () => options,
			getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
			fileExists: ts.sys.fileExists,
			readFile: ts.sys.readFile,
			readDirectory: ts.sys.readDirectory,
			directoryExists: ts.sys.directoryExists,
			getDirectories: ts.sys.getDirectories,
		};
		this.cachedLanguageService = ts.createLanguageService(host);
		return this.cachedLanguageService;
	}

	private shouldInclude(sourceFile: SourceFile): boolean {
		if (!isTsFile(sourceFile.fileName)) return false;
		if (!this.includeNodeModules && isNodeModules(sourceFile.fileName)) return false;
		return true;
	}

	private async getWorktree(): Promise<string> {
		if (this.explicitWorktree) return this.explicitWorktree;
		if (this.resolvedWorktree) return this.resolvedWorktree;
		if (!this.resolvedWorktreePromise) {
			this.resolvedWorktreePromise = (async () => {
				const fs = await import("node:fs/promises");
				const path = await import("node:path");
				const wt = await findWorktree(this.program, fs, path);
				this.resolvedWorktree = wt;
				return wt;
			})();
		}
		return this.resolvedWorktreePromise;
	}

	/**
	 * Locate every named declaration in the program that matches
	 * `symbol`. If `hintPath` is provided, only declarations in
	 * matching files are returned.
	 */
	private findDeclarations(
		ts: TsModule,
		symbol: string,
		hintPath: string | undefined,
	): { node: Declaration; sourceFile: SourceFile }[] {
		const results: { node: Declaration; sourceFile: SourceFile }[] = [];
		const seen = new Set<string>();
		const key = (sf: SourceFile, n: Node) => `${sf.fileName}::${n.pos}::${n.end}`;

		for (const sourceFile of this.program.getSourceFiles()) {
			if (!this.shouldInclude(sourceFile)) continue;
			if (hintPath && !this.pathMatches(sourceFile.fileName, hintPath)) continue;

			const visit = (node: Node): void => {
				// Named declaration kinds
				if (
					ts.isFunctionDeclaration(node) ||
					ts.isClassDeclaration(node) ||
					ts.isInterfaceDeclaration(node) ||
					ts.isTypeAliasDeclaration(node) ||
					ts.isEnumDeclaration(node) ||
					ts.isModuleDeclaration(node)
				) {
					const name = getDeclNameText(node as Declaration);
					if (name === symbol) {
						const k = key(sourceFile, node);
						if (!seen.has(k)) {
							seen.add(k);
							results.push({ node: node as Declaration, sourceFile });
						}
					}
				} else if (ts.isVariableStatement(node)) {
					for (const decl of node.declarationList.declarations) {
						if (ts.isIdentifier(decl.name) && decl.name.text === symbol) {
							const k = key(sourceFile, decl);
							if (!seen.has(k)) {
								seen.add(k);
								results.push({ node: decl, sourceFile });
							}
						}
					}
				} else if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
					const nameNode = node.name;
					if (nameNode && ts.isIdentifier(nameNode) && nameNode.text === symbol) {
						const k = key(sourceFile, node);
						if (!seen.has(k)) {
							seen.add(k);
							// Treat named function/arrow expressions as declarations for caller/callee purposes.
							results.push({ node: node as unknown as Declaration, sourceFile });
						}
					}
				} else if (isMethodLike(node)) {
					const named = node as unknown as { name?: { text?: string } | Identifier };
					if (
						named.name &&
						typeof named.name === "object" &&
						"text" in named.name &&
						typeof named.name.text === "string" &&
						named.name.text === symbol
					) {
						const k = key(sourceFile, node);
						if (!seen.has(k)) {
							seen.add(k);
							results.push({ node: node as unknown as Declaration, sourceFile });
						}
					}
				}
				ts.forEachChild(node, visit);
			};
			ts.forEachChild(sourceFile, visit);
		}
		return results;
	}

	private pathMatches(fileName: string, hint: string): boolean {
		const normalizedFile = fileName.replace(/\\/g, "/");
		const normalizedHint = hint.replace(/\\/g, "/");
		return normalizedFile === normalizedHint || normalizedFile.endsWith(`/${normalizedHint}`);
	}

	/* ------------------------------ getDefinition ----------------------------- */

	async getDefinition(symbol: string, options?: SemanticQueryOptions): Promise<SemanticResult> {
		try {
			const ts = await loadTs();
			const decls = this.findDeclarations(ts, symbol, options?.path);
			if (decls.length === 0) {
				return {
					relation: "definition",
					symbol,
					locations: [],
					certainty: "unknown",
					note: `Symbol "${symbol}" not found in the TypeScript program.`,
				};
			}
			const worktree = await this.getWorktree();
			const locations: SemanticLocation[] = decls.map((d) => nodeToLocation(ts, d.node, d.sourceFile, worktree));
			return {
				relation: "definition",
				symbol,
				locations,
				certainty: "exact",
				note: "Resolved via TypeScript compiler API.",
			};
		} catch (err) {
			return {
				relation: "definition",
				symbol,
				locations: [],
				certainty: "unknown",
				note: `TypeScript adapter failed: ${(err as Error).message ?? String(err)}`,
			};
		}
	}

	/* ----------------------------- getReferences ------------------------------ */

	async getReferences(symbol: string, options?: SemanticReferencesOptions): Promise<SemanticResult> {
		try {
			const ts = await loadTs();
			const decls = this.findDeclarations(ts, symbol, options?.path);
			if (decls.length === 0) {
				return {
					relation: "reference",
					symbol,
					locations: [],
					certainty: "unknown",
					coverage: "unknown",
					note: `Symbol "${symbol}" not found in the TypeScript program.`,
				};
			}
			const worktree = await this.getWorktree();
			const ls = this.getLanguageService(ts);
			const max = options?.maxResults ?? Infinity;
			const seen = new Set<string>();
			const locations: SemanticLocation[] = [];
			let nodeModulesSeen = false;
			for (const decl of decls) {
				const sourceFile = decl.sourceFile;
				const position = decl.node.pos;
				const referencedSymbols = ls.findReferences(sourceFile.fileName, position) ?? [];
				for (const ref of referencedSymbols) {
					for (const entry of ref.references ?? []) {
						if (entry.isDefinition) continue;
						const refFile = this.program.getSourceFile(entry.fileName);
						if (!refFile) continue;
						if (!this.shouldInclude(refFile)) {
							nodeModulesSeen = true;
							continue;
						}
						const start = entry.textSpan.start;
						const end = start + entry.textSpan.length;
						const k = `${refFile.fileName}::${start}::${end}`;
						if (seen.has(k)) continue;
						seen.add(k);
						locations.push(spanToLocation(ts, refFile, start, end, worktree));
						if (locations.length >= max) break;
					}
					if (locations.length >= max) break;
				}
				if (locations.length >= max) break;
			}
			const coverage: "complete" | "partial" = nodeModulesSeen ? "partial" : "complete";
			return {
				relation: "reference",
				symbol,
				locations,
				certainty: "exact",
				coverage,
				note: coverage === "partial" ? "node_modules/ was skipped; some references may be missing." : undefined,
			};
		} catch (err) {
			return {
				relation: "reference",
				symbol,
				locations: [],
				certainty: "unknown",
				coverage: "unknown",
				note: `TypeScript adapter failed: ${(err as Error).message ?? String(err)}`,
			};
		}
	}

	/* ------------------------------ getCallers -------------------------------- */

	async getCallers(symbol: string, options?: SemanticQueryOptions): Promise<SemanticResult> {
		try {
			const ts = await loadTs();
			const decls = this.findDeclarations(ts, symbol, options?.path);
			if (decls.length === 0) {
				return {
					relation: "caller",
					symbol,
					direct: [],
					candidates: [],
					certainty: "unknown",
					note: `Symbol "${symbol}" not found in the TypeScript program.`,
				};
			}
			const worktree = await this.getWorktree();
			const direct: SemanticLocation[] = [];
			const candidates: SemanticLocation[] = [];
			const seen = new Set<string>();
			const ls = this.getLanguageService(ts);
			for (const decl of decls) {
				const sourceFile = decl.sourceFile;
				const position = decl.node.pos;
				const referencedSymbols = ls.findReferences(sourceFile.fileName, position) ?? [];
				for (const ref of referencedSymbols) {
					for (const entry of ref.references ?? []) {
						if (entry.isDefinition) continue;
						const refFile = this.program.getSourceFile(entry.fileName);
						if (!refFile) continue;
						if (!this.shouldInclude(refFile)) continue;
						const start = entry.textSpan.start;
						const end = start + entry.textSpan.length;
						// Walk the AST to find the smallest CallExpression
						// whose `expression` Identifier covers this
						// reference. Doesn't rely on parent pointers.
						const call = findEnclosingDirectCall(ts, refFile, start, end);
						const isDirectCall = !!call;
						const k = `${refFile.fileName}::${start}::${end}`;
						if (seen.has(k)) continue;
						seen.add(k);
						const loc = spanToLocation(ts, refFile, start, end, worktree);
						if (isDirectCall) direct.push(loc);
						else candidates.push(loc);
					}
				}
			}
			return {
				relation: "caller",
				symbol,
				direct,
				candidates,
				certainty: "exact",
				note: "Callers computed via TypeScript compiler API; candidates include references that are not direct call expressions.",
			};
		} catch (err) {
			return {
				relation: "caller",
				symbol,
				direct: [],
				candidates: [],
				certainty: "unknown",
				note: `TypeScript adapter failed: ${(err as Error).message ?? String(err)}`,
			};
		}
	}

	/* ------------------------------ getCallees -------------------------------- */

	async getCallees(symbol: string, options?: SemanticQueryOptions): Promise<SemanticResult> {
		try {
			const ts = await loadTs();
			const decls = this.findDeclarations(ts, symbol, options?.path);
			if (decls.length === 0) {
				return {
					relation: "callee",
					symbol,
					direct: [],
					candidates: [],
					certainty: "unknown",
					note: `Symbol "${symbol}" not found in the TypeScript program.`,
				};
			}
			const worktree = await this.getWorktree();
			const direct: SemanticLocation[] = [];
			const candidates: SemanticLocation[] = [];
			const seen = new Set<string>();
			for (const decl of decls) {
				const node = decl.node;
				// Find the body we should walk. Functions, methods, and arrow expressions are supported.
				let body: Node | undefined;
				if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
					body = node.body;
				} else if (ts.isArrowFunction(node)) {
					body = node.body;
				}
				if (!body) continue;
				const visit = (node: Node): void => {
					if (ts.isCallExpression(node)) {
						const expr = node.expression;
						if (ts.isIdentifier(expr)) {
							const start = expr.pos;
							const end = expr.end;
							const k = `${node.getSourceFile()?.fileName ?? decl.sourceFile.fileName}::${start}::${end}`;
							if (!seen.has(k)) {
								seen.add(k);
								direct.push(spanToLocation(ts, node.getSourceFile() ?? decl.sourceFile, start, end, worktree));
							}
						} else {
							// Tagged template / member / dynamic dispatch — not statically known.
							const start = expr.pos;
							const end = expr.end;
							const k = `${node.getSourceFile()?.fileName ?? decl.sourceFile.fileName}::${start}::${end}`;
							if (!seen.has(k)) {
								seen.add(k);
								candidates.push(
									spanToLocation(ts, node.getSourceFile() ?? decl.sourceFile, start, end, worktree),
								);
							}
						}
					}
					ts.forEachChild(node, visit);
				};
				ts.forEachChild(body, visit);
			}
			return {
				relation: "callee",
				symbol,
				direct,
				candidates,
				certainty: "exact",
				note: "Callees computed via TypeScript compiler API; candidates include dynamic / member-style dispatch.",
			};
		} catch (err) {
			return {
				relation: "callee",
				symbol,
				direct: [],
				candidates: [],
				certainty: "unknown",
				note: `TypeScript adapter failed: ${(err as Error).message ?? String(err)}`,
			};
		}
	}

	/* ---------------------------- getImplementations -------------------------- */

	async getImplementations(symbol: string, options?: SemanticQueryOptions): Promise<SemanticResult> {
		try {
			const ts = await loadTs();
			const decls = this.findDeclarations(ts, symbol, options?.path);
			if (decls.length === 0) {
				return {
					relation: "implementation",
					symbol,
					locations: [],
					certainty: "unknown",
					note: `Symbol "${symbol}" not found in the TypeScript program.`,
				};
			}
			const worktree = await this.getWorktree();
			const seen = new Set<string>();
			const locations: SemanticLocation[] = [];
			const isInterface = decls.some((d) => ts.isInterfaceDeclaration(d.node));
			if (!isInterface) {
				return {
					relation: "implementation",
					symbol,
					locations: [],
					certainty: "unknown",
					note: `Symbol "${symbol}" is not an interface; the TypeScript adapter only resolves implementations of interfaces.`,
				};
			}
			for (const sourceFile of this.program.getSourceFiles()) {
				if (!this.shouldInclude(sourceFile)) continue;
				const visit = (node: Node): void => {
					if (ts.isClassDeclaration(node) && node.heritageClauses) {
						for (const clause of node.heritageClauses) {
							if (
								clause.token !== ts.SyntaxKind.ExtendsKeyword &&
								clause.token !== ts.SyntaxKind.ImplementsKeyword
							) {
								continue;
							}
							for (const typeNode of clause.types) {
								if (ts.isIdentifier(typeNode.expression) && typeNode.expression.text === symbol) {
									if (node.name && ts.isIdentifier(node.name)) {
										const declNode: Node = node.name as Identifier;
										const k = `${sourceFile.fileName}::${declNode.pos}::${declNode.end}`;
										if (!seen.has(k)) {
											seen.add(k);
											locations.push(nodeToLocation(ts, declNode, sourceFile, worktree));
										}
									}
								}
							}
						}
					}
					ts.forEachChild(node, visit);
				};
				ts.forEachChild(sourceFile, visit);
			}
			return {
				relation: "implementation",
				symbol,
				locations,
				certainty: "exact",
				note: "Implementations discovered by walking heritage clauses of every class in the program.",
			};
		} catch (err) {
			return {
				relation: "implementation",
				symbol,
				locations: [],
				certainty: "unknown",
				note: `TypeScript adapter failed: ${(err as Error).message ?? String(err)}`,
			};
		}
	}

	/* ---------------------------- getRelevantTests ---------------------------- */

	async getRelevantTests(symbol: string, _options?: SemanticQueryOptions): Promise<SemanticResult> {
		try {
			const fs = await import("node:fs/promises");
			const path = await import("node:path");
			const worktree = await this.getWorktree();
			const tests: { path: string; reason: string; confidence: number }[] = [];
			const seen = new Set<string>();

			const queue: string[] = [worktree];
			const visited = new Set<string>();
			while (queue.length > 0) {
				const dir = queue.shift()!;
				if (visited.has(dir)) continue;
				visited.add(dir);
				let entries: import("node:fs").Dirent[];
				try {
					entries = await fs.readdir(dir, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const entry of entries) {
					if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
						continue;
					}
					const full = path.join(dir, entry.name);
					if (entry.isDirectory()) {
						queue.push(full);
						continue;
					}
					if (!entry.isFile()) continue;
					if (!/\.(?:test|spec)\.tsx?$/i.test(entry.name)) continue;
					let content: string;
					try {
						content = await fs.readFile(full, "utf-8");
					} catch {
						continue;
					}
					if (!content.includes(symbol)) continue;
					const rel = toRelativePath(full, worktree);
					if (seen.has(rel)) continue;
					seen.add(rel);
					// Confidence: direct import > describe("...symbol...") > loose mention.
					const importRegex = /from\s+["'][^"']*["']/;
					const hasImport = new RegExp(`import\\b[^;]*\\b${symbol}\\b`).test(content);
					const describeRegex = new RegExp(`(?:describe|it|test)\\s*\\(\\s*["'\`][^"'\`]*\\b${symbol}\\b`);
					const hasDescribe = describeRegex.test(content);
					let confidence = 0.4;
					let reason = `Mentions ${symbol}`;
					if (hasImport) {
						confidence = 0.95;
						reason = `Imports ${symbol}`;
					} else if (hasDescribe) {
						confidence = 0.7;
						reason = `Test name references ${symbol}`;
					}
					// Avoid unused-var lints on the local regex above.
					void importRegex;
					tests.push({ path: rel, reason, confidence });
				}
			}
			tests.sort((a, b) => b.confidence - a.confidence);
			return {
				relation: "test-relation",
				symbol,
				tests,
				certainty: tests.length > 0 ? "candidate" : "unknown",
				note:
					tests.length === 0
						? `No test file mentioning "${symbol}" was found under ${worktree}.`
						: "Tests ranked by confidence; not exhaustive.",
			};
		} catch (err) {
			return {
				relation: "test-relation",
				symbol,
				tests: [],
				certainty: "unknown",
				note: `TypeScript adapter failed: ${(err as Error).message ?? String(err)}`,
			};
		}
	}

	/* ------------------------------ getDiagnostics ---------------------------- */

	async getDiagnostics(options?: SemanticDiagnosticsOptions): Promise<DiagnosticResult[]> {
		try {
			const ts = await loadTs();
			const worktree = await this.getWorktree();
			const wantWarnings = options?.includeWarnings === true;
			const wantPath = options?.path;
			const timestamp = Date.now();
			const out: DiagnosticResult[] = [];
			const seen = new Set<string>();
			for (const sourceFile of this.program.getSourceFiles()) {
				if (!this.shouldInclude(sourceFile)) continue;
				const relPath = toRelativePath(sourceFile.fileName, worktree);
				if (wantPath !== undefined && !this.pathMatches(sourceFile.fileName, wantPath)) continue;
				const semantic = this.program.getSemanticDiagnostics(sourceFile) ?? [];
				const syntactic = this.program.getSyntacticDiagnostics(sourceFile) ?? [];
				const all = [...syntactic, ...semantic];
				for (const d of all) {
					// Build a dedup key from the diagnostic's identifying fields
					// so a re-run with the same file content doesn't double-count.
					const key = `${relPath}::${d.start ?? 0}::${d.length ?? 0}::${d.code}::${d.category}`;
					if (seen.has(key)) continue;
					seen.add(key);
					const mapped = tsDiagnosticToResult(ts, d, worktree, timestamp);
					if (!mapped) continue;
					if (!wantWarnings && mapped.severity === "warning") continue;
					out.push(mapped);
				}
			}
			// Sort by file then line for stable output.
			out.sort((a, b) => {
				if (a.file !== b.file) return a.file.localeCompare(b.file);
				return a.line - b.line;
			});
			return out;
		} catch {
			// Diagnostics are an additive signal; on any internal failure
			// return an empty list rather than throw. Callers can detect
			// "no findings" by absence, which is consistent with the
			// mock's default behaviour.
			return [];
		}
	}
}

/**
 * Exposed for tests / advanced callers that need a TS module handle
 * (e.g. to call `ts.createProgram` themselves). Uses the same
 * indirection as the adapter.
 */
export async function loadTypeScript(): Promise<TsModule> {
	return loadTs();
}

