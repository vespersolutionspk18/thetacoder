/**
 * F2 evidence freshness — read-tool wiring (success path).
 *
 * `captureReadResultForFreshness` is the SDK-side helper that observes
 * successful `read` tool results and updates the
 * `_latestEvidenceHashes` map the freshness check consults. This
 * test exercises the success path: a successful read with a usable
 * `contentIdentity` must record `path → contentIdentity` in the map
 * and `checkEvidenceFreshness` must then resolve the recorded file
 * as `fresh`.
 */

import { describe, expect, it } from "vitest";
import { captureReadResultForFreshness, checkEvidenceFreshness } from "../src/core/evidence-freshness.ts";
import { createInitialTaskState, recordChange, type TaskState } from "../src/core/task-state.ts";

describe("F2 evidence freshness — read wiring (success path)", () => {
	it("records path → contentIdentity in the map when a successful read returns a contentIdentity", () => {
		const latestHashes = new Map<string, string>();
		const args = { path: "src/a.ts", offset: 0, limit: 100 };
		const result = { details: { contentIdentity: "hash-a" } };

		const updated = captureReadResultForFreshness(latestHashes, {
			toolName: "read",
			args,
			result,
			isError: false,
		});

		expect(updated).toBe(true);
		expect(latestHashes.size).toBe(1);
		expect(latestHashes.get("src/a.ts")).toBe("hash-a");
	});

	it("lets checkEvidenceFreshness resolve the file as fresh when the read hash matches the recorded hash", () => {
		const latestHashes = new Map<string, string>();
		captureReadResultForFreshness(latestHashes, {
			toolName: "read",
			args: { path: "src/a.ts" },
			result: { details: { contentIdentity: "hash-a" } },
			isError: false,
		});

		const now = 1_700_000_000_000;
		let state: TaskState = createInitialTaskState("s");
		state = recordChange(state, { path: "src/a.ts", contentHash: "hash-a" });

		const report = checkEvidenceFreshness({ taskState: state, latestHashes, now });

		expect(report.checks).toHaveLength(1);
		expect(report.freshCount).toBe(1);
		expect(report.staleCount).toBe(0);
		expect(report.missingCount).toBe(0);
		expect(report.checks[0]?.status).toBe("fresh");
		expect(report.checks[0]?.actualHash).toBe("hash-a");
	});

	it("overwrites a stale entry when a subsequent read returns a new hash for the same path", () => {
		const latestHashes = new Map<string, string>();
		captureReadResultForFreshness(latestHashes, {
			toolName: "read",
			args: { path: "src/a.ts" },
			result: { details: { contentIdentity: "hash-old" } },
			isError: false,
		});
		// Simulate the file being modified and re-read.
		captureReadResultForFreshness(latestHashes, {
			toolName: "read",
			args: { path: "src/a.ts" },
			result: { details: { contentIdentity: "hash-new" } },
			isError: false,
		});

		expect(latestHashes.get("src/a.ts")).toBe("hash-new");
	});

	it("records multiple paths independently across successive reads", () => {
		const latestHashes = new Map<string, string>();
		captureReadResultForFreshness(latestHashes, {
			toolName: "read",
			args: { path: "src/a.ts" },
			result: { details: { contentIdentity: "hash-a" } },
			isError: false,
		});
		captureReadResultForFreshness(latestHashes, {
			toolName: "read",
			args: { path: "src/b.ts" },
			result: { details: { contentIdentity: "hash-b" } },
			isError: false,
		});

		expect(latestHashes.size).toBe(2);
		expect(latestHashes.get("src/a.ts")).toBe("hash-a");
		expect(latestHashes.get("src/b.ts")).toBe("hash-b");
	});
});

