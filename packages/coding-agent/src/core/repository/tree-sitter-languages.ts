/**
 * F1 syntax service — tree-sitter language registry.
 *
 * Maps `FileManifestEntry.language` tags to a `(tree, source, path,
 * language) -> SymbolEntry[]` extractor backed by a tree-sitter
 * syntax tree.
 *
 * ## Why a registry, not direct imports
 *
 * The `tree-sitter` native binding is a hard dependency, but the
 * per-language grammar packages (`tree-sitter-typescript`,
 * `tree-sitter-python`, etc.) are not bundled in this workspace.
 * Keeping the language modules as runtime registrations means:
 *
 *   - The base workspace has no transitive native dep on a grammar
 *     we never actually parse with.
 *   - Extensions or other packages can register additional
 *     languages without touching this module.
 *   - The fallback contract is simple: if a language tag has no
 *     entry, the dispatcher silently uses the regex extractor.
 *
 * The registration API is `registerTreeSitterLanguage(language,
 * grammar, extract)`. Tests call it directly. Production wiring can
 * call it at process startup once the optional grammar packages are
 * installed.
 *
 * ## Markdown
 *
 * The Markdown "language" does not have a real tree-sitter grammar
 * in this module — it uses a tiny line-based scanner registered
 * under the `markdown` language tag. The scanner is tree-sitter
 * shaped (it returns a synthetic `Tree`-shaped object with ATX
 * heading and fenced code-block nodes) so the extractor can be
 * shared with the rest of the pipeline.
 */

import type { FileManifestEntry } from "./manifest.ts";
import type { SymbolEntry } from "./syntax-index.ts";
import type { TreeSitterLanguage } from "./tree-sitter-parser.ts";
import { parse as parseWithTreeSitter } from "./tree-sitter-parser.ts";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Subset of `Parser.SyntaxNode` the per-language extractors need.
 * Defined here as a structural interface so the same extractor can
 * be unit-tested against synthetic trees without spinning up the
 * native binding.
 */
export interface SyntaxNodeLike {
	/** The grammar type, e.g. `"function_declaration"`. */
	readonly type: string;
	/** 0-indexed byte offset of the start of the node. */
	readonly startByte: number;
	/** 0-indexed byte offset just past the end of the node. */
	readonly endByte: number;
	/** 1-indexed line where the node starts. */
	readonly startLine: number;
	/** 1-indexed line where the node ends (inclusive). */
	readonly endLine: number;
	/** Source text for the node. */
	readonly text: string;
	/** All children (named and anonymous). */
	readonly children: readonly SyntaxNodeLike[];
	/** Only the named children (anonymous tokens filtered out). */
	readonly namedChildren: readonly SyntaxNodeLike[];
	/** The smallest child with the given field name, or `null`. */
	childForFieldName(fieldName: string): SyntaxNodeLike | null;
	/** Parent node, or `null` for the tree root. */
	readonly parent: SyntaxNodeLike | null;
	/** True if this node (or any descendant) failed to parse cleanly. */
	readonly hasError: boolean;
	/** True if this node is itself an error node. */
	readonly isError: boolean;
}

/** Tree root, with a `rootNode` accessor. */
export interface SyntaxTreeLike {
	readonly rootNode: SyntaxNodeLike;
	readonly source: string;
	readonly language: TreeSitterLanguage | null;
}

/**
 * Per-language extractor: walk a syntax tree and emit
 * `SymbolEntry` records. Pure function — the same tree can be
 * re-extracted without side effects.
 */
export type TreeSitterSymbolExtractor = (
	tree: SyntaxTreeLike,
	source: string,
	filePath: string,
	language: string,
) => SymbolEntry[];

