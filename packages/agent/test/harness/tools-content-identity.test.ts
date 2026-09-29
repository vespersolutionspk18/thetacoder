/**
 * F5 parity — harness-path `edit` and `write` tools report
 * `details.contentIdentity`.
 *
 * The normal-path tools already compute a content identity for their
 * results so the F2 change-tracking bridge can `recordChange` from a
 * tool result. The harness-path tools (used by the new AgentHarness
 * execution layer) must report the same field, or harness sessions get
 * no change tracking at all.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createEditTool } from "../../src/harness/tools/edit.ts";
import { contentIdentity } from "../../src/harness/tools/edit-diff.ts";
import { createWriteTool } from "../../src/harness/tools/write.ts";

const noUpdate = () => {};

const invocation = {
	invocationId: "test-result",
	operationId: "test-operation",
	turnId: "test-turn",
	getMemo: async () => undefined,
	setMemo: async () => {},
};

const tempDirs: string[] = [];

function makeContext() {
	const dir = mkdtempSync(join(tmpdir(), "theta-harness-identity-"));
	tempDirs.push(dir);
	writeFileSync(join(dir, "file.txt"), "alpha\nbeta\n", "utf-8");
	return { env: new NodeExecutionEnv({ cwd: dir }) };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("harness tools — contentIdentity parity", () => {
	it("edit reports the contentIdentity of the resulting content", async () => {
		const context = makeContext();
		const result = await createEditTool().execute(
			"edit-1",
			{ path: "file.txt", edits: [{ oldText: "beta", newText: "BETA" }] },
			noUpdate,
			context,
			invocation,
			BACKGROUND_CONTEXT,
		);
		expect(result.details?.contentIdentity).toBe(await contentIdentity("alpha\nBETA\n"));
	});

	it("write reports the contentIdentity of the written content", async () => {
		const context = makeContext();
		const result = await createWriteTool().execute(
			"write-1",
			{ path: "new.txt", content: "written content\n" },
			noUpdate,
			context,
			invocation,
			BACKGROUND_CONTEXT,
		);
		expect(result.details?.contentIdentity).toBe(await contentIdentity("written content\n"));
	});

	it("write identity satisfies expectedVersion on a subsequent edit", async () => {
		const context = makeContext();
		const initial = await createWriteTool().execute(
			"write-1",
			{ path: "round.txt", content: "one\ntwo\n" },
			noUpdate,
			context,
			invocation,
			BACKGROUND_CONTEXT,
		);
		const identity = initial.details?.contentIdentity;
		expect(typeof identity).toBe("string");
		// Passing the write's identity as expectedVersion must succeed
		// (nothing else touched the file between the two calls).
		const edited = await createEditTool().execute(
			"edit-1",
			{
				path: "round.txt",
				edits: [{ oldText: "two", newText: "TWO" }],
				expectedVersion: identity,
			},
			noUpdate,
			context,
			invocation,
			BACKGROUND_CONTEXT,
		);
		expect(edited.details?.contentIdentity).toBe(await contentIdentity("one\nTWO\n"));
	});
});

