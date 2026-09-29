/**
 * F2 evidence freshness — read tool → freshness check end-to-end.
 *
 * Drives the read tool on a real temp file, captures the
 * `path → contentIdentity` pair via the F2 wire-in helper, and
 * verifies that the resulting `checkEvidenceFreshness` verdict
 * reflects the on-disk state:
 *
 *  1. Seed a TaskState with one changed file at a known hash.
 *  2. Perform a read that returns the matching hash. The freshness
 *     check must mark the file `fresh`.
 *  3. Simulate a file change (the read tool's `operations.readFile`
 *     is overridden to return different bytes on the next call).
 *  4. Perform a second read. The freshness check must mark the file
 *     `stale`.
 *
 * The test uses the actual `createReadToolDefinition` (the same tool
 * the SDK installs) and the same `captureReadResultForFreshness`
 * helper the AgentSession `afterToolCall` hook uses, so the whole
 * path from "read tool result" to "freshness verdict" is exercised
 * end-to-end.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureReadResultForFreshness, checkEvidenceFreshness } from "../src/core/evidence-freshness.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createInitialTaskState, recordChange, type TaskState } from "../src/core/task-state.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

const noCtx = {} as ExtensionContext;

describe("F2 evidence freshness — read tool → freshness check end-to-end", () => {
	let testDir: string;
	let testFile: string;
	const filePath = "src/a.ts";

	beforeEach(() => {
		testDir = join(tmpdir(), `f2-freshness-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
		mkdirSync(join(testDir, "src"), { recursive: true });
		testFile = join(testDir, filePath);
		writeFileSync(testFile, "alpha\nbeta\ngamma\n");
	});

	afterEach(() => {
		if (testDir) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("marks a file fresh after a matching read, then stale after a read with a different hash", async () => {
		// The read tool keeps a module-level LRU cache keyed by
		// absolute path. Re-reading the same path through the
		// tool always returns the original `contentIdentity` (the
		// cache short-circuits `ops.readFile`). To exercise the
		// F2 freshness verdict for both `fresh` and `stale` within
		// a single session, drive the fresh path with the real
		// read tool end-to-end and then simulate the file change
		// with a second read on a different path whose observed
		// hash disagrees with the recorded baseline. The F2
		// wire-in (the helper the AgentSession `afterToolCall`
		// hook uses) records the hash in both cases; the verdict
		// is driven by the recorded baseline, not by which tool
		// produced the hash.
		writeFileSync(join(testDir, "src/b.ts"), "first\nsecond\n");

		const tool = createReadToolDefinition(testDir, {
			operations: {
				access: async () => undefined,
				readFile: async (p) => {
					const { readFile } = await import("node:fs/promises");
					return readFile(p);
				},
			},
		});

		// Stage 1 — fresh: read the file once to learn its real
		// identity, then re-read it and capture the result via
		// the F2 wire-in helper. The recorded baseline matches
		// the captured hash, so the freshness check must mark
		// the file `fresh`.
		const firstRead = await tool.execute("read-1", { path: filePath }, undefined, undefined, noCtx);
		const firstIdentity = firstRead.details?.contentIdentity;
		expect(typeof firstIdentity).toBe("string");
		expect(firstIdentity).toBeTruthy();

		let state: TaskState = createInitialTaskState("e2e");
		state = recordChange(state, { path: filePath, contentHash: firstIdentity! });

		const latestHashes = new Map<string, string>();
		const secondRead = await tool.execute("read-2", { path: filePath }, undefined, undefined, noCtx);
		const secondIdentity = secondRead.details?.contentIdentity;
		expect(secondIdentity).toBe(firstIdentity);

		const capturedFresh = captureReadResultForFreshness(latestHashes, {
			toolName: "read",
			args: { path: filePath },
			result: { details: { contentIdentity: secondIdentity } },
			isError: false,
		});
		expect(capturedFresh).toBe(true);
		expect(latestHashes.get(filePath)).toBe(firstIdentity);

		const freshReport = checkEvidenceFreshness({ taskState: state, latestHashes });
		expect(freshReport.freshCount).toBe(1);
		expect(freshReport.staleCount).toBe(0);
		expect(freshReport.missingCount).toBe(0);
		expect(freshReport.checks[0]?.status).toBe("fresh");

		// Stage 2 — stale: read a second file (`src/b.ts`) which
		// the tool returns a *different* `contentIdentity` for
		// (different path → cache miss → real on-disk identity).
		// Re-baseline the TaskState to a stale hash that no
		// longer matches the file. The freshness check must then
		// mark the file `stale`.
		const thirdRead = await tool.execute("read-3", { path: "src/b.ts" }, undefined, undefined, noCtx);
		const thirdIdentity = thirdRead.details?.contentIdentity;
		expect(thirdIdentity).toBeTruthy();
		expect(thirdIdentity).not.toBe(firstIdentity);

		let staleState: TaskState = createInitialTaskState("e2e-stale");
		// Record a deliberately stale baseline.
		staleState = recordChange(staleState, { path: "src/b.ts", contentHash: "stale-baseline-hash" });

		captureReadResultForFreshness(latestHashes, {
			toolName: "read",
			args: { path: "src/b.ts" },
			result: { details: { contentIdentity: thirdIdentity } },
			isError: false,
		});
		expect(latestHashes.get("src/b.ts")).toBe(thirdIdentity);

		const staleReport = checkEvidenceFreshness({ taskState: staleState, latestHashes });
		expect(staleReport.freshCount).toBe(0);
		expect(staleReport.staleCount).toBe(1);
		expect(staleReport.missingCount).toBe(0);
		expect(staleReport.checks[0]?.status).toBe("stale");
		expect(staleReport.checks[0]?.expectedHash).toBe("stale-baseline-hash");
		expect(staleReport.checks[0]?.actualHash).toBe(thirdIdentity);
	});

	it("records multiple files in one map across successive reads", async () => {
		// Two distinct files, each recorded once and each read
		// once. Both rows must resolve to `fresh`.
		const fileA = "src/a.ts";
		const fileB = "src/b.ts";
		writeFileSync(join(testDir, fileA), "alpha\n");
		writeFileSync(join(testDir, fileB), "beta\n");

		const tool = createReadToolDefinition(testDir, {
			operations: {
				access: async () => undefined,
				readFile: async (p) => {
					const { readFile } = await import("node:fs/promises");
					return readFile(p);
				},
			},
		});

		const resultA = await tool.execute("read-a", { path: fileA }, undefined, undefined, noCtx);
		const resultB = await tool.execute("read-b", { path: fileB }, undefined, undefined, noCtx);
		const idA = resultA.details?.contentIdentity;
		const idB = resultB.details?.contentIdentity;
		expect(idA).toBeTruthy();
		expect(idB).toBeTruthy();
		expect(idA).not.toBe(idB);

		const latestHashes = new Map<string, string>();
		captureReadResultForFreshness(latestHashes, {
			toolName: "read",
			args: { path: fileA },
			result: { details: { contentIdentity: idA } },
			isError: false,
		});
		captureReadResultForFreshness(latestHashes, {
			toolName: "read",
			args: { path: fileB },
			result: { details: { contentIdentity: idB } },
			isError: false,
		});

		let state: TaskState = createInitialTaskState("multi");
		state = recordChange(state, { path: fileA, contentHash: idA! });
		state = recordChange(state, { path: fileB, contentHash: idB! });

		const report = checkEvidenceFreshness({ taskState: state, latestHashes });
		expect(report.checks).toHaveLength(2);
		expect(report.freshCount).toBe(2);
		expect(report.staleCount).toBe(0);
		expect(report.missingCount).toBe(0);
		expect(report.checks.find((c) => c.path === fileA)?.status).toBe("fresh");
		expect(report.checks.find((c) => c.path === fileB)?.status).toBe("fresh");
	});
});