/** A language binding: the grammar plus the extractor. */
export interface TreeSitterLanguageBinding {
	language: TreeSitterLanguage;
	extract: TreeSitterSymbolExtractor;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

const registry = new Map<string, TreeSitterLanguageBinding>();

/**
 * Register `binding` under `languageTag`. Subsequent calls with the
 * same tag overwrite the previous entry. The dispatcher reads the
 * registry at parse time, so re-registration is safe at runtime.
 */
export function registerTreeSitterLanguage(languageTag: string, binding: TreeSitterLanguageBinding): void {
	registry.set(languageTag, binding);
}

/** Remove the language binding for `languageTag`. Returns true if it existed. */
export function unregisterTreeSitterLanguage(languageTag: string): boolean {
	return registry.delete(languageTag);
}

/** Look up the language binding for `languageTag`, or `null` if none. */
export function getTreeSitterLanguageBinding(languageTag: string): TreeSitterLanguageBinding | null {
	return registry.get(languageTag) ?? null;
}

/** List every language tag currently registered (sorted). */
export function listRegisteredTreeSitterLanguages(): string[] {
	return Array.from(registry.keys()).sort();
}

/** Test-only: drop every language binding. */
export function resetTreeSitterLanguageRegistry(): void {
	registry.clear();
}

/* -------------------------------------------------------------------------- */
/* Tree adapter                                                               */
/* -------------------------------------------------------------------------- */

/** Adapter from a native `Parser.Tree` to the `SyntaxTreeLike` interface. */
function adaptTree(tree: import("tree-sitter").Tree, source: string, language: TreeSitterLanguage): SyntaxTreeLike {
	return {
		rootNode: adaptNode(tree.rootNode, null),
		source,
		language,
	};
}

/** Adapter from a native `Parser.SyntaxNode` to `SyntaxNodeLike`. */
function adaptNode(node: import("tree-sitter").SyntaxNode, parent: SyntaxNodeLike | null): SyntaxNodeLike {
	const cachedChildren: SyntaxNodeLike[] = [];
	const cachedNamed: SyntaxNodeLike[] = [];
	let childrenBuilt = false;
	let namedBuilt = false;
	return {
		type: node.type,
		startByte: node.startIndex,
		endByte: node.endIndex,
		startLine: node.startPosition.row + 1,
		endLine: node.endPosition.row + 1,
		text: node.text,
		get children() {
			if (!childrenBuilt) {
				for (const child of node.children) {
					cachedChildren.push(adaptNode(child, this));
				}
				childrenBuilt = true;
			}
			return cachedChildren;
		},
		get namedChildren() {
			if (!namedBuilt) {
				for (const child of node.namedChildren) {
					cachedNamed.push(adaptNode(child, this));
				}
				namedBuilt = true;
			}
			return cachedNamed;
		},
		childForFieldName(name) {
			const child = node.childForFieldName(name);
			return child ? adaptNode(child, this) : null;
		},
		parent,
		hasError: node.hasError,
		isError: node.isError,
	};
}

/** Build a `SyntaxTreeLike` from raw source using the engine. */
export function parseSourceWithLanguage(source: string, binding: TreeSitterLanguageBinding): SyntaxTreeLike | null {
	const result = parseWithTreeSitter(source, binding.language);
	if (!result) return null;
	return adaptTree(result.tree, source, result.language);
}

/* -------------------------------------------------------------------------- */
/* Shared helpers used by every extractor                                     */
/* -------------------------------------------------------------------------- */

/**
 * Convert a raw node's 0-indexed row positions into 1-indexed lines
 * for `SymbolEntry`. `Parser.Point` is already 0-indexed.
 */
function linesOf(node: SyntaxNodeLike): { startLine: number; endLine: number } {
	return { startLine: node.startLine, endLine: node.endLine };
}

/** Trim surrounding whitespace and a single trailing newline (for signatures). */
function signatureText(node: SyntaxNodeLike): string {
	return node.text.replace(/\n\s*/g, " ").trim();
}

/* -------------------------------------------------------------------------- */
/* TypeScript / JavaScript extractor                                          */
/* -------------------------------------------------------------------------- */

const TS_VAR_KEYWORDS = new Set<string>(["const", "let", "var"]);

/** TypeScript + JavaScript extractor (JS filters out TS-only kinds downstream). */
export const extractTypeScriptJavaScriptSymbols: TreeSitterSymbolExtractor = (tree, _source, filePath, language) => {
	const out: SymbolEntry[] = [];
	const classStack: SyntaxNodeLike[] = [];
	walk(tree.rootNode, filePath, language, classStack, out);
	// Apply the language filter (JS drops interface/type/enum records).
	if (language === "javascript") {
		return out.filter((s) => s.kind !== "interface" && s.kind !== "type" && s.kind !== "enum");
	}
	return out;
};

/**
 * Recursive walker that drives `emitNode` for every node. Class
 * frames are pushed before descending into children and popped on
 * the way out, so a `method_definition` always sees its enclosing
 * class on the stack.
 *
 * Recursion is fine here because the only state that grows is the
 * class stack (typically 1–2 levels deep). The hot path
 * (`emitNode`) does no per-node allocation beyond the symbol
 * records it pushes.
 */
function walk(
	node: SyntaxNodeLike,
	filePath: string,
	language: string,
	classStack: SyntaxNodeLike[],
	out: SymbolEntry[],
): void {
	const isClass =
		node.type === "class_declaration" || node.type === "abstract_class_declaration" || node.type === "class";
	if (isClass) classStack.push(node);
	emitNode(node, filePath, language, classStack, out);
	for (const child of node.namedChildren) {
		walk(child, filePath, language, classStack, out);
	}
	if (isClass) classStack.pop();
}

function emitNode(
	node: SyntaxNodeLike,
	filePath: string,
	language: string,
	classStack: readonly SyntaxNodeLike[],
	out: SymbolEntry[],
): void {
	const lines = linesOf(node);
	const bytes = { startByte: node.startByte, endByte: node.endByte };
	const className = currentClassName(classStack, filePath);

	switch (node.type) {
		case "function_declaration":
		case "generator_function_declaration": {
			const name = readFunctionName(node);
			if (name === null) return;
			out.push({
				kind: "function",
				name,
				path: filePath,
				startLine: lines.startLine,
				endLine: lines.endLine,
				language,
				modifiers: collectModifiers(node),
				signature: signatureText(node),
				...bytes,
			});
			return;
		}
		case "abstract_class_declaration":
		case "class_declaration":
		case "class": {
			const name = readClassName(node);
			if (name === null) return;
			out.push({
				kind: "class",
				name,
				path: filePath,
				startLine: lines.startLine,
				endLine: lines.endLine,
				language,
				modifiers: collectModifiers(node),
				signature: signatureText(node),
				...bytes,
			});
			// Methods are emitted as we descend.
			return;
		}
		case "interface_declaration": {
			const name = readClassName(node);
			if (name === null) return;
			out.push({
				kind: "interface",
				name,
				path: filePath,
				startLine: lines.startLine,
				endLine: lines.endLine,
				language,
				modifiers: collectModifiers(node),
				signature: signatureText(node),
				...bytes,
			});
			return;
		}
		case "type_alias_declaration": {
			const name = node.childForFieldName("name");
			if (!name) return;
			out.push({
				kind: "type",
				name: name.text,
				path: filePath,
				startLine: lines.startLine,
				endLine: lines.endLine,
				language,
				modifiers: collectModifiers(node),
				signature: signatureText(node),
				...bytes,
			});
			return;
		}
		case "enum_declaration": {
			const name = node.childForFieldName("name");
			if (!name) return;
			out.push({
				kind: "enum",
				name: name.text,
				path: filePath,
				startLine: lines.startLine,
				endLine: lines.endLine,
				language,
				modifiers: collectModifiers(node),
				signature: signatureText(node),
				...bytes,
			});
			return;
		}
		case "method_definition": {
			if (!className) return;
			const name = node.childForFieldName("name");
			if (!name) return;
			out.push({
				kind: "method",
				name: name.text,
				path: filePath,
				startLine: lines.startLine,
				endLine: lines.endLine,
				language,
				containerName: className,
				modifiers: collectModifiers(node),
				signature: signatureText(node),
				...bytes,
			});
			return;
		}
		case "lexical_declaration":
		case "variable_declaration": {
			emitVariableDeclaration(node, filePath, language, className, out);
			return;
		}
		case "import_statement": {
			emitImportStatement(node, filePath, language, out);
			return;
		}
		case "export_statement": {
			emitExportStatement(node, filePath, language, out);
			return;
		}
		default:
			return;
	}
}

function currentClassName(classStack: readonly SyntaxNodeLike[], _filePath: string): string | undefined {
	for (let i = classStack.length - 1; i >= 0; i -= 1) {
		const node = classStack[i] as SyntaxNodeLike;
		const name = readClassName(node);
		if (name !== null) return name;
	}
	return undefined;
}

function readFunctionName(node: SyntaxNodeLike): string | null {
	const nameNode = node.childForFieldName("name");
	return nameNode ? nameNode.text : null;
}

function readClassName(node: SyntaxNodeLike): string | null {
	const nameNode = node.childForFieldName("name");
	return nameNode ? nameNode.text : null;
}

function collectModifiers(node: SyntaxNodeLike): string[] | undefined {
	// Tree-sitter places `export`, `default`, `async`, `abstract`, `declare`
	// in the named children of the declaration, but the order is not always
	// source order. Pull a stable, source-ordered, de-duplicated list from
	// the full named-children sequence (skipping the actual identifier and
	// body / initializer / extends clause).
	const SKIP = new Set<string>([
		// Standard "head" kinds we don't want as modifiers:
		"identifier",
		"type_identifier",
		"property_identifier",
		"nested_identifier",
		"class_heritage",
		"extends_clause",
		"implements_clause",
		"class_body",
		"statement_block",
		"function_body",
		"formal_parameters",
		// TypeScript-specific:
		"type_parameters",
		"constraint",
		"default_type",
		// Variable declarators
		"variable_declarator",
		// Type alias rhs
		"type_annotation",
		// Function / method bodies
		"decorator",
	]);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const child of node.namedChildren) {
		if (SKIP.has(child.type)) continue;
		if (TS_VAR_KEYWORDS.has(child.type)) {
			if (!seen.has(child.type)) {
				out.push(child.type);
				seen.add(child.type);
			}
			continue;
		}
		// Treat short keyword tokens (`export`, `default`, `async`, `abstract`,
		// `declare`, `static`, `public`, `private`, `protected`, `readonly`,
		// `override`, `const`, `let`, `var`) as modifiers.
		const text = child.text;
		if (
			/^(?:export|default|async|abstract|declare|static|public|private|protected|readonly|override|get|set|const|let|var)$/.test(
				text,
			)
		) {
			if (!seen.has(text)) {
				out.push(text);
				seen.add(text);
			}
		}
	}
	return out.length > 0 ? out : undefined;
}

