/**
 * F1 syntax index — Python extractor coverage.
 *
 * Covers def, class, import, from-import, and module-level assignment.
 */

import { describe, expect, it } from "vitest";
import { extractPythonSymbols } from "../src/core/repository/syntax-index.ts";

const FIXTURE = [
	'"""Module docstring."""', // 1
	"import os", // 2
	"import sys, json", // 3
	"from typing import List, Optional as Opt", // 4
	"", // 5
	"MAX = 100", // 6
	"DEBUG: bool = False", // 7
	"", // 8
	"def greet(name):", // 9
	"    return name", // 10
	"", // 11
	"async def fetch(url):", // 12
	"    return url", // 13
	"", // 14
	"class Greeter:", // 15
	"    def __init__(self):", // 16
	"        self.name = 'world'", // 17
].join("\n");

describe("extractPythonSymbols", () => {
	const symbols = extractPythonSymbols(FIXTURE, "fixture.py", "python");

	it("extracts plain `import` lines with module names", () => {
		// The fixture has 4 import statements (incl. one from-import);
		// each named binding gets its own entry. Total = 1 (os)
		// + 2 (sys, json) + 2 (typing List, typing Opt) = 5.
		const imports = symbols.filter((s) => s.kind === "import");
		expect(imports.length).toBe(5);
		const sources = imports.map((s) => s.name).sort();
		expect(sources).toEqual(["json", "os", "sys", "typing", "typing"]);
	});

	it("extracts `from x import a, b as c` with containerName as the local name", () => {
		const li = symbols.filter((s) => s.kind === "import" && s.name === "typing");
		expect(li.length).toBe(2);
		const locals = li.map((s) => s.containerName).sort();
		expect(locals).toEqual(["List", "Opt"]);
	});

	it("extracts a module-level constant assignment", () => {
		const v = symbols.find((s) => s.name === "MAX" && s.kind === "variable");
		expect(v).toBeDefined();
		expect(v?.modifiers).toContain("module-level");
		expect(v?.startLine).toBe(6);
	});

	it("extracts an annotated module-level assignment", () => {
		const v = symbols.find((s) => s.name === "DEBUG" && s.kind === "variable");
		expect(v).toBeDefined();
		expect(v?.startLine).toBe(7);
	});

	it("extracts a regular function", () => {
		const f = symbols.find((s) => s.name === "greet" && s.kind === "function");
		expect(f).toBeDefined();
		expect(f?.startLine).toBe(9);
	});

	it("extracts an async function with the async modifier", () => {
		const f = symbols.find((s) => s.name === "fetch" && s.kind === "function");
		expect(f).toBeDefined();
		expect(f?.modifiers).toContain("async");
	});

	it("extracts a class", () => {
		const c = symbols.find((s) => s.name === "Greeter" && s.kind === "class");
		expect(c).toBeDefined();
		expect(c?.startLine).toBe(15);
	});

	it("does NOT extract `==` comparisons as variables", () => {
		const FIXTURE_EQ = "if __name__ == '__main__':\n    run()";
		const eqSyms = extractPythonSymbols(FIXTURE_EQ, "x.py", "python");
		const vars = eqSyms.filter((s) => s.kind === "variable");
		expect(vars).toEqual([]);
	});
});

