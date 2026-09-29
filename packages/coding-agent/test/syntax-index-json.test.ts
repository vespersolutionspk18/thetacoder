/**
 * F1 syntax index — JSON extractor coverage.
 *
 * Top-level keys of a nested JSON object must produce one
 * `json-key` entry each, with dot-joined path.
 */

import { describe, expect, it } from "vitest";
import { extractJsonSymbols } from "../src/core/repository/syntax-index.ts";

const FIXTURE = JSON.stringify(
	{
		name: "theta",
		version: "0.1.0",
		scripts: {
			build: "tsgo --noEmit",
			test: "vitest",
		},
		dependencies: {
			foo: "1.0.0",
		},
	},
	null,
	2,
);

describe("extractJsonSymbols", () => {
	const symbols = extractJsonSymbols(FIXTURE, "package.json", "json");

	it("emits one entry per top-level key", () => {
		const top = symbols.filter((s) => !s.name.includes("."));
		const names = top.map((s) => s.name).sort();
		expect(names).toEqual(["dependencies", "name", "scripts", "version"]);
	});

	it("emits nested keys with dot-joined paths", () => {
		const nested = symbols.filter((s) => s.name.includes("."));
		const names = nested.map((s) => s.name).sort();
		expect(names).toEqual(["dependencies.foo", "scripts.build", "scripts.test"]);
	});

	it("marks every entry as a json-key", () => {
		expect(symbols.every((s) => s.kind === "json-key")).toBe(true);
	});

	it("returns [] for a JSON array (no keys)", () => {
		const arr = extractJsonSymbols("[1, 2, 3]", "arr.json", "json");
		expect(arr).toEqual([]);
	});

	it("returns [] for malformed JSON", () => {
		const broken = extractJsonSymbols("{ this is not json", "broken.json", "json");
		expect(broken).toEqual([]);
	});
});