function emitVariableDeclaration(
	node: SyntaxNodeLike,
	filePath: string,
	language: string,
	className: string | undefined,
	out: SymbolEntry[],
): void {
	const lines = linesOf(node);
	const bytes = { startByte: node.startByte, endByte: node.endByte };
	const modifiers = collectModifiers(node);
	for (const child of node.namedChildren) {
		if (child.type !== "variable_declarator") continue;
		const name = child.childForFieldName("name");
		if (!name) continue;
		// Skip class field declarations — those become "property" below.
		if (className) {
			out.push({
				kind: "property",
				name: name.text,
				path: filePath,
				startLine: child.startLine,
				endLine: child.endLine,
				language,
				containerName: className,
				modifiers,
				signature: signatureText(child),
				startByte: child.startByte,
				endByte: child.endByte,
			});
			continue;
		}
		out.push({
			kind: "variable",
			name: name.text,
			path: filePath,
			startLine: lines.startLine,
			endLine: lines.endLine,
			language,
			modifiers,
			signature: signatureText(child),
			...bytes,
		});
	}
}

function emitImportStatement(node: SyntaxNodeLike, filePath: string, language: string, out: SymbolEntry[]): void {
	const lines = linesOf(node);
	const bytes = { startByte: node.startByte, endByte: node.endByte };
	// `import_statement` always carries exactly one `string` child for
	// the module specifier.
	const source = node.namedChildren.find((c) => c.type === "string");
	const moduleName = source ? unquote(source.text) : "";
	if (!source) {
		// `import "foo"` (no bindings) — still record the source as a
		// side-effect import so the index has *something*.
		out.push({
			kind: "import",
			name: moduleName,
			path: filePath,
			startLine: lines.startLine,
			endLine: lines.endLine,
			language,
			modifiers: ["side-effect"],
			...bytes,
		});
		return;
	}
	const importClause =
		node.childForFieldName("import_clause") ?? node.namedChildren.find((c) => c.type === "import_clause");
	if (!importClause) return;
	// `default` and `namespace` children are inside the import clause.
	const defaultBinding = importClause.namedChildren.find((c) => c.type === "identifier");
	if (defaultBinding) {
		out.push({
			kind: "import",
			name: moduleName,
			path: filePath,
			startLine: lines.startLine,
			endLine: lines.endLine,
			language,
			modifiers: ["default"],
			containerName: defaultBinding.text,
			...bytes,
		});
	}
	const namespaceImport = importClause.namedChildren.find((c) => c.type === "namespace_import");
	if (namespaceImport) {
		const ident = namespaceImport.namedChildren.find((c) => c.type === "identifier");
		if (ident) {
			out.push({
				kind: "import",
				name: moduleName,
				path: filePath,
				startLine: lines.startLine,
				endLine: lines.endLine,
				language,
				modifiers: ["namespace"],
				containerName: ident.text,
				...bytes,
			});
		}
	}
	const namedImports = importClause.namedChildren.find((c) => c.type === "named_imports");
	if (namedImports) {
		for (const spec of namedImports.namedChildren) {
			// `import_specifier` children: each has `name` and optional `alias`.
			const name = spec.childForFieldName("name");
			if (!name) continue;
			const alias = spec.childForFieldName("alias");
			out.push({
				kind: "import",
				name: moduleName,
				path: filePath,
				startLine: spec.startLine,
				endLine: spec.endLine,
				language,
				modifiers: ["named"],
				containerName: alias ? alias.text : name.text,
				startByte: spec.startByte,
				endByte: spec.endByte,
			});
		}
	}
}

