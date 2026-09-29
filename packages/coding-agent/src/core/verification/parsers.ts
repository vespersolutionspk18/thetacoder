/**
 * Output parsers for the F16 verification engine.
 *
 * Each parser is a pure function: it takes the raw output + exit code
 * and returns a typed `CheckOutcome`. The audit is explicit about one
 * rule: "exit code zero alone must not establish that the intended
 * tests ran." Every parser that cannot positively identify a known
 * format returns `{ passed: false, note: "Unknown format, treated as
 * failure" }` even when the exit code is zero.
 *
 * Parsers must never throw. They are best-effort: when the output is
 * empty, malformed, or partial, they return a `CheckOutcome` with
 * `note` set and `passed: false`.
 */

import type { CheckFailure, CheckOutcome, VerificationParserId } from "./types.ts";

// ============================================================================
// Raw parser — last-resort
// ============================================================================

/**
 * The `raw` parser trusts the exit code. It is intentionally
 * permissive: `exit 0` passes, anything else fails. The audit's
 * "exit zero alone is not enough" rule applies to *known* tools
 * (vitest, jest, …) — the raw parser is the fallback for tools
 * whose output we have not modelled, and for which the exit code
 * is the strongest signal we have.
 *
 * A note is still attached for diagnostics, so the gate can show
 * "raw exit 0 trust" rather than a clean `passed: true`.
 */
export function parseRaw(output: string, exitCode: number | null | undefined): CheckOutcome {
	const passed = exitCode === 0;
	return {
		passed,
		parser: "raw",
		note: passed ? "raw exit 0" : `raw exit ${exitCode ?? "null"}`,
		outputTruncated: output,
	};
}

// ============================================================================
// Shared utilities
// ============================================================================

const UNKNOWN_FORMAT_NOTE = "Unknown format, treated as failure";

function emptyOutcome(parser: VerificationParserId, note: string): CheckOutcome {
	return { passed: false, parser, note };
}

function extractCountsFromLine(line: string): {
	passed?: number;
	failed?: number;
	skipped?: number;
	total?: number;
} | null {
	// Common shape: "Tests: 2 failed, 1 passed, 3 total" or
	// "Test Suites: 1 failed, 1 passed, 2 total" (jest).
	const result: { passed?: number; failed?: number; skipped?: number; total?: number } = {};
	let matched = false;
	const re = /(\d+)\s+(passed|failed|skipped|total)/gi;
	let m: RegExpExecArray | null = re.exec(line);
	while (m !== null) {
		const n = Number(m[1]);
		const key = m[2]!.toLowerCase();
		if (Number.isFinite(n)) {
			if (key === "passed") result.passed = n;
			else if (key === "failed") result.failed = n;
			else if (key === "skipped") result.skipped = n;
			else if (key === "total") result.total = n;
			matched = true;
		}
		m = re.exec(line);
	}
	return matched ? result : null;
}

function sumCounts(counts: { passed?: number; failed?: number; skipped?: number; total?: number }): {
	passedCount: number;
	failedCount: number;
	skippedCount: number;
	total: number;
} {
	const passedCount = counts.passed ?? 0;
	const failedCount = counts.failed ?? 0;
	const skippedCount = counts.skipped ?? 0;
	const hasCounts = passedCount > 0 || failedCount > 0 || skippedCount > 0;
	const total = counts.total ?? (hasCounts ? passedCount + failedCount + skippedCount : 0);
	return { passedCount, failedCount, skippedCount, total };
}

// ============================================================================
// Vitest
// ============================================================================

/**
 * Vitest reporter output looks like:
 *   ✓ src/foo.test.ts > works
 *   ✗ src/bar.test.ts > fails
 *
 *   Test Files  1 failed | 1 passed (2)
 *        Tests  2 failed | 1 passed (3)
 *
 * Vitest's default reporter is human-readable; vitest with
 * `--reporter=json` prints a JSON object. We accept both shapes.
 */
