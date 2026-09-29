/**
 * F2 evidence freshness — `ageMs` is the gap between `checkedAt` and
 * the recorded `changedAt`.
 */

import { describe, expect, it } from "vitest";
import { checkEvidenceFreshness } from "../src/core/evidence-freshness.ts";
import { createInitialTaskState, type TaskState } from "../src/core/task-state.ts";

describe("F2 evidence freshness — age", () => {
	it("reports ageMs >= the gap between now and changedAt", () => {
		const now = 1_700_000_000_000;
		const sixtySecondsAgo = now - 60_000;
		let state: TaskState = createInitialTaskState("s");
		state = {
			...state,
			changedFiles: [
				{
					path: "src/a.ts",
					contentHash: "hash-a",
					changedAt: sixtySecondsAgo,
				},
			],
		};

		const latestHashes = new Map<string, string>([["src/a.ts", "hash-a"]]);

		const report = checkEvidenceFreshness({ taskState: state, latestHashes, now });

		expect(report.checks).toHaveLength(1);
		const check = report.checks[0]!;
		expect(check.capturedAt).toBe(sixtySecondsAgo);
		expect(check.checkedAt).toBe(now);
		expect(check.ageMs).toBeGreaterThanOrEqual(60_000);
		expect(check.ageMs).toBe(60_000);
	});
});

