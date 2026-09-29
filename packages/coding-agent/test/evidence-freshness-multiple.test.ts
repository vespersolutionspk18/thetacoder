/**
 * F2 evidence freshness — mixed verdicts across multiple changed
 * files. The aggregated counts must be correct.
 */

import { describe, expect, it } from "vitest";
import { checkEvidenceFreshness } from "../src/core/evidence-freshness.ts";
import { createInitialTaskState, recordChange, type TaskState } from "../src/core/task-state.ts";

describe("F2 evidence freshness — multiple files", () => {
	it("aggregates fresh / stale / missing counts across 3 changed files", () => {
		const now = 1_700_000_000_000;
		let state: TaskState = createInitialTaskState("s");
		state = recordChange(state, { path: "src/fresh.ts", contentHash: "h-fresh" });
		state = recordChange(state, { path: "src/stale.ts", contentHash: "h-old" });
		state = recordChange(state, { path: "src/missing.ts", contentHash: "h-missing" });

		const latestHashes = new Map<string, string>([
			["src/fresh.ts", "h-fresh"], // matches → fresh
			["src/stale.ts", "h-new"], // differs → stale
			// src/missing.ts intentionally absent → missing
		]);

		const report = checkEvidenceFreshness({ taskState: state, latestHashes, now });

		expect(report.checks).toHaveLength(3);
		expect(report.freshCount).toBe(1);
		expect(report.staleCount).toBe(1);
		expect(report.missingCount).toBe(1);
		expect(report.unknownCount).toBe(0);

		const byPath = new Map(report.checks.map((c) => [c.path, c]));
		expect(byPath.get("src/fresh.ts")?.status).toBe("fresh");
		expect(byPath.get("src/stale.ts")?.status).toBe("stale");
		expect(byPath.get("src/missing.ts")?.status).toBe("missing");
	});
});

