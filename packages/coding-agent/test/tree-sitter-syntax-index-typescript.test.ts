/**
 * F1 syntax service — tree-sitter TypeScript extractor coverage.
 *
 * The extractor walks a real tree-sitter syntax tree. The tests
 * below build a small synthetic tree (matching the structural
 * shape the `tree-sitter-typescript` grammar produces) and feed it
 * through the extractor, asserting the produced `SymbolEntry`
 * records carry the right kind, name, line range, and byte range.
 *
 * Byte ranges are the headline difference between the tree-sitter
 * path and the regex fallback — these tests assert they are
 * populated.
 */

import { describe, expect, it } from "vitest";
import {
	extractTypeScriptJavaScriptSymbols,
	listRegisteredTreeSitterLanguages,
	registerTreeSitterLanguage,
	type SyntaxNodeLike,
	type SyntaxTreeLike,
	unregisterTreeSitterLanguage,
} from "../src/core/repository/tree-sitter-languages.ts";
import type { TreeSitterLanguage } from "../src/core/repository/tree-sitter-parser.ts";

/* -------------------------------------------------------------------------- */
/* Synthetic tree builder                                                     */
/* -------------------------------------------------------------------------- */

class TestNode implements SyntaxNodeLike {
	readonly type: string;
	readonly startByte: number;
	readonly endByte: number;
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
	readonly hasError: boolean;
	readonly isError: boolean;
	parent: SyntaxNodeLike | null;
	readonly children: SyntaxNodeLike[];
	readonly namedChildren: SyntaxNodeLike[];
	readonly fields: Map<string, SyntaxNodeLike> = new Map();

	constructor(init: {
		type: string;
		startByte: number;
		endByte: number;
		startLine: number;
		endLine: number;
		text: string;
		hasError?: boolean;
		isError?: boolean;
		children?: SyntaxNodeLike[];
	}) {
		this.type = init.type;
		this.startByte = init.startByte;
		this.endByte = init.endByte;
		this.startLine = init.startLine;
		this.endLine = init.endLine;
		this.text = init.text;
		this.hasError = init.hasError ?? false;
		this.isError = init.isError ?? false;
		this.parent = null;
		this.children = init.children ?? [];
		this.namedChildren = this.children;
		for (const child of this.children) {
			if (child.parent === null) (child as TestNode).parent = this;
			// Inherit field names tagged on the child: this lets us
			// build `field("name", ident(...))` chains that resolve
			// correctly on the eventual parent.
			const childFields = (child as TestNode).fields;
			if (childFields) {
				for (const [k, v] of childFields) {
					if (!this.fields.has(k)) this.fields.set(k, v);
				}
			}
		}
	}

	childForFieldName(name: string): SyntaxNodeLike | null {
		return this.fields.get(name) ?? null;
	}
}

/**
 * Mark `node` as a field child. The next `TestNode` that includes
 * `node` in its `children` array will record the field on itself,
 * mirroring tree-sitter's field-name metadata.
 */
function field(name: string, node: TestNode): TestNode {
	node.fields.set(name, node);
	return node;
}

function ident(text: string, startByte: number, endByte: number, startLine: number, endLine: number): TestNode {
	return new TestNode({ type: "identifier", text, startByte, endByte, startLine, endLine });
}

/* -------------------------------------------------------------------------- */
/* Fixture: a small TypeScript module                                          */
/* -------------------------------------------------------------------------- */

