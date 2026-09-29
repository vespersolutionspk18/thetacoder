/**
 * Main entry point for the audit benchmark.
 *
 * Runs every task in `TASKS` under each of the four cell combinations
 * (cold+F2-off, cold+F2-on, warm+F2-off, warm+F2-on), `repetitions`
 * times per cell, and writes a markdown report to
 * `REPORT.md` next to this file. A JSON sidecar with the raw per-run
 * data is also written for downstream inspection.
 *
 * Usage:
 *   npx tsx packages/coding-agent/test/audit-benchmark/run-benchmark.ts
 *
 * CLI flags:
 *   --repetitions=<n>   number of repetitions per cell (default: 3)
 *   --out=<path>        path to write the report (default: REPORT.md)
 *   --quiet             suppress per-cell progress output
 *   --tasks=<a,b,c>     comma-separated task ids to run (default: all)
 */

import { writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { type CellSummary, type RunMetrics, renderReport, summarizeCell } from "./metrics.ts";
import {
	type CacheMode,
	type CellRunResult,
	defaultRenderOptions,
	type F2Mode,
	newSharedSerializer,
	type RunOptions,
	runAuditBenchmark,
} from "./runner.ts";
import { TASKS, type TaskDefinition } from "./tasks.ts";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
	repetitions: number;
	out: string;
	quiet: boolean;
	tasks: string[];
}

function parseCli(argv: string[]): CliOptions {
	const opts: CliOptions = {
		repetitions: 3,
		out: "",
		quiet: false,
		tasks: [],
	};
	for (const arg of argv.slice(2)) {
		if (arg.startsWith("--repetitions=")) {
			opts.repetitions = Math.max(1, Number.parseInt(arg.slice("--repetitions=".length), 10));
		} else if (arg.startsWith("--out=")) {
			opts.out = arg.slice("--out=".length);
		} else if (arg === "--quiet") {
			opts.quiet = true;
		} else if (arg.startsWith("--tasks=")) {
			opts.tasks = arg
				.slice("--tasks=".length)
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
		}
	}
	return opts;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface BenchmarkRunSummary {
	cells: CellSummary[];
	tasks: Array<{ id: string; label: string }>;
	repetitions: number;
	totalRuns: number;
}

/**
 * Programmatic entry point: run the benchmark and return a structured
 * summary. Used by `main()` and by the test files.
 */
export async function runBenchmark(options: {
	repetitions: number;
	tasks?: TaskDefinition[];
	quiet?: boolean;
}): Promise<BenchmarkRunSummary> {
	const repetitions = Math.max(1, options.repetitions);
	const tasks = options.tasks ?? TASKS;
	const quiet = options.quiet ?? false;

	const cells: CellSummary[] = [];
	const rawRuns: RunMetrics[] = [];

	for (const task of tasks) {
		for (const cacheMode of ["cold", "warm"] as const) {
			for (const f2Mode of ["on", "off"] as const) {
				const cellRuns: RunMetrics[] = [];
				const sharedSerializer = newSharedSerializer();
				for (let rep = 1; rep <= repetitions; rep++) {
					const runOptions: RunOptions = {
						cacheMode,
						f2Mode,
						renderOptions: defaultRenderOptions(),
					};
					if (cacheMode === "warm") {
						runOptions.sharedSerializer = sharedSerializer;
					}
					const result = await runAuditBenchmark({
						task,
						options: runOptions,
						repetition: rep,
					});
					cellRuns.push(result);
					rawRuns.push(result);
					if (!quiet) {
						const meanPrompt = cellRuns.reduce((a, r) => a + r.promptTokens, 0) / cellRuns.length;
						const meanCache = cellRuns.reduce((a, r) => a + r.f2CacheHits, 0) / cellRuns.length;
						process.stdout.write(
							`[benchmark] ${task.id} ${cacheMode}+F2-${f2Mode} rep ${rep}/${repetitions} — ` +
								`prompt=${meanPrompt.toFixed(0)} cacheHits=${meanCache.toFixed(1)} completed=${result.completed}\n`,
						);
					}
				}
				const summary = summarizeCell(cellRuns);
				cells.push(summary);
			}
		}
	}

	return {
		cells,
		tasks: tasks.map((t) => ({ id: t.id, label: t.label })),
		repetitions,
		totalRuns: rawRuns.length,
	};
}

async function main(): Promise<void> {
	const cli = parseCli(process.argv);
	const tasks = cli.tasks.length > 0 ? TASKS.filter((t) => cli.tasks.includes(t.id)) : TASKS;
	if (tasks.length === 0) {
		process.stderr.write(`[benchmark] no tasks matched: ${cli.tasks.join(",")}\n`);
		process.exit(1);
	}

	const out = cli.out !== "" ? cli.out : join(__dirname, "REPORT.md");
	const summary = await runBenchmark({ repetitions: cli.repetitions, tasks, quiet: cli.quiet });

	const report = renderReport(summary.tasks, summary.cells);
	writeFileSync(out, report, "utf-8");

	const jsonOut = out.endsWith(".md") ? `${out.slice(0, -3)}.json` : `${out}.json`;
	writeFileSync(
		jsonOut,
		JSON.stringify(
			{
				repetitions: summary.repetitions,
				totalRuns: summary.totalRuns,
				tasks: summary.tasks,
				cells: summary.cells,
			},
			null,
			2,
		),
		"utf-8",
	);

	process.stdout.write(
		`[benchmark] wrote ${out}\n[benchmark] wrote ${jsonOut}\n` +
			`[benchmark] ${summary.totalRuns} runs across ${summary.cells.length} cells\n`,
	);
}

// Run when invoked directly. Guarded so test files that import
// `runBenchmark` do not trigger a real run.
const invokedDirectly = process.argv[1] !== undefined && resolvePath(process.argv[1]) === __filename;

if (invokedDirectly) {
	main().catch((err: unknown) => {
		process.stderr.write(`[benchmark] failed: ${(err as Error).stack ?? String(err)}\n`);
		process.exit(1);
	});
}

// Re-export helpers so test files can also import them.
export { parseCli, type CellRunResult, type CacheMode, type F2Mode };

