/**
 * F1 syntax index — findSymbols / getSymbolsForFile coverage.
 *
 * Verifies substring search, kind filter, language filter, and
 * per-file lookup.
 */

import { describe, expect, it } from "vitest";
import { findSymbols, getSymbolsForFile, type SymbolEntry } from "../src/core/repository/syntax-index.ts";

function makeIndex(): SymbolEntry[] {
	return [
		{
			kind: "function",
			name: "createUser",
			path: "src/user.ts",
			startLine: 1,
			endLine: 1,
			language: "typescript",
		},
		{
			kind: "function",
			name: "deleteUser",
			path: "src/user.ts",
			startLine: 5,
			endLine: 5,
			language: "typescript",
		},
		{
			kind: "class",
			name: "User",
			path: "src/user.ts",
			startLine: 10,
			endLine: 20,
			language: "typescript",
		},
		{
			kind: "function",
			name: "user_helper",
			path: "src/util.js",
			startLine: 1,
			endLine: 1,
			language: "javascript",
		},
		{
			kind: "import",
			name: "react",
			path: "src/app.tsx",
			startLine: 1,
			endLine: 1,
			language: "typescript",
		},
		{
			kind: "heading",
			name: "Authentication",
			path: "docs/README.md",
			startLine: 4,
			endLine: 4,
			language: "markdown",
		},
	];
}

describe("getSymbolsForFile", () => {
	it("returns only the entries whose path matches", () => {
		const out = getSymbolsForFile(makeIndex(), "src/user.ts");
		expect(out.length).toBe(3);
		for (const e of out) expect(e.path).toBe("src/user.ts");
	});

	it("returns [] for an unknown path", () => {
		expect(getSymbolsForFile(makeIndex(), "nope.ts")).toEqual([]);
	});
});

describe("findSymbols", () => {
	it("matches by case-insensitive substring by default", () => {
		const out = findSymbols(makeIndex(), "user");
		const names = out.map((s) => s.name).sort();
		// 4 entries contain "user" (case-insensitive): createUser,
		// deleteUser, User, user_helper.
		expect(names).toEqual(["User", "createUser", "deleteUser", "user_helper"]);
	});

	it("honours the kind filter", () => {
		const out = findSymbols(makeIndex(), "user", { kind: "function" });
		const names = out.map((s) => s.name).sort();
		expect(names).toEqual(["createUser", "deleteUser", "user_helper"]);
	});

	it("honours the language filter", () => {
		const out = findSymbols(makeIndex(), "user", { language: "typescript" });
		const names = out.map((s) => s.name).sort();
		expect(names).toEqual(["User", "createUser", "deleteUser"]);
	});

	it("respects caseSensitive when set", () => {
		// "user" with case-sensitive matching should hit only the
		// all-lowercase name "user_helper", not the CamelCase ones.
		const out = findSymbols(makeIndex(), "user", { caseSensitive: true });
		expect(out.map((s) => s.name)).toEqual(["user_helper"]);
	});

	it("limits the number of results to the default 100", () => {
		const big: SymbolEntry[] = [];
		for (let i = 0; i < 500; i += 1) {
			big.push({
				kind: "function",
				name: `f${i}`,
				path: "big.ts",
				startLine: i + 1,
				endLine: i + 1,
				language: "typescript",
			});
		}
		const out = findSymbols(big, "f");
		expect(out.length).toBe(100);
	});

	it("respects a custom limit", () => {
		const out = findSymbols(makeIndex(), "user", { limit: 2 });
		expect(out.length).toBe(2);
	});
});