function buildTypeScriptTree(): SyntaxTreeLike {
	// Source: a trimmed-down version of the existing
	// `syntax-index-typescript.test.ts` fixture, with line and byte
	// positions computed by hand.
	const src = [
		"// top of file",
		"import { foo } from './foo';",
		"export class Widget {",
		"  greet(name: string): string { return 'hi ' + name; }",
		"}",
		"export const answer = 42;",
		"export function helper(): number { return 1; }",
	].join("\n");

	// Byte offsets are computed by summing UTF-8 byte lengths line by line.
	const lines = src.split("\n");
	const lineStartBytes: number[] = [];
	let acc = 0;
	for (const line of lines) {
		lineStartBytes.push(acc);
		acc += Buffer.byteLength(line, "utf-8") + 1; // +1 for the newline
	}
	const startOf = (lineIdx: number, col: number): number => lineStartBytes[lineIdx] + col;
	const endOf = (lineIdx: number, col: number): number => lineStartBytes[lineIdx] + col;

	// line 1: `// top of file`
	// line 2: `import { foo } from './foo';`
	{
		const lineIdx = 1;
		const importText = "import { foo } from './foo';";
		const importStart = startOf(lineIdx, 0);
		const importEnd = endOf(lineIdx, importText.length);

		// Build `import { foo } from './foo';` children:
		// `import` keyword, `{`, `foo` identifier, `}`, `from` keyword, `string` (the specifier), `;`
		const importKeyword = new TestNode({
			type: "import",
			text: "import",
			startByte: startOf(lineIdx, 0),
			endByte: endOf(lineIdx, 6),
			startLine: 2,
			endLine: 2,
		});
		const importClause = new TestNode({
			type: "import_clause",
			text: "{ foo }",
			startByte: startOf(lineIdx, 7),
			endByte: endOf(lineIdx, 14),
			startLine: 2,
			endLine: 2,
			children: [
				new TestNode({
					type: "{",
					text: "{",
					startByte: startOf(lineIdx, 7),
					endByte: endOf(lineIdx, 8),
					startLine: 2,
					endLine: 2,
				}),
				new TestNode({
					type: "named_imports",
					text: " foo ",
					startByte: startOf(lineIdx, 8),
					endByte: endOf(lineIdx, 13),
					startLine: 2,
					endLine: 2,
					children: [
						new TestNode({
							type: "import_specifier",
							text: " foo",
							startByte: startOf(lineIdx, 9),
							endByte: endOf(lineIdx, 13),
							startLine: 2,
							endLine: 2,
							children: [field("name", ident("foo", startOf(lineIdx, 9), endOf(lineIdx, 12), 2, 2))],
						}),
					],
				}),
				new TestNode({
					type: "}",
					text: "}",
					startByte: startOf(lineIdx, 13),
					endByte: endOf(lineIdx, 14),
					startLine: 2,
					endLine: 2,
				}),
			],
		});
		const fromKeyword = new TestNode({
			type: "from",
			text: "from",
			startByte: startOf(lineIdx, 15),
			endByte: endOf(lineIdx, 19),
			startLine: 2,
			endLine: 2,
		});
		const stringNode = new TestNode({
			type: "string",
			text: "'./foo'",
			startByte: startOf(lineIdx, 20),
			endByte: endOf(lineIdx, 27),
			startLine: 2,
			endLine: 2,
		});
		const importStatement = new TestNode({
			type: "import_statement",
			text: importText,
			startByte: importStart,
			endByte: importEnd,
			startLine: 2,
			endLine: 2,
			children: [importKeyword, importClause, fromKeyword, stringNode],
		});
		// (we attach the import statement below)

		// line 3: `export class Widget {`
		const classText = "export class Widget {";
		const classStart = startOf(2, 0);
		const classEnd = endOf(2, classText.length - 1);
		const exportKw = new TestNode({
			type: "export",
			text: "export",
			startByte: startOf(2, 0),
			endByte: endOf(2, 6),
			startLine: 3,
			endLine: 3,
		});
		const classKw = new TestNode({
			type: "class",
			text: "class",
			startByte: startOf(2, 7),
			endByte: endOf(2, 12),
			startLine: 3,
			endLine: 3,
		});
		const className = field(
			"name",
			new TestNode({
				type: "type_identifier",
				text: "Widget",
				startByte: startOf(2, 13),
				endByte: endOf(2, 19),
				startLine: 3,
				endLine: 3,
			}),
		);
		const classOpenBrace = new TestNode({
			type: "{",
			text: "{",
			startByte: startOf(2, 20),
			endByte: endOf(2, 21),
			startLine: 3,
			endLine: 3,
		});
		// line 4: `  greet(name: string): string { return 'hi ' + name; }`
		const methodText = "greet(name: string): string { return 'hi ' + name; }";
		const methodStart = startOf(3, 2);
		const methodEnd = endOf(3, methodText.length + 2);
		const methodName = field(
			"name",
			new TestNode({
				type: "property_identifier",
				text: "greet",
				startByte: startOf(3, 2),
				endByte: endOf(3, 7),
				startLine: 4,
				endLine: 4,
			}),
		);
		const methodBody = new TestNode({
			type: "statement_block",
			text: " { return 'hi ' + name; }",
			startByte: startOf(3, 25),
			endByte: endOf(3, methodText.length + 2),
			startLine: 4,
			endLine: 4,
		});
		const methodDefinition = new TestNode({
			type: "method_definition",
			text: methodText,
			startByte: methodStart,
			endByte: methodEnd,
			startLine: 4,
			endLine: 4,
			children: [methodName, methodBody],
		});
		const classBody = new TestNode({
			type: "class_body",
			text: "",
			startByte: methodStart,
			endByte: methodEnd,
			startLine: 4,
			endLine: 4,
			children: [methodDefinition],
		});
		const classCloseBrace = new TestNode({
			type: "}",
			text: "}",
			startByte: startOf(4, 0),
			endByte: endOf(4, 1),
			startLine: 5,
			endLine: 5,
		});
		const classDeclaration = new TestNode({
			type: "class_declaration",
			text: classText,
			startByte: classStart,
			endByte: classEnd + methodText.length + 2 + 1, // include body and closing brace
			startLine: 3,
			endLine: 5,
			children: [exportKw, classKw, className, classOpenBrace, classBody, classCloseBrace],
		});

		// line 6: `export const answer = 42;`
		const constText = "export const answer = 42;";
		const constStart = startOf(5, 0);
		const constEnd = endOf(5, constText.length);
		const exportKw2 = new TestNode({
			type: "export",
			text: "export",
			startByte: startOf(5, 0),
			endByte: endOf(5, 6),
			startLine: 6,
			endLine: 6,
		});
		const constKw = new TestNode({
			type: "const",
			text: "const",
			startByte: startOf(5, 7),
			endByte: endOf(5, 12),
			startLine: 6,
			endLine: 6,
		});
		const declaratorName = field("name", ident("answer", startOf(5, 13), endOf(5, 19), 6, 6));
		const variableDeclarator = new TestNode({
			type: "variable_declarator",
			text: "answer = 42",
			startByte: startOf(5, 13),
			endByte: endOf(5, 23),
			startLine: 6,
			endLine: 6,
			children: [declaratorName],
		});
		const lexicalDecl = new TestNode({
			type: "lexical_declaration",
			text: constText,
			startByte: constStart,
			endByte: constEnd,
			startLine: 6,
			endLine: 6,
			children: [exportKw2, constKw, variableDeclarator],
		});

		// line 7: `export function helper(): number { return 1; }`
		const funcText = "export function helper(): number { return 1; }";
		const funcStart = startOf(6, 0);
		const funcEnd = endOf(6, funcText.length);
		const exportKw3 = new TestNode({
			type: "export",
			text: "export",
			startByte: startOf(6, 0),
			endByte: endOf(6, 6),
			startLine: 7,
			endLine: 7,
		});
		const functionKw = new TestNode({
			type: "function",
			text: "function",
			startByte: startOf(6, 7),
			endByte: endOf(6, 15),
			startLine: 7,
			endLine: 7,
		});
		const helperName = field("name", ident("helper", startOf(6, 16), endOf(6, 22), 7, 7));
		const funcBody = new TestNode({
			type: "statement_block",
			text: " { return 1; }",
			startByte: startOf(6, 35),
			endByte: endOf(6, funcText.length),
			startLine: 7,
			endLine: 7,
		});
		const functionDecl = new TestNode({
			type: "function_declaration",
			text: funcText,
			startByte: funcStart,
			endByte: funcEnd,
			startLine: 7,
			endLine: 7,
			children: [exportKw3, functionKw, helperName, funcBody],
		});

		const programChildren = [importStatement, classDeclaration, lexicalDecl, functionDecl];
		const program = new TestNode({
			type: "program",
			text: src,
			startByte: 0,
			endByte: Buffer.byteLength(src, "utf-8"),
			startLine: 1,
			endLine: 7,
			children: programChildren,
		});
		return {
			rootNode: program,
			source: src,
			language: null as unknown as TreeSitterLanguage,
		};
	}
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("extractTypeScriptJavaScriptSymbols — synthetic tree", () => {
	const tree = buildTypeScriptTree();
	const symbols = extractTypeScriptJavaScriptSymbols(tree, tree.source, "fixture.ts", "typescript");

	it("extracts a named function with the export modifier", () => {
		const f = symbols.find((s) => s.name === "helper" && s.kind === "function");
		expect(f).toBeDefined();
		expect(f?.modifiers).toContain("export");
		expect(f?.startLine).toBe(7);
		expect(f?.endLine).toBe(7);
		// Tree-sitter populates byte ranges; the regex fallback does not.
		expect(typeof f?.startByte).toBe("number");
		expect(typeof f?.endByte).toBe("number");
	});

	it("extracts a class with its method (containerName set)", () => {
		const c = symbols.find((s) => s.name === "Widget" && s.kind === "class");
		expect(c).toBeDefined();
		expect(c?.modifiers).toContain("export");
		expect(c?.startLine).toBe(3);
		expect(c?.endLine).toBe(5);

		const m = symbols.find((s) => s.name === "greet" && s.kind === "method");
		expect(m).toBeDefined();
		expect(m?.containerName).toBe("Widget");
		expect(m?.startLine).toBe(4);
	});

	it("extracts a top-level `const` as a variable with `export` + `const` modifiers", () => {
		const v = symbols.find((s) => s.name === "answer" && s.kind === "variable");
		expect(v).toBeDefined();
		expect(v?.modifiers).toEqual(expect.arrayContaining(["export", "const"]));
	});

	it("extracts a named import with the source as the name and local binding as containerName", () => {
		const i = symbols.find((s) => s.kind === "import" && s.modifiers?.includes("named") && s.containerName === "foo");
		expect(i).toBeDefined();
		expect(i?.name).toBe("./foo");
		expect(i?.startLine).toBe(2);
	});

	it("emits byte ranges that span the source node", () => {
		const f = symbols.find((s) => s.name === "helper" && s.kind === "function");
		expect(f).toBeDefined();
		const src = tree.source;
		const start = f?.startByte ?? 0;
		const end = f?.endByte ?? 0;
		const text = src.slice(start, end);
		expect(text.startsWith("export function helper")).toBe(true);
		expect(text.endsWith("}")).toBe(true);
	});

	it("populates startByte/endByte for every emitted symbol", () => {
		for (const s of symbols) {
			expect(typeof s.startByte).toBe("number");
			expect(typeof s.endByte).toBe("number");
			expect(s.endByte).toBeGreaterThanOrEqual(s.startByte ?? 0);
		}
	});
});

describe("extractTypeScriptJavaScriptSymbols — JavaScript filter", () => {
	const tree = buildTypeScriptTree();

	it("drops interface / type / enum records when language is 'javascript'", () => {
		// Add a couple of TS-only kinds to the tree.
		const interfaceDecl = new TestNode({
			type: "interface_declaration",
			text: "interface Shape {}",
			startByte: 0,
			endByte: 20,
			startLine: 1,
			endLine: 1,
			children: [
				new TestNode({
					type: "interface",
					text: "interface",
					startByte: 0,
					endByte: 9,
					startLine: 1,
					endLine: 1,
				}),
				field(
					"name",
					new TestNode({
						type: "type_identifier",
						text: "Shape",
						startByte: 10,
						endByte: 15,
						startLine: 1,
						endLine: 1,
					}),
				),
			],
		});
		// `tree.rootNode.children` is readonly; we wrap in a new tree.
		const wrappedRoot = new TestNode({
			type: tree.rootNode.type,
			text: tree.rootNode.text,
			startByte: tree.rootNode.startByte,
			endByte: tree.rootNode.endByte,
			startLine: tree.rootNode.startLine,
			endLine: tree.rootNode.endLine,
			children: [...tree.rootNode.namedChildren, interfaceDecl],
		});
		const wrapped: SyntaxTreeLike = {
			rootNode: wrappedRoot,
			source: tree.source,
			language: null as unknown as TreeSitterLanguage,
		};
		const ts = extractTypeScriptJavaScriptSymbols(wrapped, wrapped.source, "fixture.ts", "typescript");
		const js = extractTypeScriptJavaScriptSymbols(wrapped, wrapped.source, "fixture.ts", "javascript");
		expect(ts.find((s) => s.name === "Shape" && s.kind === "interface")).toBeDefined();
		expect(js.find((s) => s.name === "Shape" && s.kind === "interface")).toBeUndefined();
	});
});

describe("registerTreeSitterLanguage", () => {
	it("round-trips a registered binding", () => {
		const sentinel = { language: "X" } as unknown as TreeSitterLanguage;
		const binding = {
			language: sentinel,
			extract: () => [],
		};
		registerTreeSitterLanguage("__test_roundtrip__", binding);
		try {
			const names = listRegisteredTreeSitterLanguages();
			expect(names).toContain("__test_roundtrip__");
		} finally {
			unregisterTreeSitterLanguage("__test_roundtrip__");
		}
	});
});

