/**
 * F2 evidence freshness — when `taskState` is `undefined`, the report
 * is empty (nothing to check).
 */

import { describe, expect, it } from "vitest";
import { checkEvidenceFreshness } from "../src/core/evidence-freshness.ts";

describe("F2 evidence freshness — empty taskState", () => {
	it("returns an empty report when taskState is undefined", () => {
		const latestHashes = new Map<string, string>([["src/a.ts", "hash-a"]]);

		const report = checkEvidenceFreshness({ taskState: undefined, latestHashes });

		expect(report.checks).toEqual([]);
		expect(report.freshCount).toBe(0);
		expect(report.staleCount).toBe(0);
		expect(report.missingCount).toBe(0);
		expect(report.unknownCount).toBe(0);
	});
});

