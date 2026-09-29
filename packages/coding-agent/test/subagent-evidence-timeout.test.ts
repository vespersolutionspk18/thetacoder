/**
 * F10 subagent evidence sharing — timeout vs child-exit behavior.
 *
 * `consumeChildEvidence` returns when **either** the child process
 * exits **or** the configured timeout elapses. These tests exercise
 * both branches with a real `node` child so the pid-exit and
 * timeout code paths run end-to-end.
 */

import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { InMemorySharedEvidenceStore } from "../src/core/repository/shared-evidence.ts";
import { createSharedEvidenceConsumer } from "../src/core/repository/shared-evidence-consumer.ts";
import { consumeChildEvidence, makeSubagentStorePath } from "../src/core/subagent-evidence-share.ts";

/* -------------------------------------------------------------------------- */
/* Child worker scripts                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Quick-exit child: write one record, then exit immediately (no
 * setTimeout). Used to verify the parent returns when the child
 * process exits before the configured timeout.
 *
 * With `node -e <script> <path>`, additional args start at
 * `process.argv[1]`.
 */
const QUICK_EXIT_SCRIPT = `
const fs = require('fs');
const path = process.argv[1];
const record = {
  id: 'quick-exit-1',
  kind: 'file-content',
  source: 'child',
  createdAt: Date.now(),
  payload: { path: '/repo/src/quick.ts', content: 'q\\n', byteLength: 2 },
  contentHash: 'h-quick'
};
fs.writeFileSync(path, JSON.stringify({ version: 1, entries: [record] }), 'utf-8');
process.exit(0);
`;

/**
 * Long-running child: write one record, then sleep long enough
 * that the parent's timeout fires before the child exits.
 */
const LONG_RUNNING_SCRIPT = `
const fs = require('fs');
const path = process.argv[1];
const record = {
  id: 'long-1',
  kind: 'file-content',
  source: 'child',
  createdAt: Date.now(),
  payload: { path: '/repo/src/long.ts', content: 'l\\n', byteLength: 2 },
  contentHash: 'h-long'
};
fs.writeFileSync(path, JSON.stringify({ version: 1, entries: [record] }), 'utf-8');
setTimeout(() => process.exit(0), 30_000);
`;

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("consumeChildEvidence — child exits vs timeout", () => {
	let cleanup: (() => Promise<void>) | null = null;
	const children: Array<ReturnType<typeof spawn>> = [];

	afterEach(async () => {
		for (const child of children) {
			if (!child.killed) child.kill();
		}
		children.length = 0;
		if (cleanup) {
			await cleanup();
			cleanup = null;
		}
	});

	it("returns the consumed evidence when the child exits before the timeout", async () => {
		const tmp = await makeSubagentStorePath("timeout-exit");
		cleanup = tmp.cleanup;

		const parentStore = new InMemorySharedEvidenceStore();
		const parentConsumer = createSharedEvidenceConsumer({ store: parentStore, source: "parent" });

		const child = spawn(process.execPath, ["-e", QUICK_EXIT_SCRIPT, tmp.path], { stdio: "ignore" });
		children.push(child);
		const childPid = child.pid;
		expect(childPid).toBeDefined();
		if (childPid === undefined) throw new Error("child did not get a pid");

		const result = await consumeChildEvidence(parentConsumer, tmp.path, childPid, {
			pollIntervalMs: 25,
			timeoutMs: 10_000,
			childSource: "child",
		});

		// The child exited cleanly, so the parent must not have
		// timed out — and must have observed the record.
		expect(result.timedOut).toBe(false);
		expect(result.consumed).toHaveLength(1);
		expect(result.consumed[0].id).toBe("quick-exit-1");
		expect(result.consumed[0].contentHash).toBe("h-quick");
	});

	it("returns with timedOut: true and the partial evidence when the timeout fires first", async () => {
		const tmp = await makeSubagentStorePath("timeout-fires");
		cleanup = tmp.cleanup;

		const parentStore = new InMemorySharedEvidenceStore();
		const parentConsumer = createSharedEvidenceConsumer({ store: parentStore, source: "parent" });

		const child = spawn(process.execPath, ["-e", LONG_RUNNING_SCRIPT, tmp.path], { stdio: "ignore" });
		children.push(child);
		const childPid = child.pid;
		expect(childPid).toBeDefined();
		if (childPid === undefined) throw new Error("child did not get a pid");

		const start = Date.now();
		const result = await consumeChildEvidence(parentConsumer, tmp.path, childPid, {
			pollIntervalMs: 25,
			// Short timeout so the test does not wait the full 30 s
			// the child would otherwise run.
			timeoutMs: 400,
			childSource: "child",
		});
		const elapsed = Date.now() - start;

		// The function should have returned roughly when the
		// timeout fired, not when the child (30 s) would have
		// exited. A generous upper bound accounts for one extra
		// poll cycle and the first tick before the deadline.
		expect(elapsed).toBeLessThan(2_000);

		expect(result.timedOut).toBe(true);
		// The record was still on disk by the time the timeout
		// fired, so the parent must have observed it.
		expect(result.consumed).toHaveLength(1);
		expect(result.consumed[0].id).toBe("long-1");
	});

	it("exits promptly even when the child never wrote any evidence", async () => {
		const tmp = await makeSubagentStorePath("timeout-empty");
		cleanup = tmp.cleanup;

		const parentStore = new InMemorySharedEvidenceStore();
		const parentConsumer = createSharedEvidenceConsumer({ store: parentStore, source: "parent" });

		// A child that runs long but writes nothing. This is the
		// "child hangs" scenario — the parent must not hang with it.
		const HANG_SCRIPT = `
			setTimeout(() => process.exit(0), 30_000);
		`;
		const child = spawn(process.execPath, ["-e", HANG_SCRIPT], { stdio: "ignore" });
		children.push(child);
		const childPid = child.pid;
		expect(childPid).toBeDefined();
		if (childPid === undefined) throw new Error("child did not get a pid");

		const start = Date.now();
		const result = await consumeChildEvidence(parentConsumer, tmp.path, childPid, {
			pollIntervalMs: 25,
			timeoutMs: 300,
		});
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(2_000);
		expect(result.timedOut).toBe(true);
		expect(result.consumed).toEqual([]);
	});
});