function emitExportStatement(node: SyntaxNodeLike, filePath: string, language: string, out: SymbolEntry[]): void {
	const lines = linesOf(node);
	const bytes = { startByte: node.startByte, endByte: node.endByte };
	// `export_statement` can wrap a declaration, a default expression,
	// or a named-export list. We handle the list / star / default cases
	// here; the wrapped declaration is picked up by its own rule above
	// once the iteration descends into the statement.
	const named = node.namedChildren;
	// `export * from "x"` and `export * as ns from "x"`
	if (node.children.some((c) => c.type === "*")) {
		const source = named.find((c) => c.type === "string");
		if (source) {
			const alias = named.find((c) => c.type === "identifier");
			out.push({
				kind: "export",
				name: unquote(source.text),
				path: filePath,
				startLine: lines.startLine,
				endLine: lines.endLine,
				language,
				modifiers: ["star"],
				containerName: alias?.text,
				...bytes,
			});
			return;
		}
	}
	// `export { a, b as c }` (possibly with `from "x"`)
	const exportClause = named.find((c) => c.type === "export_clause");
	if (exportClause) {
		const source = named.find((c) => c.type === "string");
		for (const spec of exportClause.namedChildren) {
			if (spec.type !== "export_specifier") continue;
			const name = spec.childForFieldName("name");
			if (!name) continue;
			const alias = spec.childForFieldName("alias");
			out.push({
				kind: "export",
				name: alias ? alias.text : name.text,
				path: filePath,
				startLine: spec.startLine,
				endLine: spec.endLine,
				language,
				modifiers: source ? ["named", "re-export"] : ["named"],
				startByte: spec.startByte,
				endByte: spec.endByte,
			});
		}
		return;
	}
	// `export default <expr>` — record the right-hand-side identifier if any.
	const hasDefault = node.namedChildren.some((c) => c.text === "default");
	if (hasDefault) {
		const expr = named.find((c) => c.type === "expression" || c.type === "function" || c.type === "class");
		const name = expr?.namedChildren[0]?.text ?? "<anonymous>";
		out.push({
			kind: "export",
			name,
			path: filePath,
			startLine: lines.startLine,
			endLine: lines.endLine,
			language,
			modifiers: ["default"],
			...bytes,
		});
	}
}

function unquote(s: string): string {
	if (s.length >= 2) {
		const first = s[0];
		const last = s[s.length - 1];
		if ((first === '"' || first === "'" || first === "`") && first === last) {
			return s.slice(1, -1);
		}
	}
	return s;
}

/* -------------------------------------------------------------------------- */
/* Python extractor                                                           */
/* -------------------------------------------------------------------------- */

export const extractPythonSymbols: TreeSitterSymbolExtractor = (tree, _source, filePath, language) => {
	const out: SymbolEntry[] = [];
	// Python's root is a `module` whose named children are the
	// top-level statements. Nested definitions are emitted as a
	// `method` record with `containerName` = enclosing class.
	const classStack: SyntaxNodeLike[] = [];
	walkPython(tree.rootNode, filePath, language, classStack, out);
	return out;
};

