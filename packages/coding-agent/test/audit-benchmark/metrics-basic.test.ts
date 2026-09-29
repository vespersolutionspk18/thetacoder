/**
 * Basic tests for the audit-benchmark metrics module.
 *
 * Verifies that:
 *  - `RunMetricsCollector` accumulates correctly across turn updates.
 *  - `summarize` computes mean / stddev / min / max across runs.
 *  - `summarizeCell` produces a `CellSummary` keyed by the cell.
 *  - `renderReport` produces a markdown report with the 4x12-cell table.
 */

import { describe, expect, it } from "vitest";
import {
	type CellSummary,
	type MetricSummary,
	RunMetricsCollector,
	renderReport,
	summarize,
	summarizeCell,
} from "./metrics.ts";

function makeRun(
	taskId: string,
	cacheMode: "cold" | "warm",
	f2Mode: "on" | "off",
	overrides: Partial<{
		promptTokens: number;
		generatedTokens: number;
		logicalInferences: number;
		toolCalls: number;
		wallClockMs: number;
		cacheControlEmissions: number;
		completed: boolean;
	}> = {},
): ReturnType<RunMetricsCollector["snapshot"]> {
	const collector = new RunMetricsCollector(`${taskId}|${cacheMode}|F2-${f2Mode}`, taskId, cacheMode, f2Mode);
	collector.recordInference();
	collector.recordCacheControlEmissions(overrides.cacheControlEmissions ?? 1);
	const snap = collector.snapshot();
	return {
		...snap,
		promptTokens: overrides.promptTokens ?? 100,
		generatedTokens: overrides.generatedTokens ?? 50,
		logicalInferences: overrides.logicalInferences ?? 1,
		toolCalls: overrides.toolCalls ?? 1,
		wallClockMs: overrides.wallClockMs ?? 1,
		completed: overrides.completed ?? true,
	};
}

