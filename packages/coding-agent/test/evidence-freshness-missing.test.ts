/**
 * F2 evidence freshness — `missing` status when the caller has no
 * information about a path (the path is absent from `latestHashes`).
 */

import { describe, expect, it } from "vitest";
import { checkEvidenceFreshness } from "../src/core/evidence-freshness.ts";
import { createInitialTaskState, recordChange, type TaskState } from "../src/core/task-state.ts";

describe("F2 evidence freshness — missing", () => {
	it("returns a single missing check when latestHashes does not contain the path", () => {
		const now = 1_700_000_000_000;
		let state: TaskState = createInitialTaskState("s");
		state = recordChange(state, { path: "src/a.ts", contentHash: "hash-a" });

		const latestHashes = new Map<string, string>();

		const report = checkEvidenceFreshness({ taskState: state, latestHashes, now });

		expect(report.checks).toHaveLength(1);
		expect(report.freshCount).toBe(0);
		expect(report.staleCount).toBe(0);
		expect(report.missingCount).toBe(1);
		expect(report.unknownCount).toBe(0);

		const check = report.checks[0]!;
		expect(check.path).toBe("src/a.ts");
		expect(check.expectedHash).toBe("hash-a");
		expect(check.actualHash).toBe("");
		expect(check.status).toBe("missing");
	});
});