function walkPython(
	node: SyntaxNodeLike,
	filePath: string,
	language: string,
	classStack: SyntaxNodeLike[],
	out: SymbolEntry[],
): void {
	const isClass = node.type === "class_definition";
	if (isClass) classStack.push(node);
	emitPythonNode(node, filePath, language, classStack, out);
	for (const child of node.namedChildren) {
		walkPython(child, filePath, language, classStack, out);
	}
	if (isClass) classStack.pop();
}

function emitPythonNode(
	node: SyntaxNodeLike,
	filePath: string,
	language: string,
	classStack: readonly SyntaxNodeLike[],
	out: SymbolEntry[],
): void {
	const lines = linesOf(node);
	const bytes = { startByte: node.startByte, endByte: node.endByte };
	const className = currentPythonClassName(classStack);

	if (node.type === "function_definition") {
		const name = node.childForFieldName("name");
		if (!name) return;
		const decorators = collectPythonDecorators(node);
		const isMethod = className !== undefined;
		out.push({
			kind: isMethod ? "method" : "function",
			name: name.text,
			path: filePath,
			startLine: lines.startLine,
			endLine: lines.endLine,
			language,
			containerName: isMethod ? className : undefined,
			modifiers: decorators.length > 0 ? decorators : undefined,
			signature: signatureText(node),
			...bytes,
		});
		return;
	}
	if (node.type === "class_definition") {
		const name = node.childForFieldName("name");
		if (!name) return;
		out.push({
			kind: "class",
			name: name.text,
			path: filePath,
			startLine: lines.startLine,
			endLine: lines.endLine,
			language,
			signature: signatureText(node),
			...bytes,
		});
		return;
	}
	if (node.type === "import_statement" || node.type === "future") {
		// `from X import a, b` and `import a, b` are both represented
		// as `import_statement` in tree-sitter-python.
		emitPythonImport(node, filePath, language, out);
		return;
	}
	if (node.type === "import_from_statement") {
		emitPythonImport(node, filePath, language, out);
		return;
	}
}

function currentPythonClassName(classStack: readonly SyntaxNodeLike[]): string | undefined {
	for (let i = classStack.length - 1; i >= 0; i -= 1) {
		const node = classStack[i] as SyntaxNodeLike;
		const name = node.childForFieldName("name");
		if (name) return name.text;
	}
	return undefined;
}

function collectPythonDecorators(node: SyntaxNodeLike): string[] {
	const out: string[] = [];
	for (const child of node.namedChildren) {
		if (child.type === "decorator") {
			// Strip the leading `@` and capture the call/identifier tail.
			const text = child.text.replace(/^@/, "").trim();
			out.push(`@${text}`);
		}
	}
	return out;
}

function emitPythonImport(node: SyntaxNodeLike, filePath: string, language: string, out: SymbolEntry[]): void {
	const lines = linesOf(node);
	const bytes = { startByte: node.startByte, endByte: node.endByte };
	// `import a.b, c as d` — `dotted_name` or `aliased_import` children
	// under `import_statement`. `import_from_statement` has a
	// `module_name` and a list of `dotted_name` / `aliased_import` in
	// its `name` field, plus bare `identifier` children for single
	// names (e.g. `from typing import List`).
	const moduleName = node.childForFieldName("module_name");
	const sourceText = moduleName ? moduleName.text : "";
	for (const child of node.namedChildren) {
		if (child.type === "module_name" || child === moduleName) continue;
		if (child.type === "aliased_import") {
			const alias = child.childForFieldName("alias");
			const name = child.childForFieldName("name");
			out.push({
				kind: "import",
				name: sourceText || name?.text || child.text,
				path: filePath,
				startLine: child.startLine,
				endLine: child.endLine,
				language,
				containerName: alias ? alias.text : name?.text,
				startByte: child.startByte,
				endByte: child.endByte,
			});
			continue;
		}
		if (child.type === "dotted_name") {
			out.push({
				kind: "import",
				name: sourceText || child.text,
				path: filePath,
				startLine: child.startLine,
				endLine: child.endLine,
				language,
				containerName: child.text,
				startByte: child.startByte,
				endByte: child.endByte,
			});
			continue;
		}
		if (child.type === "identifier") {
			out.push({
				kind: "import",
				name: sourceText || child.text,
				path: filePath,
				startLine: child.startLine,
				endLine: child.endLine,
				language,
				containerName: child.text,
				startByte: child.startByte,
				endByte: child.endByte,
			});
		}
	}
	// Defensive: if the import statement had no recognisable children,
	// emit a single record so the index still records the import line.
	if (out.length === 0 || !out.some((s) => s.path === filePath && s.startLine === lines.startLine)) {
		out.push({
			kind: "import",
			name: sourceText || node.text,
			path: filePath,
			startLine: lines.startLine,
			endLine: lines.endLine,
			language,
			...bytes,
		});
	}
}

/* -------------------------------------------------------------------------- */
/* Rust extractor                                                             */
/* -------------------------------------------------------------------------- */

export const extractRustSymbols: TreeSitterSymbolExtractor = (tree, _source, filePath, language) => {
	const out: SymbolEntry[] = [];
	const implStack: SyntaxNodeLike[] = [];
	walkRust(tree.rootNode, filePath, language, implStack, out);
	return out;
};