describe("audit-benchmark metrics", () => {
	it("records inference + cache + turn projection on the collector", () => {
		const c = new RunMetricsCollector("cell", "t", "cold", "on");
		c.recordInference();
		c.recordInference();
		c.recordCacheControlEmissions(2);
		c.recordTurnProjection([]);
		c.recordFreshnessWarning();
		const snap = c.snapshot();
		expect(snap.logicalInferences).toBe(2);
		expect(snap.cacheControlEmissions).toBe(2);
		expect(snap.freshnessWarningsEmitted).toBe(1);
		expect(snap.completed).toBe(false);
	});

	it("tracks redundant source deliveries by consecutive tool-result text", () => {
		const c = new RunMetricsCollector("cell", "t", "cold", "on");
		c.recordToolResult("read", "hello", false);
		c.recordToolResult("read", "hello", false);
		c.recordToolResult("read", "world", false);
		c.recordToolResult("read", "world", false);
		const snap = c.snapshot();
		expect(snap.toolResults).toBe(4);
		expect(snap.redundantSourceDeliveries).toBe(2);
		expect(snap.failedEdits).toBe(0);
	});

	it("tracks failed edits from isError=true", () => {
		const c = new RunMetricsCollector("cell", "t", "cold", "on");
		c.recordToolResult("edit", "boom", true);
		c.recordToolResult("edit", "ok", false);
		const snap = c.snapshot();
		expect(snap.toolResults).toBe(2);
		expect(snap.failedEdits).toBe(1);
	});

	it("summarize computes mean / stddev / min / max correctly", () => {
		const runs = [
			makeRun("t", "cold", "on", { promptTokens: 100 }),
			makeRun("t", "cold", "on", { promptTokens: 200 }),
			makeRun("t", "cold", "on", { promptTokens: 300 }),
		];
		const s: MetricSummary = summarize(runs, "promptTokens");
		expect(s.n).toBe(3);
		expect(s.mean).toBe(200);
		expect(s.min).toBe(100);
		expect(s.max).toBe(300);
		// Sample stddev of [100, 200, 300] = 100.
		expect(Math.round(s.stddev)).toBe(100);
	});

	it("summarize handles a single sample (stddev=0)", () => {
		const runs = [makeRun("t", "cold", "on", { promptTokens: 50 })];
		const s = summarize(runs, "promptTokens");
		expect(s.n).toBe(1);
		expect(s.mean).toBe(50);
		expect(s.stddev).toBe(0);
	});

	it("summarizeCell aggregates every field of a cell", () => {
		const runs = [
			makeRun("t", "cold", "on", { promptTokens: 100, toolCalls: 2 }),
			makeRun("t", "cold", "on", { promptTokens: 200, toolCalls: 4 }),
		];
		const cell: CellSummary = summarizeCell(runs);
		expect(cell.taskId).toBe("t");
		expect(cell.cacheMode).toBe("cold");
		expect(cell.f2Mode).toBe("on");
		expect(cell.promptTokens.mean).toBe(150);
		expect(cell.toolCalls.mean).toBe(3);
	});

	it("renderReport produces a markdown report with one 4-column table per task", () => {
		const runs = [
			makeRun("known-function-fix", "cold", "off", { promptTokens: 100, toolCalls: 2 }),
			makeRun("known-function-fix", "cold", "on", { promptTokens: 90, toolCalls: 2 }),
			makeRun("known-function-fix", "warm", "off", { promptTokens: 100, toolCalls: 2 }),
			makeRun("known-function-fix", "warm", "on", { promptTokens: 50, toolCalls: 2 }),
			makeRun("unknown-bug", "cold", "off", { promptTokens: 200, toolCalls: 5 }),
			makeRun("unknown-bug", "cold", "on", { promptTokens: 180, toolCalls: 5 }),
			makeRun("unknown-bug", "warm", "off", { promptTokens: 200, toolCalls: 5 }),
			makeRun("unknown-bug", "warm", "on", { promptTokens: 100, toolCalls: 5 }),
			makeRun("navigation", "cold", "off", { promptTokens: 150, toolCalls: 4 }),
			makeRun("navigation", "cold", "on", { promptTokens: 140, toolCalls: 4 }),
			makeRun("navigation", "warm", "off", { promptTokens: 150, toolCalls: 4 }),
			makeRun("navigation", "warm", "on", { promptTokens: 80, toolCalls: 4 }),
		];
		const cells = [
			summarizeCell(
				runs.filter((r) => r.taskId === "known-function-fix" && r.cacheMode === "cold" && r.f2Mode === "off"),
			),
			summarizeCell(
				runs.filter((r) => r.taskId === "known-function-fix" && r.cacheMode === "cold" && r.f2Mode === "on"),
			),
			summarizeCell(
				runs.filter((r) => r.taskId === "known-function-fix" && r.cacheMode === "warm" && r.f2Mode === "off"),
			),
			summarizeCell(
				runs.filter((r) => r.taskId === "known-function-fix" && r.cacheMode === "warm" && r.f2Mode === "on"),
			),
			summarizeCell(runs.filter((r) => r.taskId === "unknown-bug" && r.cacheMode === "cold" && r.f2Mode === "off")),
			summarizeCell(runs.filter((r) => r.taskId === "unknown-bug" && r.cacheMode === "cold" && r.f2Mode === "on")),
			summarizeCell(runs.filter((r) => r.taskId === "unknown-bug" && r.cacheMode === "warm" && r.f2Mode === "off")),
			summarizeCell(runs.filter((r) => r.taskId === "unknown-bug" && r.cacheMode === "warm" && r.f2Mode === "on")),
			summarizeCell(runs.filter((r) => r.taskId === "navigation" && r.cacheMode === "cold" && r.f2Mode === "off")),
			summarizeCell(runs.filter((r) => r.taskId === "navigation" && r.cacheMode === "cold" && r.f2Mode === "on")),
			summarizeCell(runs.filter((r) => r.taskId === "navigation" && r.cacheMode === "warm" && r.f2Mode === "off")),
			summarizeCell(runs.filter((r) => r.taskId === "navigation" && r.cacheMode === "warm" && r.f2Mode === "on")),
		];
		const tasks = [
			{ id: "known-function-fix", label: "known-function fix" },
			{ id: "unknown-bug", label: "unknown bug" },
			{ id: "navigation", label: "navigation" },
		];
		const report = renderReport(tasks, cells);
		// 3 task tables expected.
		const matches = report.match(/## Task: /g) ?? [];
		expect(matches.length).toBe(3);
		// Audit-claim section expected.
		expect(report).toContain("## Audit claim verification");
		// F2 observability section expected.
		expect(report).toContain("## F2-specific observability");
		// Each per-task table should have 12 metric rows + 1 header.
		const tableRows = report.split("\n").filter((line) => line.startsWith("|")).length;
		expect(tableRows).toBeGreaterThan(50);
	});
});