export function parseVitest(output: string, exitCode: number | null | undefined): CheckOutcome {
	const trimmed = output.trim();
	if (trimmed.length === 0) {
		return emptyOutcome("vitest", "empty output, vitest did not produce a report");
	}

	// JSON reporter path.
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as {
				numPassedTests?: number;
				numFailedTests?: number;
				numPendingTests?: number;
				numTotalTests?: number;
				testResults?: Array<{ name: string; status: string; message?: string }>;
			};
			const passed = parsed.numPassedTests ?? 0;
			const failed = parsed.numFailedTests ?? 0;
			const skipped = parsed.numPendingTests ?? 0;
			const total = parsed.numTotalTests ?? passed + failed + skipped;
			const failures: CheckFailure[] = (parsed.testResults ?? [])
				.filter((r) => r.status === "failed")
				.map((r) => ({ name: r.name, message: r.message }));
			return {
				passed: failed === 0 && exitCode === 0,
				parser: "vitest",
				passedCount: passed,
				failedCount: failed,
				skippedCount: skipped,
				total,
				failures,
				note: failed === 0 ? undefined : `${failed} vitest test(s) failed`,
				outputTruncated: output,
			};
		} catch {
			return emptyOutcome("vitest", `${UNKNOWN_FORMAT_NOTE} (json parse failed)`);
		}
	}

	// Human-readable reporter. Look for the summary line(s).
	let summary: { passed?: number; failed?: number; skipped?: number; total?: number } | null = null;
	for (const line of trimmed.split(/\r?\n/)) {
		if (/Tests?\s/i.test(line) || /Test Files\s/i.test(line)) {
			const candidate = extractCountsFromLine(line);
			if (candidate && (candidate.passed !== undefined || candidate.failed !== undefined)) {
				summary = candidate;
			}
		}
	}

	if (!summary) {
		return emptyOutcome("vitest", `${UNKNOWN_FORMAT_NOTE} (no Test Files / Tests summary line found)`);
	}

	const counts = sumCounts(summary);
	const failures: CheckFailure[] = [];
	for (const line of trimmed.split(/\r?\n/)) {
		const m = /^[\s│\s]*[✗×] (.*)$/.exec(line);
		if (m) failures.push({ name: m[1]!.trim() });
	}

	return {
		passed: (counts.failedCount === 0 && counts.total > 0) || (counts.passedCount > 0 && counts.failedCount === 0),
		parser: "vitest",
		passedCount: counts.passedCount,
		failedCount: counts.failedCount,
		skippedCount: counts.skippedCount,
		total: counts.total,
		failures,
		note: counts.failedCount > 0 ? `${counts.failedCount} vitest test(s) failed` : undefined,
		outputTruncated: output,
	};
}

// ============================================================================
// Jest
// ============================================================================

/**
 * Jest default reporter prints:
 *   Tests:       1 failed, 5 passed, 6 total
 *   Test Suites: 1 failed, 1 passed, 2 total
 * followed by `FAIL path/to/file.test.ts` blocks with assertion errors.
 */
export function parseJest(output: string, exitCode: number | null | undefined): CheckOutcome {
	const trimmed = output.trim();
	if (trimmed.length === 0) {
		return emptyOutcome("jest", "empty output, jest did not produce a report");
	}

	let summary: { passed?: number; failed?: number; skipped?: number; total?: number } | null = null;
	for (const line of trimmed.split(/\r?\n/)) {
		if (/^Tests:\s/i.test(line)) {
			const candidate = extractCountsFromLine(line);
			if (candidate) summary = { ...(summary ?? {}), ...candidate };
		}
	}

	if (!summary) {
		return emptyOutcome("jest", `${UNKNOWN_FORMAT_NOTE} (no "Tests:" summary line found)`);
	}

	const counts = sumCounts(summary);
	const failures: CheckFailure[] = [];
	for (const line of trimmed.split(/\r?\n/)) {
		const failLine = /^FAIL\s+(.+)$/.exec(line);
		if (failLine) {
			failures.push({ name: failLine[1]!.trim(), location: failLine[1]!.trim() });
		}
	}

	return {
		passed: counts.failedCount === 0 && exitCode === 0,
		parser: "jest",
		passedCount: counts.passedCount,
		failedCount: counts.failedCount,
		skippedCount: counts.skippedCount,
		total: counts.total,
		failures,
		note: counts.failedCount > 0 ? `${counts.failedCount} jest test(s) failed` : undefined,
		outputTruncated: output,
	};
}

// ============================================================================
// Mocha
// ============================================================================

/**
 * Mocha default reporter prints:
 *   passing
 *   ...
 *   failing
 *   1) suite name > test name:
 *      AssertionError: ...
 *
 *   1 failing
 *   1 passing
 */