function walkRust(
	node: SyntaxNodeLike,
	filePath: string,
	language: string,
	implStack: SyntaxNodeLike[],
	out: SymbolEntry[],
): void {
	const isImpl = node.type === "impl_item";
	if (isImpl) implStack.push(node);
	emitRustNode(node, filePath, language, implStack, out);
	for (const child of node.namedChildren) {
		walkRust(child, filePath, language, implStack, out);
	}
	if (isImpl) implStack.pop();
}

function emitRustNode(
	node: SyntaxNodeLike,
	filePath: string,
	language: string,
	implStack: readonly SyntaxNodeLike[],
	out: SymbolEntry[],
): void {
	const lines = linesOf(node);
	const bytes = { startByte: node.startByte, endByte: node.endByte };
	switch (node.type) {
		case "function_item": {
			const name = node.childForFieldName("name");
			if (name) {
				const isMethod = implStack.length > 0;
				const container = isMethod
					? readRustImplTypeName(implStack[implStack.length - 1] as SyntaxNodeLike)
					: undefined;
				out.push({
					kind: isMethod ? "method" : "function",
					name: name.text,
					path: filePath,
					startLine: lines.startLine,
					endLine: lines.endLine,
					language,
					containerName: container,
					modifiers: collectRustModifiers(node),
					signature: signatureText(node),
					...bytes,
				});
			}
			return;
		}
		case "struct_item": {
			const name = node.childForFieldName("name");
			if (name) {
				out.push({
					kind: "type",
					name: name.text,
					path: filePath,
					startLine: lines.startLine,
					endLine: lines.endLine,
					language,
					modifiers: ["struct"],
					signature: signatureText(node),
					...bytes,
				});
			}
			return;
		}
		case "trait_item": {
			const name = node.childForFieldName("name");
			if (name) {
				out.push({
					kind: "interface",
					name: name.text,
					path: filePath,
					startLine: lines.startLine,
					endLine: lines.endLine,
					language,
					signature: signatureText(node),
					...bytes,
				});
			}
			return;
		}
		case "enum_item": {
			const name = node.childForFieldName("name");
			if (name) {
				out.push({
					kind: "enum",
					name: name.text,
					path: filePath,
					startLine: lines.startLine,
					endLine: lines.endLine,
					language,
					signature: signatureText(node),
					...bytes,
				});
			}
			return;
		}
		case "use_declaration": {
			const arg = node.childForFieldName("argument");
			if (arg) {
				out.push({
					kind: "import",
					name: arg.text,
					path: filePath,
					startLine: lines.startLine,
					endLine: lines.endLine,
					language,
					...bytes,
				});
			}
			return;
		}
		default:
			return;
	}
}

function readRustImplTypeName(node: SyntaxNodeLike): string | undefined {
	const t = node.childForFieldName("type");
	return t?.text;
}

function collectRustModifiers(node: SyntaxNodeLike): string[] | undefined {
	const out: string[] = [];
	for (const child of node.namedChildren) {
		if (child.text === "pub") {
			out.push("pub");
			break;
		}
		if (child.text === "async") {
			out.push("async");
		}
		if (child.text === "unsafe") {
			out.push("unsafe");
		}
		if (child.text === "const") {
			out.push("const");
		}
	}
	return out.length > 0 ? out : undefined;
}

/* -------------------------------------------------------------------------- */
/* Go extractor                                                               */
/* -------------------------------------------------------------------------- */

export const extractGoSymbols: TreeSitterSymbolExtractor = (tree, _source, filePath, language) => {
	const out: SymbolEntry[] = [];
	walkGo(tree.rootNode, filePath, language, out);
	return out;
};

function walkGo(node: SyntaxNodeLike, filePath: string, language: string, out: SymbolEntry[]): void {
	emitGoNode(node, filePath, language, out);
	for (const child of node.namedChildren) {
		walkGo(child, filePath, language, out);
	}
}

function emitGoNode(node: SyntaxNodeLike, filePath: string, language: string, out: SymbolEntry[]): void {
	const lines = linesOf(node);
	const bytes = { startByte: node.startByte, endByte: node.endByte };
	switch (node.type) {
		case "function_declaration": {
			const name = node.childForFieldName("name");
			if (name) {
				out.push({
					kind: "function",
					name: name.text,
					path: filePath,
					startLine: lines.startLine,
					endLine: lines.endLine,
					language,
					signature: signatureText(node),
					...bytes,
				});
			}
			return;
		}
		case "method_declaration": {
			const name = node.childForFieldName("name");
			if (name) {
				const receiver = node.childForFieldName("receiver");
				const receiverType = receiver?.namedChildren.find((c) => c.type === "type_identifier");
				out.push({
					kind: "method",
					name: name.text,
					path: filePath,
					startLine: lines.startLine,
					endLine: lines.endLine,
					language,
					containerName: receiverType?.text,
					signature: signatureText(node),
					...bytes,
				});
			}
			return;
		}
		case "type_declaration": {
			// `type_declaration` contains a `type_spec` child whose
			// first named child is either `struct_type`,
			// `interface_type`, or `type_identifier` (alias).
			for (const child of node.namedChildren) {
				if (child.type !== "type_spec") continue;
				const name = child.childForFieldName("name");
				if (!name) continue;
				const body = child.namedChildren.find((c) => c.type === "struct_type" || c.type === "interface_type");
				const kind: "class" | "interface" | "type" = body
					? body.type === "struct_type"
						? "class"
						: "interface"
					: "type";
				out.push({
					kind,
					name: name.text,
					path: filePath,
					startLine: lines.startLine,
					endLine: lines.endLine,
					language,
					signature: signatureText(node),
					...bytes,
				});
			}
			return;
		}
		case "import_declaration": {
			for (const child of node.namedChildren) {
				if (child.type === "import_spec") {
					const path = child.childForFieldName("path");
					const name = child.childForFieldName("name");
					out.push({
						kind: "import",
						name: unquote(path?.text ?? child.text),
						path: filePath,
						startLine: child.startLine,
						endLine: child.endLine,
						language,
						containerName: name?.text,
						startByte: child.startByte,
						endByte: child.endByte,
					});
				} else if (child.type === "import_spec_list") {
					for (const spec of child.namedChildren) {
						if (spec.type !== "import_spec") continue;
						const path = spec.childForFieldName("path");
						const name = spec.childForFieldName("name");
						out.push({
							kind: "import",
							name: unquote(path?.text ?? spec.text),
							path: filePath,
							startLine: spec.startLine,
							endLine: spec.endLine,
							language,
							containerName: name?.text,
							startByte: spec.startByte,
							endByte: spec.endByte,
						});
					}
				}
			}
			return;
		}
		default:
			return;
	}
}

