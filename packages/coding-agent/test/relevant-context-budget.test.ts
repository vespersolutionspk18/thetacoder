/**
 * F1 getRelevantContext — budget truncation.
 *
 * A small budget should cause the result to truncate the candidate
 * set and report `truncated: true` plus the pre-truncation count in
 * `totalCandidates`.
 */

import { describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { getRelevantContext } from "../src/core/repository/relevant-context.ts";

function makeManifest(): FileManifestEntry[] {
	const out: FileManifestEntry[] = [];
	for (let i = 0; i < 30; i += 1) {
		out.push({
			path: `src/file${i}.ts`,
			absolutePath: `/abs/src/file${i}.ts`,
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		});
	}
	return out;
}

describe("getRelevantContext — budget", () => {
	it("truncates to the budget when more candidates exist", async () => {
		const result = await getRelevantContext(
			{ task: "audit", hints: { explicitPaths: makeManifest().map((m) => m.path), budget: 5 } },
			makeManifest(),
			[],
		);
		expect(result.items.length).toBe(5);
		expect(result.truncated).toBe(true);
		expect(result.totalCandidates).toBe(30);
	});

	it("does not mark truncated when candidates fit within the budget", async () => {
		const result = await getRelevantContext(
			{ task: "audit", hints: { explicitPaths: ["src/file0.ts", "src/file1.ts"], budget: 5 } },
			makeManifest(),
			[],
		);
		expect(result.items.length).toBe(2);
		expect(result.truncated).toBe(false);
		expect(result.totalCandidates).toBe(2);
	});

	it("uses the default budget of 50 when no budget is set", async () => {
		const result = await getRelevantContext({ task: "audit" }, makeManifest(), []);
		// No hints => no items, default budget applies but does not truncate.
		expect(result.truncated).toBe(false);
		expect(result.items.length).toBe(0);
	});
});