export function parseMocha(output: string, exitCode: number | null | undefined): CheckOutcome {
	const trimmed = output.trim();
	if (trimmed.length === 0) {
		return emptyOutcome("mocha", "empty output, mocha did not produce a report");
	}

	let passing: number | undefined;
	let failing: number | undefined;
	let pending: number | undefined;
	for (const line of trimmed.split(/\r?\n/)) {
		const summary = /^(\d+)\s+(passing|failing|pending)/i.exec(line.trim());
		if (summary) {
			const n = Number(summary[1]);
			if (!Number.isFinite(n)) continue;
			const key = summary[2]!.toLowerCase();
			if (key === "passing") passing = n;
			else if (key === "failing") failing = n;
			else if (key === "pending") pending = n;
		}
	}

	if (passing === undefined && failing === undefined) {
		return emptyOutcome("mocha", `${UNKNOWN_FORMAT_NOTE} (no "N passing/failing" line found)`);
	}

	passing = passing ?? 0;
	failing = failing ?? 0;
	pending = pending ?? 0;
	const total = passing + failing + pending;

	const failures: CheckFailure[] = [];
	const failureBlocks = trimmed.split(/\n\s*\n/);
	for (const block of failureBlocks) {
		const heading = /^\s*(\d+)\)\s+(.+?):\s*$/m.exec(block);
		if (heading) {
			failures.push({ name: heading[2]!.trim() });
		}
	}

	return {
		passed: failing === 0 && exitCode === 0,
		parser: "mocha",
		passedCount: passing,
		failedCount: failing,
		skippedCount: pending,
		total,
		failures,
		note: failing > 0 ? `${failing} mocha test(s) failed` : undefined,
		outputTruncated: output,
	};
}

// ============================================================================
// Pytest
// ============================================================================

/**
 * Pytest default reporter prints:
 *   ============================= test session starts ==============================
 *   collected 5 items
 *
 *   test_foo.py ....F                                                    [100%]
 *
 *   =================================== FAILURES ===================================
 *   ________________________________ test_failing _________________________________
 *
 *   test_foo.py:7: AssertionError
 *   =========================== short test summary info ============================
 *   FAILED test_foo.py::test_failing - AssertionError: ...
 *   ============================== 1 failed, 4 passed in 0.12s ===============================
 */
export function parsePytest(output: string, exitCode: number | null | undefined): CheckOutcome {
	const trimmed = output.trim();
	if (trimmed.length === 0) {
		return emptyOutcome("pytest", "empty output, pytest did not produce a report");
	}

	// Look for the summary line at the bottom: "= N failed, M passed in ... ="
	const summaryLine = trimmed
		.split(/\r?\n/)
		.reverse()
		.find((line) => /^=+ .*(failed|passed|error).*=+/i.test(line));

	if (!summaryLine) {
		return emptyOutcome("pytest", `${UNKNOWN_FORMAT_NOTE} (no "=... failed, ... passed ... =" summary line)`);
	}

	let failed = 0;
	let passed = 0;
	let skipped = 0;
	const re = /(\d+)\s+(failed|passed|error|skipped)/gi;
	let m: RegExpExecArray | null = re.exec(summaryLine);
	while (m !== null) {
		const n = Number(m[1]);
		const key = m[2]!.toLowerCase();
		if (!Number.isFinite(n)) continue;
		if (key === "failed" || key === "error") failed += n;
		else if (key === "passed") passed += n;
		else if (key === "skipped") skipped += n;
		m = re.exec(summaryLine);
	}

	const total = passed + failed + skipped;
	const failures: CheckFailure[] = [];
	const summarySection = /FAILED.*$/gim.exec(trimmed);
	if (summarySection) {
		for (const line of summarySection[0]!.split(/\r?\n/)) {
			const failMatch = /^FAILED\s+(\S+)(\s+-\s+(.+))?$/.exec(line);
			if (failMatch) {
				failures.push({ name: failMatch[1]!, location: failMatch[1]!, message: failMatch[3] });
			}
		}
	}

	return {
		passed: failed === 0 && exitCode === 0,
		parser: "pytest",
		passedCount: passed,
		failedCount: failed,
		skippedCount: skipped,
		total,
		failures,
		note: failed > 0 ? `${failed} pytest test(s) failed` : undefined,
		outputTruncated: output,
	};
}

// ============================================================================
// Biome
// ============================================================================

/**
 * Biome's default reporter prints one row per finding:
 *   src/foo.ts:3:1 lint/suspicious/noExplicitAny ━━━━━━━━━━━━━━━━━━━
 *
 *   × Unnecessary any type.
 *
 * At the end:
 *   Found 3 errors.
 *   Found 1 warning.
 */
