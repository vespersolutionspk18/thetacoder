/**
 * F16 verification output parser tests.
 *
 * Each parser is fed a known-format fixture and asserted on the
 * typed `CheckOutcome`. The audit's "exit 0 alone is not enough"
 * rule is covered by the "unknown format" assertion: a parser that
 * cannot positively identify the output returns
 * `passed: false` with the `Unknown format` note, even when the
 * exit code is zero.
 */

import { describe, expect, it } from "vitest";
import {
	parseBiome,
	parseById,
	parseEslint,
	parseJest,
	parseMocha,
	parsePytest,
	parseRaw,
	parseTsc,
	parseVitest,
} from "../src/core/verification/parsers.ts";

describe("parseVitest", () => {
	it("parses a passing human-readable vitest run", () => {
		const output = [
			" RUN  v1.6.0",
			"",
			" ✓ src/foo.test.ts > works",
			" ✓ src/foo.test.ts > also works",
			"",
			" Test Files  2 passed (2)",
			"      Tests  2 passed (2)",
			"   Start at  00:00:00",
			"   Duration  0.5s",
			"",
		].join("\n");
		const outcome = parseVitest(output, 0);
		expect(outcome.passed).toBe(true);
		expect(outcome.parser).toBe("vitest");
		expect(outcome.passedCount).toBe(2);
		expect(outcome.failedCount).toBe(0);
		expect(outcome.total).toBe(2);
	});

	it("parses a failing human-readable vitest run and surfaces failed test names", () => {
		const output = [
			" RUN  v1.6.0",
			"",
			" ✓ src/foo.test.ts > works",
			" ✗ src/bar.test.ts > fails",
			"",
			" Test Files  1 failed | 1 passed (2)",
			"      Tests  1 failed | 1 passed (2)",
		].join("\n");
		const outcome = parseVitest(output, 1);
		expect(outcome.passed).toBe(false);
		expect(outcome.failedCount).toBe(1);
		expect(outcome.passedCount).toBe(1);
		expect(outcome.failures?.map((f) => f.name)).toContain("src/bar.test.ts > fails");
	});

	it("parses the vitest --reporter=json shape", () => {
		const json = JSON.stringify({
			numPassedTests: 3,
			numFailedTests: 1,
			numPendingTests: 0,
			numTotalTests: 4,
			testResults: [
				{ name: "src/foo.test.ts > a", status: "passed" },
				{ name: "src/bar.test.ts > b", status: "failed", message: "expected 1 to be 2" },
			],
		});
		const outcome = parseVitest(json, 1);
		expect(outcome.passed).toBe(false);
		expect(outcome.failedCount).toBe(1);
		expect(outcome.passedCount).toBe(3);
		expect(outcome.failures?.map((f) => f.name)).toEqual(["src/bar.test.ts > b"]);
	});

	it("returns a failed outcome for an empty output even on exit 0", () => {
		const outcome = parseVitest("", 0);
		expect(outcome.passed).toBe(false);
		expect(outcome.note).toBeDefined();
	});

	it("returns a failed outcome for unknown text even on exit 0", () => {
		const outcome = parseVitest("this is not a vitest report", 0);
		expect(outcome.passed).toBe(false);
		expect(outcome.note).toMatch(/Unknown format/);
	});
});

describe("parseJest", () => {
	it("parses a passing jest run", () => {
		const output = [
			"PASS src/foo.test.ts",
			"PASS src/bar.test.ts",
			"",
			"Tests:       2 passed, 2 total",
			"Test Suites: 2 passed, 2 total",
		].join("\n");
		const outcome = parseJest(output, 0);
		expect(outcome.passed).toBe(true);
		expect(outcome.passedCount).toBe(2);
		expect(outcome.total).toBe(2);
	});

	it("parses a failing jest run", () => {
		const output = [
			"FAIL src/foo.test.ts",
			"  ● foo > bar",
			"    expect 1 to be 2",
			"",
			"Tests:       1 failed, 1 passed, 2 total",
			"Test Suites: 1 failed, 1 passed, 2 total",
		].join("\n");
		const outcome = parseJest(output, 1);
		expect(outcome.passed).toBe(false);
		expect(outcome.failedCount).toBe(1);
		expect(outcome.failures?.map((f) => f.name)).toContain("src/foo.test.ts");
	});

	it("returns a failed outcome for unknown format even on exit 0", () => {
		const outcome = parseJest("definitely not jest output", 0);
		expect(outcome.passed).toBe(false);
		expect(outcome.note).toMatch(/Unknown format/);
	});
});

