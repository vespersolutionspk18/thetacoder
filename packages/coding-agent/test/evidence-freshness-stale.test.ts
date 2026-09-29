/**
 * F2 evidence freshness — `stale` status when the latest known hash
 * differs from the hash recorded in `TaskState.changedFiles`.
 */

import { describe, expect, it } from "vitest";
import { checkEvidenceFreshness } from "../src/core/evidence-freshness.ts";
import { createInitialTaskState, recordChange, type TaskState } from "../src/core/task-state.ts";

describe("F2 evidence freshness — stale", () => {
	it("returns a single stale check when latestHashes has a different hash", () => {
		const now = 1_700_000_000_000;
		let state: TaskState = createInitialTaskState("s");
		state = recordChange(state, { path: "src/a.ts", contentHash: "hash-old" });

		const latestHashes = new Map<string, string>([["src/a.ts", "hash-new"]]);

		const report = checkEvidenceFreshness({ taskState: state, latestHashes, now });

		expect(report.checks).toHaveLength(1);
		expect(report.freshCount).toBe(0);
		expect(report.staleCount).toBe(1);
		expect(report.missingCount).toBe(0);
		expect(report.unknownCount).toBe(0);

		const check = report.checks[0]!;
		expect(check.path).toBe("src/a.ts");
		expect(check.expectedHash).toBe("hash-old");
		expect(check.actualHash).toBe("hash-new");
		expect(check.status).toBe("stale");
	});
});

