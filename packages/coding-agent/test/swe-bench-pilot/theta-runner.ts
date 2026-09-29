/**
 * Drives theta against a single SWE-bench Verified instance.
 *
 * For each instance:
 *   1. Clone the target repo at its `base_commit` into a per-instance scratch
 *      directory (NOT inside the main theta repo, per the user's no-git rule).
 *   2. Spawn `theta` non-interactively with `--print` + `--mode json`, pointed
 *      at the scratch dir via the child-process `cwd` option. Capture the
 *      streamed JSON events so we can sum per-message usage / cost.
 *   3. After theta exits, `git diff` the scratch dir to produce the model
 *      patch as a unified diff string. Empty diff → instance "no patch".
 *
 * The cap is 10 minutes per instance; budget says 5-10 instances must finish
 * in ≤ 60 min wall time with 2-way parallelism, so each instance can take
 * up to ~10-15 min before becoming a bottleneck.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { performance } from "node:perf_hooks";
import type { PilotInstance } from "./instances.ts";

// External scratch dir — outside the main theta repo so we never run git
// inside it.
export const SCRATCH_ROOT = process.env.SWE_BENCH_SCRATCH ?? "C:\\Temp\\swe-bench-scratch";

export const PER_INSTANCE_TIMEOUT_MS = 10 * 60 * 1000;

export interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalCostUsd: number;
	modelCalls: number;
}

export interface RunResult {
	instance: PilotInstance;
	scratchDir: string;
	patch: string;
	wallTimeSec: number;
	usage: UsageTotals;
	thetaExitCode: number | null;
	thetaStderrTail: string;
	clonedAt: string;
	clonedOk: boolean;
}

const emptyUsage = (): UsageTotals => ({
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalCostUsd: 0,
	modelCalls: 0,
});

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseUsageEvent(evt: Record<string, unknown>, totals: UsageTotals): void {
	// message_end events carry the cumulative usage + cost for that turn.
	if (evt.type === "message_end") {
		const msg = evt.message;
		if (isRecord(msg) && isRecord(msg.usage)) {
			const u = msg.usage;
			totals.inputTokens += typeof u.input === "number" ? (u.input as number) : 0;
			totals.outputTokens += typeof u.output === "number" ? (u.output as number) : 0;
			totals.cacheReadTokens += typeof u.cacheRead === "number" ? (u.cacheRead as number) : 0;
			totals.cacheWriteTokens += typeof u.cacheWrite === "number" ? (u.cacheWrite as number) : 0;
			if (isRecord(u.cost)) {
				const c = u.cost;
				totals.totalCostUsd += typeof c.total === "number" ? (c.total as number) : 0;
			}
			totals.modelCalls += 1;
		}
	}
}

/**
 * Clone the instance's repo at the given commit into `target`. Returns true
 * on success. Caller decides whether to delete a pre-existing dir.
 */
export async function cloneAtCommit(
	repo: string,
	baseCommit: string,
	target: string,
): Promise<{ ok: boolean; error?: string }> {
	if (existsSync(target)) {
		rmSync(target, { recursive: true, force: true });
	}
	mkdirSync(target, { recursive: true });
	const url = `https://github.com/${repo}.git`;
	const args = ["clone", "--depth", "50", url, target];
	return new Promise((resolve) => {
		const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});
		child.on("error", (err) => {
			resolve({ ok: false, error: `git clone failed to start: ${err.message}` });
		});
		child.on("close", (code) => {
			if (code !== 0) {
				resolve({ ok: false, error: `git clone exit ${code}: ${stderr.slice(-400)}` });
				return;
			}
			// Fetch the exact base_commit, then check it out. Shallow clones
			// may not have the commit locally, so unshallow if needed.
			const fetchProc = spawn("git", ["fetch", "--depth", "1", "origin", baseCommit], {
				cwd: target,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			let _fetchStderr = "";
			fetchProc.stderr.on("data", (c: Buffer) => {
				_fetchStderr += c.toString("utf-8");
			});
			fetchProc.on("close", (fetchCode) => {
				if (fetchCode !== 0) {
					// Fall back to full clone if shallow fetch failed.
					const fullFetch = spawn("git", ["fetch", "origin", baseCommit], {
						cwd: target,
						stdio: ["ignore", "pipe", "pipe"],
						windowsHide: true,
					});
					let fullErr = "";
					fullFetch.stderr.on("data", (c: Buffer) => {
						fullErr += c.toString("utf-8");
					});
					fullFetch.on("close", (fullCode) => {
						if (fullCode !== 0) {
							resolve({
								ok: false,
								error: `git fetch exit ${fullCode}: ${fullErr.slice(-400)}`,
							});
							return;
						}
						checkout(target, baseCommit, resolve);
					});
				} else {
					checkout(target, baseCommit, resolve);
				}
			});
		});
	});
}