describe("parseMocha", () => {
	it("parses a passing mocha run", () => {
		const output = ["passing", "  ✓ works", "  ✓ also works", "", "2 passing (10ms)"].join("\n");
		const outcome = parseMocha(output, 0);
		expect(outcome.passed).toBe(true);
		expect(outcome.passedCount).toBe(2);
		expect(outcome.failedCount).toBe(0);
	});

	it("parses a failing mocha run", () => {
		const output = [
			"passing",
			"  ✓ works",
			"failing",
			"",
			"  1) suite > failing:",
			"     AssertionError: expected 1 to be 2",
			"",
			"1 passing (10ms)",
			"1 failing",
		].join("\n");
		const outcome = parseMocha(output, 1);
		expect(outcome.passed).toBe(false);
		expect(outcome.passedCount).toBe(1);
		expect(outcome.failedCount).toBe(1);
		expect(outcome.failures?.map((f) => f.name)).toContain("suite > failing");
	});

	it("returns a failed outcome for unknown format even on exit 0", () => {
		const outcome = parseMocha("hello", 0);
		expect(outcome.passed).toBe(false);
		expect(outcome.note).toMatch(/Unknown format/);
	});
});

describe("parsePytest", () => {
	it("parses a passing pytest run", () => {
		const output = [
			"============================= test session starts ==============================",
			"collected 3 items",
			"",
			"test_foo.py ...                                                              [100%]",
			"",
			"============================== 3 passed in 0.10s ================================",
		].join("\n");
		const outcome = parsePytest(output, 0);
		expect(outcome.passed).toBe(true);
		expect(outcome.passedCount).toBe(3);
		expect(outcome.failedCount).toBe(0);
	});

	it("parses a failing pytest run and surfaces failed tests", () => {
		const output = [
			"FAILED test_foo.py::test_a - AssertionError",
			"PASSED test_foo.py::test_b",
			"FAILED test_foo.py::test_c - TypeError",
			"",
			"=================== 2 failed, 1 passed in 0.10s ===================",
		].join("\n");
		const outcome = parsePytest(output, 1);
		expect(outcome.passed).toBe(false);
		expect(outcome.failedCount).toBe(2);
		expect(outcome.passedCount).toBe(1);
	});

	it("returns a failed outcome for unknown format even on exit 0", () => {
		const outcome = parsePytest("hello", 0);
		expect(outcome.passed).toBe(false);
		expect(outcome.note).toMatch(/Unknown format/);
	});
});

describe("parseBiome", () => {
	it("parses a clean biome run", () => {
		const output = "Checked 12 files in 50ms. No errors.\n";
		const outcome = parseBiome(output, 0);
		// No diagnostic rows + no "Found N errors" line → unknown format.
		expect(outcome.passed).toBe(false);
		expect(outcome.note).toMatch(/Unknown format/);
	});

	it("parses a biome run with errors and surfaces them", () => {
		const output = [
			"src/foo.ts:3:1 lint/suspicious/noExplicitAny ━━━━━━━━━━━━━━━━━━━━━━",
			"",
			"× Unnecessary any type.",
			"",
			"src/bar.ts:7:5 lint/correctness/noUnusedVariables ━━━━━━━━━━━━━━━",
			"",
			"× Unused variable x.",
			"",
			"Found 2 errors.",
		].join("\n");
		const outcome = parseBiome(output, 1);
		expect(outcome.passed).toBe(false);
		expect(outcome.failedCount).toBe(2);
		expect(outcome.failures?.[0]?.name).toBe("lint/suspicious/noExplicitAny");
	});

	it("returns a failed outcome for unknown format even on exit 0", () => {
		const outcome = parseBiome("hello", 0);
		expect(outcome.passed).toBe(false);
		expect(outcome.note).toMatch(/Unknown format/);
	});
});

