/**
 * F1 syntax index — comment-stripping coverage.
 *
 * Declarations that appear inside `//` or `/* ... * /` comments must
 * NOT be extracted.
 */

import { describe, expect, it } from "vitest";
import { extractTypeScriptSymbols } from "../src/core/repository/syntax-index.ts";

describe("comment-stripping (TypeScript)", () => {
	it("ignores declarations in line comments", () => {
		const src = [
			"// function notReal() {}", // 1
			"// class AlsoNotReal {}", // 2
			"// import x from 'y';", // 3
			"// const fake = 1;", // 4
			"// type Fake = number;", // 5
			"// interface IFake {}", // 6
			"// enum EFake { A }", // 7
			"// export default 1;", // 8
			"// export const fakeExport = 1;", // 9
			"function real() {}", // 10
		].join("\n");
		const symbols = extractTypeScriptSymbols(src, "fixture.ts", "typescript");
		const names = symbols.map((s) => s.name);
		expect(names).toEqual(["real"]);
	});

	it("ignores declarations in block comments", () => {
		const src = [
			"/* function hidden() {} */", // 1
			"/*", // 2
			"   class AlsoHidden {}", // 3
			"   import x from 'y';", // 4
			"*/", // 5
			"function real() {}", // 6
		].join("\n");
		const symbols = extractTypeScriptSymbols(src, "fixture.ts", "typescript");
		const names = symbols.map((s) => s.name);
		expect(names).toEqual(["real"]);
	});

	it("ignores a declaration split across a closing block comment on the same line", () => {
		const src = [
			"/* hidden comment */ function real() {}", // 1
			"// trailing comment that mentions function notReal()", // 2
		].join("\n");
		const symbols = extractTypeScriptSymbols(src, "fixture.ts", "typescript");
		const names = symbols.map((s) => s.name);
		expect(names).toEqual(["real"]);
	});
});