/* -------------------------------------------------------------------------- */
/* Markdown extractor (line-based, no real tree-sitter grammar)               */
/* -------------------------------------------------------------------------- */

/**
 * A minimal Markdown "tree" implementation that yields
 * `section` (ATX heading) and `fenced_code_block` (```/~~~) nodes.
 *
 * The tree's root is a `document` whose named children are the
 * top-level sections; the rest of the source is implicitly
 * `paragraph` content. The shape is enough for the rest of the
 * pipeline (and tests) to consume without a real tree-sitter
 * Markdown grammar.
 */
class MarkdownRoot implements SyntaxNodeLike {
	readonly type = "document";
	readonly startByte: number;
	readonly endByte: number;
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
	readonly hasError = false;
	readonly isError = false;
	readonly parent: SyntaxNodeLike | null = null;
	readonly children: readonly SyntaxNodeLike[];
	readonly namedChildren: readonly SyntaxNodeLike[];

	constructor(source: string, children: SyntaxNodeLike[]) {
		this.text = source;
		this.startByte = 0;
		this.endByte = Buffer.byteLength(source, "utf-8");
		this.startLine = 1;
		this.endLine = source.length === 0 ? 1 : source.split("\n").length;
		this.children = children;
		this.namedChildren = children;
	}

	childForFieldName(_name: string): SyntaxNodeLike | null {
		return null;
	}
}

class MarkdownNode implements SyntaxNodeLike {
	readonly hasError = false;
	readonly isError = false;
	readonly type: string;
	readonly startByte: number;
	readonly endByte: number;
	readonly startLine: number;
	readonly endLine: number;
	parent: SyntaxNodeLike;
	readonly children: readonly SyntaxNodeLike[];
	readonly namedChildren: readonly SyntaxNodeLike[];
	readonly text: string;

	constructor(
		parent: SyntaxNodeLike,
		type: string,
		startByte: number,
		endByte: number,
		startLine: number,
		endLine: number,
		text: string,
		children: readonly SyntaxNodeLike[] = [],
	) {
		this.type = type;
		this.startByte = startByte;
		this.endByte = endByte;
		this.startLine = startLine;
		this.endLine = endLine;
		this.parent = parent;
		this.text = text;
		this.children = children;
		this.namedChildren = children;
	}

	childForFieldName(name: string): SyntaxNodeLike | null {
		for (const child of this.namedChildren) {
			if (child.type === name) return child;
		}
		return null;
	}
}

