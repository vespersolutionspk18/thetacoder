/**
 * SWE-bench Verified instance loader for the mini-pilot.
 *
 * Strategy: we hard-code a small, hand-picked set of easy instances. The
 * selection criteria (mirrors SWEBENCH_PLAN.md §2):
 *   - "<15 min fix" difficulty tag from the dataset
 *   - small repo (psf/requests, pallets/flask, pytest-dev/pytest,
 *     pylint-dev/pylint, mwaskom/seaborn) so the clone step is fast
 *   - small `patch` (≤ ~10 added+removed lines) so a single agent turn
 *     can plausibly reproduce it
 *   - low FAIL_TO_PASS count (≤ 2) so a single targeted fix passes
 *
 * The set is persisted to `instances.json` next to this file so re-runs are
 * reproducible. The full 500-instance metadata sits in
 * `.swe-bench-scratch/instances.jsonl` if anyone wants to swap selections.
 *
 * Public API:
 *   - `loadInstances()`  returns the persisted list (throws if absent)
 *   - `getInstance(id)`  returns a single instance or undefined
 *   - `PILOT_INSTANCE_IDS`  the canonical selection (in run order)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PERSIST_PATH = join(__dirname, "instances.json");

/** Curated 7-instance pilot set (run order = first-to-last). */
export const PILOT_INSTANCE_IDS: readonly string[] = [
	"pallets__flask-5014",
	"psf__requests-1142",
	"psf__requests-5414",
	"pylint-dev__pylint-4970",
	"pytest-dev__pytest-5809",
	"psf__requests-1921",
	"pytest-dev__pytest-7982",
];

export interface PilotInstance {
	instance_id: string;
	repo: string;
	base_commit: string;
	problem_statement: string;
	patch: string;
	test_patch: string;
	FAIL_TO_PASS: string[];
	PASS_TO_PASS: string[];
	environment_setup_commit: string;
	difficulty: string;
}

/** Type-guard for the JSONL row shape we expect. */
function parseRow(row: Record<string, unknown>): PilotInstance | null {
	const id = row.instance_id;
	const repo = row.repo;
	const base_commit = row.base_commit;
	if (typeof id !== "string" || typeof repo !== "string" || typeof base_commit !== "string") {
		return null;
	}
	const f2pRaw = row.FAIL_TO_PASS;
	const p2pRaw = row.PASS_TO_PASS;
	let FAIL_TO_PASS: string[] = [];
	let PASS_TO_PASS: string[] = [];
	if (typeof f2pRaw === "string" && f2pRaw.length > 0) {
		try {
			FAIL_TO_PASS = JSON.parse(f2pRaw);
		} catch {
			FAIL_TO_PASS = [];
		}
	}
	if (typeof p2pRaw === "string" && p2pRaw.length > 0) {
		try {
			PASS_TO_PASS = JSON.parse(p2pRaw);
		} catch {
			PASS_TO_PASS = [];
		}
	}
	return {
		instance_id: id,
		repo,
		base_commit,
		problem_statement: typeof row.problem_statement === "string" ? row.problem_statement : "",
		patch: typeof row.patch === "string" ? row.patch : "",
		test_patch: typeof row.test_patch === "string" ? row.test_patch : "",
		FAIL_TO_PASS,
		PASS_TO_PASS,
		environment_setup_commit:
			typeof row.environment_setup_commit === "string" ? row.environment_setup_commit : base_commit,
		difficulty: typeof row.difficulty === "string" ? row.difficulty : "",
	};
}

/**
 * Read the JSONL produced by `.swe-bench-scratch/download.py` and pick the
 * pilot subset. Throws if the file is missing — the download step must run
 * first.
 */
function loadFromJsonl(): PilotInstance[] {
	const jsonlPath = join(__dirname, "..", "..", "..", "..", ".swe-bench-scratch", "instances.jsonl");
	if (!existsSync(jsonlPath)) {
		throw new Error(
			`SWE-bench metadata not found at ${jsonlPath}. Run \`python .swe-bench-scratch/download.py\` first.`,
		);
	}
	const text = readFileSync(jsonlPath, "utf-8");
	const wanted = new Set(PILOT_INSTANCE_IDS);
	const out: PilotInstance[] = [];
	const seen = new Set<string>();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let row: Record<string, unknown>;
		try {
			row = JSON.parse(trimmed);
		} catch {
			continue;
		}
		const parsed = parseRow(row);
		if (!parsed) continue;
		if (!wanted.has(parsed.instance_id)) continue;
		if (seen.has(parsed.instance_id)) continue;
		seen.add(parsed.instance_id);
		out.push(parsed);
	}
	if (out.length !== PILOT_INSTANCE_IDS.length) {
		const found = new Set(out.map((o) => o.instance_id));
		const missing = PILOT_INSTANCE_IDS.filter((id) => !found.has(id));
		throw new Error(`Missing pilot instances in metadata: ${missing.join(", ")}`);
	}
	// Re-order to match PILOT_INSTANCE_IDS exactly.
	const byId = new Map(out.map((o) => [o.instance_id, o]));
	return PILOT_INSTANCE_IDS.map((id) => {
		const x = byId.get(id);
		if (!x) throw new Error(`unreachable: ${id} just disappeared`);
		return x;
	});
}

function loadFromPersist(): PilotInstance[] | null {
	if (!existsSync(PERSIST_PATH)) return null;
	try {
		const text = readFileSync(PERSIST_PATH, "utf-8");
		const arr = JSON.parse(text) as PilotInstance[];
		if (!Array.isArray(arr) || arr.length === 0) return null;
		return arr;
	} catch {
		return null;
	}
}

export function loadInstances(): PilotInstance[] {
	const persisted = loadFromPersist();
	if (persisted) return persisted;
	const fresh = loadFromJsonl();
	writeFileSync(PERSIST_PATH, JSON.stringify(fresh, null, 2), "utf-8");
	return fresh;
}

export function getInstance(id: string): PilotInstance | undefined {
	return loadInstances().find((i) => i.instance_id === id);
}