export function parseBiome(output: string, exitCode: number | null | undefined): CheckOutcome {
	const trimmed = output.trim();
	if (trimmed.length === 0) {
		return emptyOutcome("biome", "empty output, biome did not produce a report");
	}

	const failures: CheckFailure[] = [];
	for (const line of trimmed.split(/\r?\n/)) {
		const m = /^(.+?):(\d+):(\d+)\s+([a-zA-Z][\w/]+)\s+━+/.exec(line);
		if (m) {
			failures.push({
				name: m[4]!,
				location: `${m[1]!}:${m[2]!}:${m[3]!}`,
			});
		}
	}

	let errors = 0;
	let warnings = 0;
	for (const line of trimmed.split(/\r?\n/)) {
		const e = /^Found\s+(\d+)\s+errors?\.?$/i.exec(line.trim());
		if (e) errors = Number(e[1]);
		const w = /^Found\s+(\d+)\s+warnings?\.?$/i.exec(line.trim());
		if (w) warnings = Number(w[1]);
	}

	if (failures.length === 0 && errors === 0 && warnings === 0) {
		return emptyOutcome("biome", `${UNKNOWN_FORMAT_NOTE} (no biome diagnostic rows found)`);
	}

	const total = errors + warnings;
	return {
		passed: errors === 0 && exitCode === 0,
		parser: "biome",
		passedCount: total - errors,
		failedCount: errors,
		skippedCount: 0,
		total,
		failures,
		note: errors > 0 ? `${errors} biome error(s)` : undefined,
		outputTruncated: output,
	};
}

// ============================================================================
// ESLint
// ============================================================================

/**
 * ESLint default reporter prints:
 *   /path/to/file.ts
 *     3:1  error  Unexpected any  no-explicit-any
 *     7:5  warning  Missing return type  @typescript-eslint/explicit-module-boundary-types
 *
 *   ✖ 2 problems (1 error, 1 warning)
 *
 * ESLint with `--format json` prints a JSON array of result objects.
 */
export function parseEslint(output: string, exitCode: number | null | undefined): CheckOutcome {
	const trimmed = output.trim();
	if (trimmed.length === 0) {
		return emptyOutcome("eslint", "empty output, eslint did not produce a report");
	}

	// JSON reporter path.
	if (trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed) as Array<{
				filePath?: string;
				errorCount?: number;
				warningCount?: number;
				messages?: Array<{
					ruleId?: string | null;
					line?: number;
					column?: number;
					message?: string;
					severity?: number;
				}>;
			}>;
			const failures: CheckFailure[] = [];
			let errors = 0;
			let warnings = 0;
			for (const file of parsed) {
				errors += file.errorCount ?? 0;
				warnings += file.warningCount ?? 0;
				for (const m of file.messages ?? []) {
					if ((m.severity ?? 2) === 1) continue; // skip warnings
					failures.push({
						name: m.ruleId ?? "(unknown rule)",
						location:
							m.line !== undefined && m.column !== undefined
								? `${file.filePath}:${m.line}:${m.column}`
								: file.filePath,
						message: m.message,
					});
				}
			}
			return {
				passed: errors === 0 && exitCode === 0,
				parser: "eslint",
				passedCount: warnings,
				failedCount: errors,
				total: errors + warnings,
				failures,
				note: errors > 0 ? `${errors} eslint error(s)` : undefined,
				outputTruncated: output,
			};
		} catch {
			return emptyOutcome("eslint", `${UNKNOWN_FORMAT_NOTE} (json parse failed)`);
		}
	}

	// Human-readable reporter.
	const failures: CheckFailure[] = [];
	const lines = trimmed.split(/\r?\n/);
	let currentFile: string | undefined;
	for (const line of lines) {
		const fileMatch = /^(\/[^\s].*?\.\S+)$/.exec(line);
		if (fileMatch && !/\s{2,}/.test(line)) {
			currentFile = fileMatch[1]!;
			continue;
		}
		const diagMatch = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)\s*$/.exec(line);
		if (diagMatch) {
			failures.push({
				name: diagMatch[5]!,
				location: `${currentFile ?? "?"}:${diagMatch[1]!}:${diagMatch[2]!}`,
				message: diagMatch[4]!.trim(),
			});
		}
	}

	let errors = 0;
	let warnings = 0;
	for (const line of lines) {
		const m = /[✖×]\s+(\d+)\s+problems?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/.exec(line);
		if (m) {
			errors = Number(m[2]);
			warnings = Number(m[3]);
		}
	}

	if (failures.length === 0 && errors === 0) {
		return emptyOutcome("eslint", `${UNKNOWN_FORMAT_NOTE} (no eslint diagnostic rows found)`);
	}

	const total = errors + warnings;
	return {
		passed: errors === 0 && exitCode === 0,
		parser: "eslint",
		passedCount: warnings,
		failedCount: errors,
		total,
		failures,
		note: errors > 0 ? `${errors} eslint error(s)` : undefined,
		outputTruncated: output,
	};
}