function parseMarkdownTree(source: string): SyntaxTreeLike {
	const lines = source.split("\n");
	const nodes: SyntaxNodeLike[] = [];
	let inFence = false;
	let fenceMarker = "";
	let fenceStartLine = 0;
	let fenceLang = "";
	let fenceStartByte = 0;
	let byteOffset = 0;
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		const lineStartByte = byteOffset;
		const lineEndByte = lineStartByte + Buffer.byteLength(line, "utf-8");
		const fenceMatch = /^( {0,3})(`{3,}|~{3,})([^\s`~]*)/.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[2] ?? "";
			const lang = fenceMatch[3] ?? "";
			if (!inFence) {
				inFence = true;
				fenceMarker = (marker[0] ?? "`") as "`" | "~";
				fenceStartLine = i + 1;
				fenceStartByte = lineStartByte;
				fenceLang = lang;
			} else if (marker.startsWith(fenceMarker) && marker.length >= fenceMarker.length) {
				const blockEndByte = lineEndByte;
				const blockText = source.slice(fenceStartByte, blockEndByte);
				nodes.push(
					new MarkdownNode(
						null as unknown as SyntaxNodeLike, // parent set below
						"fenced_code_block",
						fenceStartByte,
						blockEndByte,
						fenceStartLine,
						i + 1,
						blockText,
						fenceLang
							? [
									new MarkdownNode(
										null as unknown as SyntaxNodeLike,
										"info_string",
										fenceStartByte,
										lineEndByte,
										fenceStartLine,
										i + 1,
										fenceLang,
									),
								]
							: [],
					),
				);
				inFence = false;
				fenceMarker = "";
				fenceLang = "";
				fenceStartByte = 0;
			}
		} else if (!inFence) {
			const headingMatch = /^(?<hashes>#{1,6})\s+(?<text>.+?)\s*#*\s*$/.exec(line);
			if (headingMatch?.groups) {
				const hashes = headingMatch.groups.hashes ?? "";
				const headingText = headingMatch.groups.text ?? "";
				nodes.push(
					new MarkdownNode(
						null as unknown as SyntaxNodeLike,
						"section",
						lineStartByte,
						lineEndByte,
						i + 1,
						i + 1,
						`${hashes} ${headingText}`,
						[
							new MarkdownNode(
								null as unknown as SyntaxNodeLike,
								"inline",
								lineStartByte,
								lineEndByte,
								i + 1,
								i + 1,
								headingText,
							),
						],
					),
				);
			}
		}
		byteOffset = lineEndByte + 1; // +1 for the newline
	}
	if (inFence) {
		const lastLine = source.length === 0 ? 1 : source.split("\n").length;
		const blockEndByte = source.length;
		nodes.push(
			new MarkdownNode(
				null as unknown as SyntaxNodeLike,
				"fenced_code_block",
				fenceStartByte,
				blockEndByte,
				fenceStartLine,
				lastLine,
				source.slice(fenceStartByte, blockEndByte),
				fenceLang
					? [
							new MarkdownNode(
								null as unknown as SyntaxNodeLike,
								"info_string",
								fenceStartByte,
								blockEndByte,
								fenceStartLine,
								lastLine,
								fenceLang,
							),
						]
					: [],
			),
		);
	}
	// Wire parents (forward reference; we now have the root).
	const root = new MarkdownRoot(source, nodes);
	for (const node of nodes) {
		(node as MarkdownNode).parent = root;
		for (const child of (node as MarkdownNode).namedChildren) {
			(child as MarkdownNode).parent = node;
		}
	}
	return { rootNode: root, source, language: null };
}

export const extractMarkdownSymbols: TreeSitterSymbolExtractor = (tree, _source, filePath, language) => {
	const out: SymbolEntry[] = [];
	for (const node of tree.rootNode.namedChildren) {
		const lines = linesOf(node);
		const bytes = { startByte: node.startByte, endByte: node.endByte };
		if (node.type === "section") {
			const inline = node.namedChildren.find((c) => c.type === "inline");
			const headingText = inline?.text ?? node.text;
			const levelMatch = /^(#{1,6})/.exec(node.text);
			const level = levelMatch ? (levelMatch[1]?.length ?? 1) : 1;
			out.push({
				kind: "heading",
				name: headingText,
				path: filePath,
				startLine: lines.startLine,
				endLine: lines.endLine,
				language,
				modifiers: [`h${level}`],
				...bytes,
			});
			continue;
		}
		if (node.type === "fenced_code_block") {
			const info = node.namedChildren.find((c) => c.type === "info_string");
			out.push({
				kind: "code-block",
				name: info?.text ?? "",
				path: filePath,
				startLine: lines.startLine,
				endLine: lines.endLine,
				language,
				modifiers: ["fenced"],
				...bytes,
			});
		}
	}
	return out;
};

/**
 * Standalone Markdown tree builder exposed for tests. Production
 * code reaches the same tree through `parseSourceWithLanguage`
 * with a Markdown binding registered below.
 */
export function parseMarkdown(source: string): SyntaxTreeLike {
	return parseMarkdownTree(source);
}

/* -------------------------------------------------------------------------- */
/* Sentinel language (used for the Markdown entry — no real grammar)          */
/* -------------------------------------------------------------------------- */

const MARKDOWN_BINDING: TreeSitterLanguageBinding = {
	// The Markdown binding does not use the tree-sitter engine; it
	// supplies a sentinel `null`-like language and routes parsing
	// through `parseMarkdown`. The dispatcher in
	// `tree-sitter-syntax-index.ts` checks for the sentinel and
	// dispatches to `parseMarkdown` directly.
	language: null as unknown as TreeSitterLanguage,
	extract: extractMarkdownSymbols,
};

/**
 * Marker the dispatcher uses to recognise the Markdown binding
 * (which does not use a real `Parser.Language`). Tests that
 * register a real grammar for `"markdown"` will overwrite this.
 */
export const MARKDOWN_LANGUAGE_TAG = "markdown";
export const MARKDOWN_SENTINEL = MARKDOWN_BINDING;

/* -------------------------------------------------------------------------- */
/* Default registrations                                                      */
/* -------------------------------------------------------------------------- */

let didRegisterDefaults = false;

/**
 * Idempotently register the languages that ship with this module.
 * Currently only Markdown — the other languages need an external
 * `tree-sitter-{lang}` package to be installed and registered
 * manually.
 */
export function ensureDefaultTreeSitterLanguages(): void {
	if (didRegisterDefaults) return;
	registry.set(MARKDOWN_LANGUAGE_TAG, MARKDOWN_BINDING);
	didRegisterDefaults = true;
}

/* -------------------------------------------------------------------------- */
/* Convenience: entry used by `tree-sitter-syntax-index.ts`                   */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the language binding for a manifest entry. Returns `null`
 * when the entry has no language or no binding is registered.
 */
export function bindingForEntry(entry: FileManifestEntry): TreeSitterLanguageBinding | null {
	if (!entry.language) return null;
	ensureDefaultTreeSitterLanguages();
	return registry.get(entry.language) ?? null;
}