function checkout(target: string, commit: string, resolve: (v: { ok: boolean; error?: string }) => void): void {
	const co = spawn("git", ["checkout", "--quiet", commit], {
		cwd: target,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let err = "";
	co.stderr.on("data", (c: Buffer) => {
		err += c.toString("utf-8");
	});
	co.on("close", (code) => {
		if (code !== 0) {
			resolve({ ok: false, error: `git checkout exit ${code}: ${err.slice(-400)}` });
			return;
		}
		resolve({ ok: true });
	});
}

async function captureDiff(target: string): Promise<string> {
	return new Promise((resolve) => {
		const child = spawn("git", ["diff", "--no-color", "--no-ext-diff"], {
			cwd: target,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let out = "";
		child.stdout.on("data", (c: Buffer) => {
			out += c.toString("utf-8");
		});
		child.on("close", () => resolve(out));
		child.on("error", () => resolve(""));
	});
}

function buildPrompt(instance: PilotInstance): string {
	// Keep it terse — theta's job is to read the repo and produce a patch.
	// SWE-bench expects the patch to apply to base_commit, with no test
	// changes. We hint at this so theta doesn't waste a turn editing tests.
	return [
		`Repository: ${instance.repo}`,
		`Commit: ${instance.base_commit}`,
		"",
		"Issue:",
		instance.problem_statement.trim(),
		"",
		"Implement the fix in the source code. Do NOT edit tests.",
		"When you are done, briefly summarize the change you made in one or two sentences.",
	].join("\n");
}

export interface RunOptions {
	thetaBin: string; // absolute path to the theta CLI entrypoint
	timeoutMs?: number;
	extraFlags?: string[];
}

const REPO_ROOT = resolvePath(join(import.meta.dirname, "..", "..", "..", ".."));

/**
 * Run theta against a single instance. Returns the model patch + usage stats.
 */
export async function runThetaOnInstance(instance: PilotInstance, opts: RunOptions): Promise<RunResult> {
	const scratchDir = join(SCRATCH_ROOT, instance.instance_id);
	const cloned = await cloneAtCommit(instance.repo, instance.base_commit, scratchDir);
	const baseResult: Omit<RunResult, "patch" | "wallTimeSec" | "usage" | "thetaExitCode" | "thetaStderrTail"> = {
		instance,
		scratchDir,
		clonedAt: new Date().toISOString(),
		clonedOk: cloned.ok,
	};
	if (!cloned.ok) {
		return {
			...baseResult,
			patch: "",
			wallTimeSec: 0,
			usage: emptyUsage(),
			thetaExitCode: null,
			thetaStderrTail: `clone error: ${cloned.error ?? "unknown"}`,
		};
	}

	const prompt = buildPrompt(instance);
	const cliPath = join(REPO_ROOT, "packages", "coding-agent", "src", "cli.ts");
	const args = [
		opts.thetaBin,
		cliPath,
		"--provider",
		"minimax",
		"--model",
		"minimax/MiniMax-M3",
		"--print",
		"--mode",
		"json",
		"--no-session",
		"--approve",
		"--thinking",
		"off",
		...(opts.extraFlags ?? []),
		"--",
		prompt,
	];

	const timeoutMs = opts.timeoutMs ?? PER_INSTANCE_TIMEOUT_MS;
	const start = performance.now();
	const totals = emptyUsage();

	const child = spawn(args[0]!, args.slice(1), {
		cwd: scratchDir,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
		env: { ...process.env, PI_OFFLINE: "1" },
	});

	let stderrBuf = "";
	let stdoutBuf = "";
	let killedForTimeout = false;

	const timeoutHandle = setTimeout(() => {
		killedForTimeout = true;
		try {
			child.kill("SIGKILL");
		} catch {
			/* ignore */
		}
	}, timeoutMs);

	child.stdout.setEncoding("utf-8");
	child.stderr.setEncoding("utf-8");

	child.stdout.on("data", (chunk: string) => {
		stdoutBuf += chunk;
		// Parse line-by-line to avoid buffering an entire large run.
		let nl = stdoutBuf.indexOf("\n");
		while (nl !== -1) {
			const line = stdoutBuf.slice(0, nl).trim();
			stdoutBuf = stdoutBuf.slice(nl + 1);
			if (line.length > 0) {
				try {
					const evt = JSON.parse(line);
					if (isRecord(evt)) parseUsageEvent(evt, totals);
				} catch {
					/* not JSON; ignore (text-mode output shouldn't happen with --mode json) */
				}
			}
			nl = stdoutBuf.indexOf("\n");
		}
	});

	child.stderr.on("data", (chunk: string) => {
		stderrBuf += chunk;
		if (stderrBuf.length > 16_000) {
			stderrBuf = stderrBuf.slice(-16_000);
		}
	});

	const exitCode: number | null = await new Promise((resolve) => {
		child.on("close", (code) => resolve(code));
		child.on("error", () => resolve(null));
	});
	clearTimeout(timeoutHandle);

	const wallTimeSec = (performance.now() - start) / 1000;
	const patch = await captureDiff(scratchDir);

	const stderrTail = killedForTimeout
		? `[killed at ${timeoutMs}ms timeout]\n${stderrBuf.slice(-1200)}`
		: stderrBuf.slice(-1200);

	return {
		...baseResult,
		patch,
		wallTimeSec: Math.round(wallTimeSec * 10) / 10,
		usage: totals,
		thetaExitCode: exitCode,
		thetaStderrTail: stderrTail,
	};
}

/** Persist the per-run result next to the pilot directory. */
export function writeRunArtifact(result: RunResult, outDir: string): void {
	mkdirSync(outDir, { recursive: true });
	const idSafe = result.instance.instance_id.replace(/[^\w-]/g, "_");
	writeFileSync(
		join(outDir, `${idSafe}.json`),
		JSON.stringify(
			{
				instance_id: result.instance.instance_id,
				repo: result.instance.repo,
				base_commit: result.instance.base_commit,
				clonedOk: result.clonedOk,
				clonedAt: result.clonedAt,
				scratchDir: result.scratchDir,
				wallTimeSec: result.wallTimeSec,
				usage: result.usage,
				thetaExitCode: result.thetaExitCode,
				thetaStderrTail: result.thetaStderrTail,
				patchLength: result.patch.length,
				patch: result.patch,
			},
			null,
			2,
		),
		"utf-8",
	);
}

