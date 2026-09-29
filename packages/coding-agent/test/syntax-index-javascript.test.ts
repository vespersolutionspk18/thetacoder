/**
 * F1 syntax index — JavaScript extractor coverage.
 *
 * JS should produce the same declarations as TS minus
 * `interface` / `type` / `enum`.
 */

import { describe, expect, it } from "vitest";
import { extractJavaScriptSymbols } from "../src/core/repository/syntax-index.ts";

const FIXTURE = [
	"function noop() {}", // 1
	"export class Box {", // 2
	"  open() { return 1; }", // 3
	"}", // 4
	"const value = 1;", // 5
	"import lib from './lib';", // 6
	"export { value };", // 7
	"export default function helper() {}", // 8
	// The following TS-only constructs should NOT produce entries:
	"interface IDoNotExist {}", // 9
	"type TAlsoNo = number;", // 10
	"enum ENoEither { A }", // 11
].join("\n");

describe("extractJavaScriptSymbols", () => {
	const symbols = extractJavaScriptSymbols(FIXTURE, "fixture.js", "javascript");

	it("extracts a top-level function", () => {
		const f = symbols.find((s) => s.name === "noop" && s.kind === "function");
		expect(f).toBeDefined();
		expect(f?.startLine).toBe(1);
	});

	it("extracts a class with a method", () => {
		const c = symbols.find((s) => s.name === "Box" && s.kind === "class");
		expect(c).toBeDefined();
		expect(c?.endLine).toBe(4);
		const m = symbols.find((s) => s.kind === "method" && s.name === "open" && s.containerName === "Box");
		expect(m).toBeDefined();
	});

	it("extracts a const variable", () => {
		const v = symbols.find((s) => s.name === "value" && s.kind === "variable");
		expect(v).toBeDefined();
		expect(v?.modifiers).toContain("const");
	});

	it("extracts a default import", () => {
		const i = symbols.find((s) => s.kind === "import" && s.name === "./lib" && s.modifiers?.includes("default"));
		expect(i).toBeDefined();
	});

	it("extracts a named export", () => {
		const e = symbols.find((s) => s.kind === "export" && s.name === "value" && s.modifiers?.includes("named"));
		expect(e).toBeDefined();
	});

	it("extracts an export default function with name", () => {
		const e = symbols.find((s) => s.kind === "export" && s.name === "helper" && s.modifiers?.includes("default"));
		expect(e).toBeDefined();
	});

	it("does NOT produce interface, type, or enum entries", () => {
		const kinds = new Set(symbols.map((s) => s.kind));
		expect(kinds.has("interface")).toBe(false);
		expect(kinds.has("type")).toBe(false);
		expect(kinds.has("enum")).toBe(false);
	});
});

