/**
 * F10 subagent evidence sharing — child → parent consumption.
 *
 * The parent spawns a child that writes a file-content evidence
 * record into the subagent's backing file and exits. The parent's
 * `consumeChildEvidence` polls the file, observes the record, and
 * returns when the child process exits.
 *
 * The "child" is a real `node` process so the pid-exit branch of
 * `consumeChildEvidence` is exercised end-to-end.
 */

import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { InMemorySharedEvidenceStore } from "../src/core/repository/shared-evidence.ts";
import { createSharedEvidenceConsumer } from "../src/core/repository/shared-evidence-consumer.ts";
import { consumeChildEvidence, makeSubagentStorePath } from "../src/core/subagent-evidence-share.ts";

/* -------------------------------------------------------------------------- */
/* Child worker script                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Inline CommonJS script: write one `file-content` evidence record
 * to the path passed as `process.argv[2]`, sleep briefly so the
 * parent can observe the file in two consecutive ticks, then exit.
 *
 * With `node -e <script> <path>`, additional args start at
 * `process.argv[1]` (the script itself is consumed by `-e` and
 * does not appear in `argv`).
 */
const CHILD_SCRIPT = `
const fs = require('fs');
const path = process.argv[1];
const record = {
  id: 'child-evidence-1',
  kind: 'file-content',
  source: 'child',
  createdAt: Date.now(),
  payload: { path: '/repo/src/child-wrote.ts', content: 'child content\\n', byteLength: 14 },
  contentHash: 'h-child'
};
const file = { version: 1, entries: [record] };
fs.writeFileSync(path, JSON.stringify(file), 'utf-8');
setTimeout(() => process.exit(0), 200);
`;

/** A second child that writes a different record with the same source. */
const CHILD_SCRIPT_TWO_RECORDS = `
const fs = require('fs');
const path = process.argv[1];
const records = [
  {
    id: 'child-evidence-2a',
    kind: 'file-content',
    source: 'child',
    createdAt: Date.now(),
    payload: { path: '/repo/src/a.ts', content: 'a\\n', byteLength: 2 },
    contentHash: 'h-a'
  },
  {
    id: 'child-evidence-2b',
    kind: 'file-manifest',
    source: 'child',
    createdAt: Date.now(),
    payload: { root: '/repo' }
  }
];
const file = { version: 1, entries: records };
fs.writeFileSync(path, JSON.stringify(file), 'utf-8');
setTimeout(() => process.exit(0), 200);
`;

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("consumeChildEvidence — child publishes, parent observes", () => {
	let cleanup: (() => Promise<void>) | null = null;
	let child: ReturnType<typeof spawn> | null = null;

	afterEach(async () => {
		if (child && !child.killed) {
			child.kill();
		}
		child = null;
		if (cleanup) {
			await cleanup();
			cleanup = null;
		}
	});

	it("parent sees the new file-content evidence the child published", async () => {
		const tmp = await makeSubagentStorePath("consume-basic");
		cleanup = tmp.cleanup;

		const parentStore = new InMemorySharedEvidenceStore();
		const parentConsumer = createSharedEvidenceConsumer({ store: parentStore, source: "parent" });

		// Spawn the child BEFORE starting to poll, so the file is
		// already populated by the time the first tick fires.
		child = spawn(process.execPath, ["-e", CHILD_SCRIPT, tmp.path], { stdio: "ignore" });
		const childPid = child.pid;
		expect(childPid).toBeDefined();
		if (childPid === undefined) throw new Error("child did not get a pid");

		const result = await consumeChildEvidence(parentConsumer, tmp.path, childPid, {
			pollIntervalMs: 25,
			timeoutMs: 5_000,
			childSource: "child",
		});

		expect(result.timedOut).toBe(false);
		expect(result.consumed).toHaveLength(1);
		const consumed = result.consumed[0];
		expect(consumed.kind).toBe("file-content");
		expect(consumed.source).toBe("child");
		expect(consumed.contentHash).toBe("h-child");
		const payload = consumed.payload as { path: string; content: string };
		expect(payload.path).toBe("/repo/src/child-wrote.ts");
		expect(payload.content).toBe("child content\n");
	});

	it("ignores records from sources other than the child's when childSource is set", async () => {
		const tmp = await makeSubagentStorePath("consume-source-filter");
		cleanup = tmp.cleanup;

		const parentStore = new InMemorySharedEvidenceStore();
		const parentConsumer = createSharedEvidenceConsumer({ store: parentStore, source: "parent" });

		child = spawn(process.execPath, ["-e", CHILD_SCRIPT, tmp.path], { stdio: "ignore" });
		const childPid = child.pid;
		expect(childPid).toBeDefined();
		if (childPid === undefined) throw new Error("child did not get a pid");

		// Filter for a source the child does NOT use.
		const result = await consumeChildEvidence(parentConsumer, tmp.path, childPid, {
			pollIntervalMs: 25,
			timeoutMs: 5_000,
			childSource: "some-other-source",
		});

		expect(result.timedOut).toBe(false);
		expect(result.consumed).toEqual([]);
	});

	it("collects multiple records the child published in a single batch", async () => {
		const tmp = await makeSubagentStorePath("consume-multi");
		cleanup = tmp.cleanup;

		const parentStore = new InMemorySharedEvidenceStore();
		const parentConsumer = createSharedEvidenceConsumer({ store: parentStore, source: "parent" });

		child = spawn(process.execPath, ["-e", CHILD_SCRIPT_TWO_RECORDS, tmp.path], { stdio: "ignore" });
		const childPid = child.pid;
		expect(childPid).toBeDefined();
		if (childPid === undefined) throw new Error("child did not get a pid");

		const result = await consumeChildEvidence(parentConsumer, tmp.path, childPid, {
			pollIntervalMs: 25,
			timeoutMs: 5_000,
			childSource: "child",
		});

		expect(result.timedOut).toBe(false);
		expect(result.consumed).toHaveLength(2);
		const kinds = result.consumed.map((e) => e.kind).sort();
		expect(kinds).toEqual(["file-content", "file-manifest"]);
	});
});

