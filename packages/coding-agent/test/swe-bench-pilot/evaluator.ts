/**
 * Drives the official SWE-bench Docker-based evaluator.
 *
 * Input:  a list of `{instance, patch, ...}` produced by `theta-runner.ts`.
 * Output: a map of `instance_id → { passed, error?, reportPath }` parsed from
 *         the per-instance `report.json` that swebench writes under
 *         `<run_id>/<model_name_or_path>/<instance_id>/report.json`.
 *
 * `swebench eval verified -p preds.json -i <id> -j <workers> --run-id <id>`
 * spins up one Docker container per instance (or per `-j` batch), applies
 * the model patch, then runs the FAIL_TO_PASS / PASS_TO_PASS tests. We
 * invoke it once per instance so a single failing patch doesn't poison the
 * other runs.
 *
 * If `swebench` is not on PATH the runner errors out — fall back to a manual
 * evaluator would require a full local install of each repo's test deps and
 * is not implemented here.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "./theta-runner.ts";

export interface EvaluationResult {
	instance_id: string;
	passed: boolean;
	resolved: boolean;
	reportPath: string;
	rawReport: unknown;
	errorMessage?: string;
}

const SWEBENCH_BIN = process.env.SWEBENCH_BIN ?? "swebench";
const RUN_ID = process.env.SWE_BENCH_RUN_ID ?? `theta-m3-pilot-${Date.now()}`;

function findSwebenchExe(): string {
	// If `swebench` is on PATH, spawn() will resolve it. Otherwise return an
	// absolute path that PowerShell will surface as a clear "not found" error.
	return SWEBENCH_BIN;
}

function writePredictions(results: RunResult[], outPath: string): { count: number; withPatch: number } {
	const predictions = results.map((r) => ({
		instance_id: r.instance.instance_id,
		model_patch: r.patch,
		model_name_or_path: "theta-on-M3",
	}));
	writeFileSync(outPath, JSON.stringify(predictions, null, 2), "utf-8");
	return {
		count: predictions.length,
		withPatch: predictions.filter((p) => p.model_patch.length > 0).length,
	};
}

function reportDirFor(runId: string): string {
	return join("logs", "run_evaluation", runId, "theta-on-M3");
}

function readReportFor(instanceId: string, runId: string): { path: string; raw: unknown } | null {
	const path = join(reportDirFor(runId), instanceId, "report.json");
	if (!existsSync(path)) return null;
	try {
		return { path, raw: JSON.parse(readFileSync(path, "utf-8")) };
	} catch {
		return { path, raw: null };
	}
}

function extractPassed(report: unknown, instanceId: string): { resolved: boolean } {
	// Report shape: { "<instance_id>": { "resolved": true|false, ... } }
	if (typeof report === "object" && report !== null) {
		const r = (report as Record<string, unknown>)[instanceId];
		if (typeof r === "object" && r !== null) {
			const resolved = (r as Record<string, unknown>).resolved;
			if (typeof resolved === "boolean") return { resolved };
		}
	}
	return { resolved: false };
}

export interface EvalOptions {
	timeoutMs?: number; // per-instance
	workers?: number;
}

export async function evaluateInstances(
	results: RunResult[],
	opts: EvalOptions = {},
): Promise<{ runId: string; perInstance: EvaluationResult[] }> {
	const predsPath = join("logs", "run_evaluation", "predictions.json");
	mkdirSync("logs/run_evaluation", { recursive: true });
	const { count, withPatch } = writePredictions(results, predsPath);
	const runId = RUN_ID;
	const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000; // 15 min per instance
	const workers = opts.workers ?? 2;

	if (count === 0) {
		return { runId, perInstance: [] };
	}
	if (withPatch === 0) {
		// No patch produced by any run — skip the eval and just record failures.
		const perInstance: EvaluationResult[] = results.map((r) => ({
			instance_id: r.instance.instance_id,
			passed: false,
			resolved: false,
			reportPath: "",
			rawReport: null,
			errorMessage: "theta produced no diff for this instance",
		}));
		return { runId, perInstance };
	}

	const perInstance: EvaluationResult[] = [];
	// Process instances serially because each swebench invocation already
	// manages `-j <workers>` Docker containers in parallel. Running multiple
	// swebench processes simultaneously would oversubscribe Docker on a
	// single host.
	for (const r of results) {
		const iid = r.instance.instance_id;
		if (r.patch.length === 0) {
			perInstance.push({
				instance_id: iid,
				passed: false,
				resolved: false,
				reportPath: "",
				rawReport: null,
				errorMessage: "no patch to evaluate",
			});
			continue;
		}
		// Filter the predictions file to just this instance so swebench
		// doesn't burn time on the others.
		const singlePreds = results
			.filter((x) => x.instance.instance_id === iid)
			.map((x) => ({
				instance_id: x.instance.instance_id,
				model_patch: x.patch,
				model_name_or_path: "theta-on-M3",
			}));
		const singlePath = join("logs", "run_evaluation", `preds-${iid}.json`);
		writeFileSync(singlePath, JSON.stringify(singlePreds, null, 2), "utf-8");

		const args = [
			"eval",
			"verified",
			"-p",
			singlePath,
			"--run-id",
			runId,
			"-i",
			iid,
			"-j",
			String(Math.max(1, Math.floor(workers / Math.max(1, results.length)))),
			"-t",
			"600", // hard cap per-instance inside swebench
		];
		const child = spawn(findSwebenchExe(), args, {
			stdio: ["ignore", "inherit", "inherit"],
			windowsHide: true,
		});
		const exit = await new Promise<number | null>((resolve) => {
			const t = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* ignore */
				}
				resolve(null);
			}, timeoutMs);
			child.on("close", (code) => {
				clearTimeout(t);
				resolve(code);
			});
			child.on("error", () => {
				clearTimeout(t);
				resolve(null);
			});
		});

		const report = readReportFor(iid, runId);
		if (!report) {
			perInstance.push({
				instance_id: iid,
				passed: false,
				resolved: false,
				reportPath: "",
				rawReport: null,
				errorMessage: `swebench exit=${exit ?? "killed"}; no report.json produced`,
			});
			continue;
		}
		const { resolved } = extractPassed(report.raw, iid);
		perInstance.push({
			instance_id: iid,
			passed: resolved,
			resolved,
			reportPath: report.path,
			rawReport: report.raw,
			errorMessage: resolved ? undefined : "swebench reported resolved=false",
		});
	}

	return { runId, perInstance };
}

