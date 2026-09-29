/**
 * F1 syntax service — tree-sitter Rust extractor coverage.
 *
 * Covers functions, structs, traits, impls, enums, and `use`
 * declarations. Methods inside `impl` blocks are emitted with
 * `containerName` set to the impl's type — this is the headline
 * difference vs. the regex fallback, which cannot easily see
 * `impl` boundaries.
 */

import { describe, expect, it } from "vitest";
import {
	extractRustSymbols,
	type SyntaxNodeLike,
	type SyntaxTreeLike,
} from "../src/core/repository/tree-sitter-languages.ts";
import type { TreeSitterLanguage } from "../src/core/repository/tree-sitter-parser.ts";

/* -------------------------------------------------------------------------- */
/* Synthetic tree helpers                                                     */
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

function field(name: string, node: TestNode): TestNode {
	node.fields.set(name, node);
	return node;
}

function ident(text: string, startByte: number, endByte: number, startLine: number, endLine: number): TestNode {
	return new TestNode({ type: "identifier", text, startByte, endByte, startLine, endLine });
}

/* -------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

function buildRustTree(): SyntaxTreeLike {
	const src = [
		"use std::collections::HashMap;", // 1
		"use crate::models::User;", // 2
		"", // 3
		"pub fn free_function() -> i32 { 42 }", // 4
		"", // 5
		"pub struct Point {", // 6
		"    pub x: f64,", // 7
		"    pub y: f64,", // 8
		"}", // 9
		"", // 10
		"pub trait Greet {", // 11
		"    fn greet(&self) -> String;", // 12
		"}", // 13
		"", // 14
		"impl Point {", // 15
		"    pub fn new(x: f64, y: f64) -> Self { Self { x, y } }", // 16
		"    pub fn length(&self) -> f64 { 1.0 }", // 17
		"}", // 18
		"", // 19
		"pub enum Color { Red, Green, Blue }", // 20
	].join("\n");

	const lines = src.split("\n");
	const lineStartBytes: number[] = [];
	let acc = 0;
	for (const line of lines) {
		lineStartBytes.push(acc);
		acc += Buffer.byteLength(line, "utf-8") + 1;
	}
	const startOf = (lineIdx: number, col: number): number => lineStartBytes[lineIdx] + col;

	// line 1: `use std::collections::HashMap;`
	const use1Text = "use std::collections::HashMap;";
	const use1Arg = new TestNode({
		type: "scoped_identifier",
		text: "std::collections::HashMap",
		startByte: startOf(0, 4),
		endByte: startOf(0, 30),
		startLine: 1,
		endLine: 1,
	});
	const use1 = new TestNode({
		type: "use_declaration",
		text: use1Text,
		startByte: startOf(0, 0),
		endByte: startOf(0, use1Text.length),
		startLine: 1,
		endLine: 1,
		children: [field("argument", use1Arg)],
	});

	// line 2: `use crate::models::User;`
	const use2Text = "use crate::models::User;";
	const use2Arg = new TestNode({
		type: "scoped_identifier",
		text: "crate::models::User",
		startByte: startOf(1, 4),
		endByte: startOf(1, 22),
		startLine: 2,
		endLine: 2,
	});
	const use2 = new TestNode({
		type: "use_declaration",
		text: use2Text,
		startByte: startOf(1, 0),
		endByte: startOf(1, use2Text.length),
		startLine: 2,
		endLine: 2,
		children: [field("argument", use2Arg)],
	});

	// line 4: `pub fn free_function() -> i32 { 42 }`
	const fnText = "pub fn free_function() -> i32 { 42 }";
	const fnName = field("name", ident("free_function", startOf(3, 7), startOf(3, 20), 4, 4));
	const fnBody = new TestNode({
		type: "block",
		text: "{ 42 }",
		startByte: startOf(3, 28),
		endByte: startOf(3, fnText.length),
		startLine: 4,
		endLine: 4,
	});
	const pubKw = new TestNode({
		type: "visibility_modifier",
		text: "pub",
		startByte: startOf(3, 0),
		endByte: startOf(3, 3),
		startLine: 4,
		endLine: 4,
	});
	const freeFn = new TestNode({
		type: "function_item",
		text: fnText,
		startByte: startOf(3, 0),
		endByte: startOf(3, fnText.length),
		startLine: 4,
		endLine: 4,
		children: [pubKw, fnName, fnBody],
	});

	// line 6: `pub struct Point {` ... line 9: `}`
	const structName = field("name", ident("Point", startOf(5, 11), startOf(5, 16), 6, 6));
	const structBody = new TestNode({
		type: "field_declaration_list",
		text: "{\n    pub x: f64,\n    pub y: f64,\n}",
		startByte: startOf(5, 17),
		endByte: startOf(8, 1),
		startLine: 6,
		endLine: 9,
	});
	const structItem = new TestNode({
		type: "struct_item",
		text: "pub struct Point { ... }",
		startByte: startOf(5, 0),
		endByte: startOf(8, 1),
		startLine: 6,
		endLine: 9,
		children: [pubKw, structName, structBody],
	});

	// line 11: `pub trait Greet {` ... line 13: `}`
	const traitName = field("name", ident("Greet", startOf(10, 10), startOf(10, 15), 11, 11));
	const traitBody = new TestNode({
		type: "declaration_list",
		text: "{\n    fn greet(&self) -> String;\n}",
		startByte: startOf(10, 16),
		endByte: startOf(12, 1),
		startLine: 11,
		endLine: 13,
	});
	const traitItem = new TestNode({
		type: "trait_item",
		text: "pub trait Greet { ... }",
		startByte: startOf(10, 0),
		endByte: startOf(12, 1),
		startLine: 11,
		endLine: 13,
		children: [pubKw, traitName, traitBody],
	});

	// line 15: `impl Point {` ... line 18: `}`
	// line 16: `    pub fn new(x: f64, y: f64) -> Self { Self { x, y } }`
	const newFnName = field("name", ident("new", startOf(15, 11), startOf(15, 14), 16, 16));
	const newFnBody = new TestNode({
		type: "block",
		text: "{ Self { x, y } }",
		startByte: startOf(15, 35),
		endByte: startOf(15, 50),
		startLine: 16,
		endLine: 16,
	});
	const newFn = new TestNode({
		type: "function_item",
		text: "pub fn new(x: f64, y: f64) -> Self { Self { x, y } }",
		startByte: startOf(15, 4),
		endByte: startOf(15, 50),
		startLine: 16,
		endLine: 16,
		children: [pubKw, newFnName, newFnBody],
	});
	// line 17: `    pub fn length(&self) -> f64 { 1.0 }`
	const lengthName = field("name", ident("length", startOf(16, 11), startOf(16, 17), 17, 17));
	const lengthBody = new TestNode({
		type: "block",
		text: "{ 1.0 }",
		startByte: startOf(16, 27),
		endByte: startOf(16, 34),
		startLine: 17,
		endLine: 17,
	});
	const lengthFn = new TestNode({
		type: "function_item",
		text: "pub fn length(&self) -> f64 { 1.0 }",
		startByte: startOf(16, 4),
		endByte: startOf(16, 34),
		startLine: 17,
		endLine: 17,
		children: [pubKw, lengthName, lengthBody],
	});
	const implType = field("type", ident("Point", startOf(14, 5), startOf(14, 10), 15, 15));
	const implBody = new TestNode({
		type: "declaration_list",
		text: "{ newFn, lengthFn }",
		startByte: startOf(14, 11),
		endByte: startOf(17, 1),
		startLine: 15,
		endLine: 18,
		children: [newFn, lengthFn],
	});
	const implItem = new TestNode({
		type: "impl_item",
		text: "impl Point { ... }",
		startByte: startOf(14, 0),
		endByte: startOf(17, 1),
		startLine: 15,
		endLine: 18,
		children: [implType, implBody],
	});

	// line 20: `pub enum Color { Red, Green, Blue }`
	const enumName = field("name", ident("Color", startOf(19, 9), startOf(19, 14), 20, 20));
	const enumBody = new TestNode({
		type: "enum_variant_list",
		text: "{ Red, Green, Blue }",
		startByte: startOf(19, 15),
		endByte: startOf(19, 35),
		startLine: 20,
		endLine: 20,
	});
	const enumItem = new TestNode({
		type: "enum_item",
		text: "pub enum Color { Red, Green, Blue }",
		startByte: startOf(19, 0),
		endByte: startOf(19, 35),
		startLine: 20,
		endLine: 20,
		children: [pubKw, enumName, enumBody],
	});

	const sourceFile = new TestNode({
		type: "source_file",
		text: src,
		startByte: 0,
		endByte: Buffer.byteLength(src, "utf-8"),
		startLine: 1,
		endLine: 20,
		children: [use1, use2, freeFn, structItem, traitItem, implItem, enumItem],
	});
	return {
		rootNode: sourceFile,
		source: src,
		language: null as unknown as TreeSitterLanguage,
	};
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("extractRustSymbols — synthetic tree", () => {
	const tree = buildRustTree();
	const symbols = extractRustSymbols(tree, tree.source, "fixture.rs", "rust");

	it("extracts `use` declarations as import records", () => {
		const imports = symbols.filter((s) => s.kind === "import");
		expect(imports.length).toBe(2);
		const names = imports.map((s) => s.name).sort();
		expect(names).toEqual(["crate::models::User", "std::collections::HashMap"]);
	});

	it("extracts a top-level free function as `function` with the `pub` modifier", () => {
		const f = symbols.find((s) => s.name === "free_function" && s.kind === "function");
		expect(f).toBeDefined();
		expect(f?.modifiers).toContain("pub");
		expect(f?.startLine).toBe(4);
	});

	it("extracts a `struct` as a `type` with the `struct` modifier", () => {
		const s = symbols.find((s) => s.name === "Point" && s.kind === "type");
		expect(s).toBeDefined();
		expect(s?.modifiers).toContain("struct");
	});

	it("extracts a `trait` as an `interface`", () => {
		const t = symbols.find((s) => s.name === "Greet" && s.kind === "interface");
		expect(t).toBeDefined();
	});

	it("extracts a free `enum` declaration", () => {
		const e = symbols.find((s) => s.name === "Color" && s.kind === "enum");
		expect(e).toBeDefined();
	});

	it("extracts functions inside an `impl` block as methods with `containerName`", () => {
		const methods = symbols.filter((s) => s.kind === "method" && s.containerName === "Point");
		expect(methods.length).toBe(2);
		const names = methods.map((m) => m.name).sort();
		expect(names).toEqual(["length", "new"]);
	});

	it("populates startByte / endByte on every emitted symbol", () => {
		for (const s of symbols) {
			expect(typeof s.startByte).toBe("number");
			expect(typeof s.endByte).toBe("number");
			expect(s.endByte).toBeGreaterThanOrEqual(s.startByte ?? 0);
		}
	});
});