// ============================================================================
// TypeScript compiler (`tsc --noEmit`)
// ============================================================================

/**
 * `tsc` default reporter prints rows like:
 *   src/foo.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.
 *
 * With `--pretty false` the format is identical but without colors.
 * With `--json` it prints a JSON array; we accept both.
 */
export function parseTsc(output: string, exitCode: number | null | undefined): CheckOutcome {
	const trimmed = output.trim();
	if (trimmed.length === 0) {
		return emptyOutcome("tsc", "empty output, tsc did not produce a report");
	}

	// JSON reporter path.
	if (trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed) as Array<{
				file?: string;
				language?: string;
				category?: string;
				code?: number;
				line?: number;
				column?: number;
				messageText?: string | { category: number; messageText: string };
			}>;
			const failures: CheckFailure[] = [];
			let errors = 0;
			for (const d of parsed) {
				if ((d.category ?? "error") !== "error") continue;
				errors++;
				const message = typeof d.messageText === "string" ? d.messageText : (d.messageText?.messageText ?? "");
				failures.push({
					name: `TS${d.code ?? ""}`,
					location: d.line !== undefined && d.column !== undefined ? `${d.file}:${d.line}:${d.column}` : d.file,
					message,
				});
			}
			return {
				passed: errors === 0 && exitCode === 0,
				parser: "tsc",
				failedCount: errors,
				total: errors,
				failures,
				note: errors > 0 ? `${errors} tsc error(s)` : undefined,
				outputTruncated: output,
			};
		} catch {
			return emptyOutcome("tsc", `${UNKNOWN_FORMAT_NOTE} (json parse failed)`);
		}
	}

	// Human-readable reporter. `tsc` rows: `path(line,col): severity TSxxxx: message`.
	const failures: CheckFailure[] = [];
	const rowRe = /^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+(TS\d+):\s*(.+)$/;
	for (const line of trimmed.split(/\r?\n/)) {
		const m = rowRe.exec(line);
		if (m) {
			if (m[4] !== "error") continue; // gate is about errors, not warnings
			failures.push({
				name: m[5]!,
				location: `${m[1]!}:${m[2]!}:${m[3]!}`,
				message: m[6]!.trim(),
			});
		}
	}

	if (failures.length === 0) {
		return emptyOutcome("tsc", `${UNKNOWN_FORMAT_NOTE} (no "path(line,col): error TSxxxx:" rows)`);
	}

	return {
		passed: exitCode === 0,
		parser: "tsc",
		failedCount: failures.length,
		total: failures.length,
		failures,
		note: `${failures.length} tsc error(s)`,
		outputTruncated: output,
	};
}

// ============================================================================
// Dispatch
// ============================================================================

/**
 * Parse by parser id. Returns `{ parser: "unknown", ... }` for ids
 * the engine does not model; downstream code treats that as a fail.
 */
export function parseById(
	parserId: VerificationParserId,
	output: string,
	exitCode: number | null | undefined,
): CheckOutcome {
	switch (parserId) {
		case "raw":
			return parseRaw(output, exitCode);
		case "vitest":
			return parseVitest(output, exitCode);
		case "jest":
			return parseJest(output, exitCode);
		case "mocha":
			return parseMocha(output, exitCode);
		case "pytest":
			return parsePytest(output, exitCode);
		case "biome":
			return parseBiome(output, exitCode);
		case "eslint":
			return parseEslint(output, exitCode);
		case "tsc":
			return parseTsc(output, exitCode);
		case "unknown":
			return {
				passed: false,
				parser: "unknown",
				note: `${UNKNOWN_FORMAT_NOTE} (no parser configured for this check)`,
				outputTruncated: output,
			};
	}
}

