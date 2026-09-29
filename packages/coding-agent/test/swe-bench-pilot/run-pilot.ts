/**
 * End-to-end orchestrator for the SWE-bench Verified mini-pilot.
 *
 * Phases:
 *   1. Load the curated pilot instances (instances.ts → instances.json).
 *   2. Drive theta against each instance, in batches of `--parallel` runs.
 *   3. Hand the resulting patches to the SWE-bench Docker evaluator.
 *   4. Write AUDIT_REPORT.md and a JSON sidecar with the per-run data.
 *
 * Defaults are tuned for a 1-hour wall-time budget on a single Windows
 * machine: 5 instances, 2 parallel theta runs, swebench with 2 workers
 * (one container at a time, see evaluator.ts).
 *
 * Usage:
 *   npx tsx packages/coding-agent/test/swe-bench-pilot/run-pilot.ts \
 *     --instances 5 --out packages/coding-agent/test/swe-bench-pilot/AUDIT_REPORT.md
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type EvaluationResult, evaluateInstances } from "./evaluator.ts";
import { loadInstances, PILOT_INSTANCE_IDS } from "./instances.ts";
import { runThetaOnInstance, writeRunArtifact } from "./theta-runner.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface CliOptions {
	instances: number;
	out: string;
	parallel: number;
	keepScratch: boolean;
	instanceFilter: string[];
}

function parseCli(argv: string[]): CliOptions {
	const opts: CliOptions = {
		instances: 5,
		out: join(__dirname, "AUDIT_REPORT.md"),
		parallel: 2,
		keepScratch: false,
		instanceFilter: [],
	};
	for (const arg of argv.slice(2)) {
		if (arg.startsWith("--instances=")) {
			opts.instances = Math.max(1, Number.parseInt(arg.slice("--instances=".length), 10));
		} else if (arg.startsWith("--out=")) {
			opts.out = arg.slice("--out=".length);
		} else if (arg.startsWith("--parallel=")) {
			opts.parallel = Math.max(1, Number.parseInt(arg.slice("--parallel=".length), 10));
		} else if (arg === "--keep-scratch") {
			opts.keepScratch = true;
		} else if (arg.startsWith("--only=")) {
			opts.instanceFilter = arg
				.slice("--only=".length)
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
		} else if (arg === "--help" || arg === "-h") {
			process.stdout.write(
				"Usage: run-pilot.ts [--instances=<n>] [--out=<path>] [--parallel=<n>] " +
					"[--only=<id1,id2,...>] [--keep-scratch]\n",
			);
			process.exit(0);
		}
	}
	return opts;
}

async function runBatched<T, R>(
	items: T[],
	batchSize: number,
	fn: (item: T, idx: number) => Promise<R>,
	onResult: (item: T, idx: number, result: R) => void,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	async function worker(): Promise<void> {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			const r = await fn(items[i]!, i);
			results[i] = r;
			onResult(items[i]!, i, r);
		}
	}
	const workers: Promise<void>[] = [];
	const n = Math.min(batchSize, items.length);
	for (let i = 0; i < n; i++) workers.push(worker());
	await Promise.all(workers);
	return results;
}

interface InstanceReportRow {
	instance_id: string;
	repo: string;
	base_commit: string;
	patch_lines: number;
	patch_chars: number;
	passed: boolean;
	resolved: boolean;
	wall_time_sec: number;
	cost_usd: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	model_calls: number;
	theta_exit_code: number | null;
	error: string;
}

function renderReport(
	rows: InstanceReportRow[],
	summary: {
		runId: string;
		totalWallSec: number;
		totalCostUsd: number;
		meanWallSec: number;
		passRate: number;
		passCount: number;
		runCount: number;
		parallel: number;
		instanceFilter: string[];
		keepScratch: boolean;
	},
	startedAt: string,
	finishedAt: string,
): string {
	const refRate = 80.5;
	const passPct = (summary.passRate * 100).toFixed(1);
	const refDelta = (summary.passRate * 100 - refRate).toFixed(1);
	const sigil = summary.passRate * 100 >= refRate ? "✅" : "⚠️";
	const lines: string[] = [];
	lines.push("# theta-on-M3 SWE-bench Verified Mini-Pilot Report");
	lines.push("");
	lines.push(
		`**Headline:** theta-on-M3 pass rate **${summary.passCount}/${summary.runCount} = ${passPct}%** ` +
			`(vs published M3 80.5% on SWE-bench Verified) — delta ${refDelta}pp ${sigil}`,
	);
	lines.push("");
	lines.push("## Run metadata");
	lines.push("");
	lines.push(`- Started: ${startedAt}`);
	lines.push(`- Finished: ${finishedAt}`);
	lines.push(`- swebench run id: \`${summary.runId}\``);
	lines.push(`- Wall time (theta only, total): ${summary.totalWallSec.toFixed(1)}s`);
	lines.push(`- Mean time per instance: ${summary.meanWallSec.toFixed(1)}s`);
	lines.push(`- Parallel theta workers: ${summary.parallel}`);
	lines.push(`- Total M3 cost: $${summary.totalCostUsd.toFixed(4)}`);
	lines.push("");
	lines.push("## Per-instance table");
	lines.push("");
	lines.push(
		"| instance_id | repo | patch_L | passed | wall_s | cost_USD | input_tok | out_tok | cache_read | calls | err |",
	);
	lines.push("|---|---|---:|---|---:|---:|---:|---:|---:|---:|---|");
	for (const r of rows) {
		lines.push(
			`| ${r.instance_id} | ${r.repo} | ${r.patch_lines} | ${r.passed ? "✅" : "❌"} | ` +
				`${r.wall_time_sec.toFixed(1)} | ${r.cost_usd.toFixed(4)} | ` +
				`${r.input_tokens} | ${r.output_tokens} | ${r.cache_read_tokens} | ${r.model_calls} | ` +
				`${r.error === "" ? "—" : r.error.slice(0, 60)} |`,
		);
	}
	lines.push("");
	lines.push("## Method");
	lines.push("");
	lines.push(
		"- 5-7 hand-picked SWE-bench Verified instances with `<15 min fix` difficulty, " +
			"from small repos (psf/requests, pallets/flask, pytest-dev/pytest, pylint-dev/pylint).",
	);
	lines.push(
		"- Single rep per instance (no averaging); 1 cell (`theta-on-M3` with default audit " +
			"features; the larger 4-cell × 3-rep study is the next step).",
	);
	lines.push(
		"- theta is invoked as `npx tsx packages/coding-agent/src/cli.ts --provider minimax " +
			"--model minimax/MiniMax-M3 --print --mode json --no-session --approve` from a " +
			"per-instance scratch clone (cwd = cloned repo at base_commit). The patch is " +
			"`git diff` after theta exits; per-message cost is summed from the streamed JSON " +
			"`message_end` events.",
	);
	lines.push(
		"- Evaluation: official `swebench` 5.0.2 Docker harness; per-instance run, " +
			"patches are written to a JSON predictions file, applied inside the SWE-bench " +
			"container, and the FAIL_TO_PASS + PASS_TO_PASS tests are graded.",
	);
	lines.push(
		"- M3 pricing: $0.30 / M input, $1.20 / M output, $0.06 / M cache-read, " +
			"$0.00 / M cache-write (from `packages/ai/src/providers/data/minimax.json`).",
	);
	lines.push("");
	lines.push("## Caveats");
	lines.push("");
	lines.push(
		`- **Small sample**: n=${summary.runCount}. A 1-instance swing moves the pass rate by ` +
			`${(100 / summary.runCount).toFixed(1)}pp. The headline number is directional, ` +
			"not a precise estimate of theta's M3 score.",
	);
	lines.push(
		"- **Single rep per cell**: no statistical averaging. Even the same instance can " +
			"produce different patches across runs (M3 sampling, tool non-determinism).",
	);
	lines.push(
		"- **Single cell**: this is `theta-on-M3` with default audit features. The 4-cell " +
			"ablation (base, f1-only, f2-only, all-on) is a separate study.",
	);
	lines.push(
		"- **Patch is whatever theta chose to commit**: the model is free to take a " +
			"different approach than the gold patch. We do not measure partial credit.",
	);
	if (summary.keepScratch) {
		lines.push("- Scratch dirs kept for post-hoc inspection (`--keep-scratch`).");
	} else {
		lines.push("- Scratch dirs are removed by the runner to save disk; reruns re-clone.");
	}
	lines.push("");
	lines.push("## Next steps");
	lines.push("");
	lines.push("1. Scale to 50 instances × 3 reps × 4 cells = 600 runs (~$300-$700, ~15 hours).");
	lines.push(
		"2. Add per-claim telemetry (cache-hit rate, tool-call count) so the report can " +
			"verify the audit's specific claims about theta's scaffolding, not just the " +
			"headline pass rate.",
	);
	lines.push(
		"3. If pass rate is consistently below 80.5%, investigate the 5-10 specific failure " +
			"modes (e.g. wrong file targeted, test-only fix, oversized edit).",
	);
	return `${lines.join("\n")}\n`;
}

function patchStats(patch: string): { lines: number; chars: number } {
	return { lines: patch.length === 0 ? 0 : patch.split("\n").length, chars: patch.length };
}

async function main(): Promise<void> {
	const cli = parseCli(process.argv);
	const allInstances = loadInstances();
	let selected = allInstances;
	if (cli.instanceFilter.length > 0) {
		selected = allInstances.filter((i) => cli.instanceFilter.includes(i.instance_id));
	} else {
		selected = allInstances.slice(0, Math.min(cli.instances, allInstances.length));
	}
	if (selected.length === 0) {
		process.stderr.write("[pilot] no instances to run\n");
		process.exit(1);
	}

	process.stdout.write(`[pilot] starting; ${selected.length} instances, parallel=${cli.parallel}\n`);
	const startedAt = new Date().toISOString();

	// Phase 1: drive theta in parallel.
	const runResults = await runBatched(
		selected,
		cli.parallel,
		async (instance) => {
			return runThetaOnInstance(instance, { thetaBin: "npx.cmd" });
		},
		(_instance, _idx, result) => {
			const stats = patchStats(result.patch);
			process.stdout.write(
				`[theta] ${result.instance.instance_id} clonedOk=${result.clonedOk} ` +
					`exit=${result.thetaExitCode} wall=${result.wallTimeSec.toFixed(1)}s ` +
					`patch=${stats.lines}L/${stats.chars}B cost=$${result.usage.totalCostUsd.toFixed(4)} ` +
					`calls=${result.usage.modelCalls}\n`,
			);
		},
	);

	// Persist per-run artifacts.
	const artifactsDir = join(__dirname, "artifacts");
	mkdirSync(artifactsDir, { recursive: true });
	for (const r of runResults) writeRunArtifact(r, artifactsDir);

	// Phase 2: evaluate with swebench.
	process.stdout.write(`[pilot] evaluating ${runResults.length} instances via swebench\n`);
	const { runId, perInstance } = await evaluateInstances(runResults, { workers: 2 });

	// Phase 3: render report.
	const finishedAt = new Date().toISOString();
	const evalById = new Map<string, EvaluationResult>(perInstance.map((e) => [e.instance_id, e]));
	const rows: InstanceReportRow[] = runResults.map((r) => {
		const e = evalById.get(r.instance.instance_id);
		const stats = patchStats(r.patch);
		return {
			instance_id: r.instance.instance_id,
			repo: r.instance.repo,
			base_commit: r.instance.base_commit,
			patch_lines: stats.lines,
			patch_chars: stats.chars,
			passed: e?.resolved ?? false,
			resolved: e?.resolved ?? false,
			wall_time_sec: r.wallTimeSec,
			cost_usd: r.usage.totalCostUsd,
			input_tokens: r.usage.inputTokens,
			output_tokens: r.usage.outputTokens,
			cache_read_tokens: r.usage.cacheReadTokens,
			cache_write_tokens: r.usage.cacheWriteTokens,
			model_calls: r.usage.modelCalls,
			theta_exit_code: r.thetaExitCode,
			error: e?.errorMessage ?? "",
		};
	});

	const passCount = rows.filter((r) => r.passed).length;
	const runCount = rows.length;
	const totalCostUsd = rows.reduce((a, r) => a + r.cost_usd, 0);
	const totalWallSec = rows.reduce((a, r) => a + r.wall_time_sec, 0);
	const meanWallSec = runCount > 0 ? totalWallSec / runCount : 0;
	const passRate = runCount > 0 ? passCount / runCount : 0;

	const summary = {
		runId,
		totalWallSec,
		totalCostUsd,
		meanWallSec,
		passRate,
		passCount,
		runCount,
		parallel: cli.parallel,
		instanceFilter: cli.instanceFilter,
		keepScratch: cli.keepScratch,
	};

	const md = renderReport(rows, summary, startedAt, finishedAt);
	mkdirSync(dirname(cli.out), { recursive: true });
	writeFileSync(cli.out, md, "utf-8");
	const jsonOut = cli.out.endsWith(".md") ? `${cli.out.slice(0, -3)}.json` : `${cli.out}.json`;
	writeFileSync(
		jsonOut,
		JSON.stringify(
			{
				startedAt,
				finishedAt,
				summary,
				instances: PILOT_INSTANCE_IDS,
				rows,
				evaluations: perInstance,
				rawRuns: runResults.map((r) => ({
					instance_id: r.instance.instance_id,
					scratchDir: r.scratchDir,
					clonedOk: r.clonedOk,
					clonedAt: r.clonedAt,
					wallTimeSec: r.wallTimeSec,
					usage: r.usage,
					thetaExitCode: r.thetaExitCode,
					thetaStderrTail: r.thetaStderrTail,
					patch: r.patch,
				})),
			},
			null,
			2,
		),
		"utf-8",
	);

	process.stdout.write(
		`[pilot] wrote ${cli.out}\n[pilot] wrote ${jsonOut}\n` +
			`[pilot] ${passCount}/${runCount} = ${(passRate * 100).toFixed(1)}% pass rate; ` +
			`$${totalCostUsd.toFixed(4)} M3 spend; ${totalWallSec.toFixed(1)}s theta wall time\n`,
	);
}

const invokedDirectly = process.argv[1]?.toLowerCase().endsWith("run-pilot.ts");
if (invokedDirectly) {
	main().catch((err: unknown) => {
		process.stderr.write(`[pilot] failed: ${(err as Error).stack ?? String(err)}\n`);
		process.exit(1);
	});
}