describe("parseEslint", () => {
	it("parses a clean eslint run", () => {
		const output = "";
		const outcome = parseEslint(output, 0);
		expect(outcome.passed).toBe(false);
		expect(outcome.note).toMatch(/empty/);
	});

	it("parses the eslint --format json shape", () => {
		const json = JSON.stringify([
			{
				filePath: "/repo/src/foo.ts",
				errorCount: 1,
				warningCount: 1,
				messages: [
					{
						ruleId: "no-explicit-any",
						line: 3,
						column: 1,
						message: "Unexpected any",
						severity: 2,
					},
					{
						ruleId: "no-unused-vars",
						line: 7,
						column: 5,
						message: "x is defined but never used",
						severity: 1,
					},
				],
			},
		]);
		const outcome = parseEslint(json, 1);
		expect(outcome.passed).toBe(false);
		expect(outcome.failedCount).toBe(1);
		expect(outcome.passedCount).toBe(1);
		expect(outcome.failures?.[0]?.name).toBe("no-explicit-any");
		expect(outcome.failures?.[0]?.location).toBe("/repo/src/foo.ts:3:1");
	});

	it("parses a human-readable eslint run", () => {
		const output = [
			"/repo/src/foo.ts",
			"   3:1  error  Unexpected any  no-explicit-any",
			"   7:5  warning  Unused var  no-unused-vars",
			"",
			"✖ 2 problems (1 error, 1 warning)",
		].join("\n");
		const outcome = parseEslint(output, 1);
		expect(outcome.passed).toBe(false);
		expect(outcome.failedCount).toBe(1);
		expect(outcome.failures?.map((f) => f.name)).toContain("no-explicit-any");
	});

	it("returns a failed outcome for unknown format even on exit 0", () => {
		const outcome = parseEslint("hello", 0);
		expect(outcome.passed).toBe(false);
		expect(outcome.note).toMatch(/Unknown format/);
	});
});

describe("parseTsc", () => {
	it("parses a passing tsc run (no errors, exit 0)", () => {
		const output = "";
		const outcome = parseTsc(output, 0);
		// Empty output is unknown format per audit rule.
		expect(outcome.passed).toBe(false);
	});

	it("parses a failing tsc run and surfaces error locations", () => {
		const output = [
			"src/foo.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.",
			"src/bar.ts(7,5): error TS2304: Cannot find name 'foo'.",
		].join("\n");
		const outcome = parseTsc(output, 2);
		expect(outcome.passed).toBe(false);
		expect(outcome.failedCount).toBe(2);
		expect(outcome.failures?.[0]?.name).toBe("TS2322");
		expect(outcome.failures?.[0]?.location).toBe("src/foo.ts:3:1");
		expect(outcome.failures?.[0]?.message).toBe("Type 'string' is not assignable to type 'number'.");
	});

	it("parses tsc --json shape", () => {
		const json = JSON.stringify([
			{ file: "src/foo.ts", category: "error", code: 2322, line: 3, column: 1, messageText: "bad" },
			{ file: "src/bar.ts", category: "warning", code: 6133, line: 7, column: 5, messageText: "unused" },
		]);
		const outcome = parseTsc(json, 1);
		expect(outcome.passed).toBe(false);
		// Warnings are excluded from `failedCount` (gate is about errors).
		expect(outcome.failedCount).toBe(1);
		expect(outcome.failures?.[0]?.name).toBe("TS2322");
	});

	it("returns a failed outcome for unknown format even on exit 0", () => {
		const outcome = parseTsc("hello", 0);
		expect(outcome.passed).toBe(false);
		expect(outcome.note).toMatch(/Unknown format/);
	});
});

describe("parseRaw", () => {
	it("passes on exit 0", () => {
		const outcome = parseRaw("some output", 0);
		expect(outcome.passed).toBe(true);
		expect(outcome.note).toBe("raw exit 0");
	});

	it("fails on non-zero exit", () => {
		const outcome = parseRaw("boom", 1);
		expect(outcome.passed).toBe(false);
		expect(outcome.note).toContain("raw exit 1");
	});

	it("fails on null exit (killed)", () => {
		const outcome = parseRaw("killed", null);
		expect(outcome.passed).toBe(false);
		expect(outcome.note).toContain("raw exit null");
	});
});

describe("parseById", () => {
	it("dispatches by parser id", () => {
		const vitest = parseById("vitest", "Tests: 1 passed, 1 total\n", 0);
		expect(vitest.parser).toBe("vitest");
		const tsc = parseById("tsc", "src/foo.ts(3,1): error TS2322: bad\n", 1);
		expect(tsc.parser).toBe("tsc");
	});

	it("returns unknown-format note for the `unknown` parser", () => {
		const outcome = parseById("unknown", "anything", 0);
		expect(outcome.passed).toBe(false);
		expect(outcome.note).toMatch(/Unknown format/);
	});
});

