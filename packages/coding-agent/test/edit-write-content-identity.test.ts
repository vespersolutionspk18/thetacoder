/**
 * F2 change tracking — `edit`/`write` tools report `contentIdentity`.
 *
 * The session's `afterToolCall` hook bridges successful `edit`/`write`
 * results into the F2 TaskState via `recordChange({ path, contentHash,
 * toolCallId })`. That bridge only fires when the tool result carries a
 * non-empty `details.contentIdentity`. The `read` tool already reported one,
 * but `edit` and `write` did not, so the changed-files log was never
 * populated for built-in edits/writes.
 *
 * This test drives the real `createEditToolDefinition` /
 * `createWriteToolDefinition` on temp files and asserts that each reports a
 * `details.contentIdentity` that:
 *   1. is a non-empty string, and
 *   2. equals `contentIdentity()` of the resulting on-disk content
 *      (proving it shares the read tool's identity scheme).
 *
 * A final cross-check proves a `read` of a written file reports the same
 * identity the `write` tool attached — i.e. read/edit/write share one scheme,
 * which is exactly what the F2 bridge relies on.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { contentIdentity } from "../src/core/tools/edit-diff.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "theta-edit-write-identity-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit tool reports contentIdentity", () => {
	it("returns a contentIdentity matching the resulting on-disk content", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "edit-identity.txt");
		const original = "alpha\nbeta\ngamma\n";
		await writeFile(filePath, original, "utf8");

		const definition = createEditToolDefinition(dir);
		const result = await definition.execute(
			"tool-1",
			{
				path: "edit-identity.txt",
				edits: [{ oldText: "beta", newText: "BETA" }],
			},
			undefined,
			undefined,
			{ cwd: dir } as ExtensionContext,
		);

		// The edit must have applied.
		const newContent = await readFile(filePath, "utf8");
		expect(newContent).toBe("alpha\nBETA\ngamma\n");

		// details.contentIdentity is present and non-empty.
		expect(result.details?.contentIdentity).toBeTruthy();
		expect(typeof result.details?.contentIdentity).toBe("string");

		// It must equal the identity of the resulting on-disk content,
		// i.e. the same scheme the read tool reports.
		expect(result.details?.contentIdentity).toBe(await contentIdentity(newContent));
	});

	it("reports a contentIdentity that a subsequent read confirms", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "edit-read-agree.txt");
		const original = "first line\nsecond line\n";
		await writeFile(filePath, original, "utf8");

		const edit = createEditToolDefinition(dir);
		const editResult = await edit.execute(
			"tool-2",
			{
				path: "edit-read-agree.txt",
				edits: [{ oldText: "second line", newText: "SECOND line" }],
			},
			undefined,
			undefined,
			{ cwd: dir } as ExtensionContext,
		);
		const editIdentity = editResult.details?.contentIdentity;
		expect(typeof editIdentity).toBe("string");

		// A read of the same file must report the identical identity.
		const read = createReadToolDefinition(dir);
		const readResult = await read.execute("read-1", { path: "edit-read-agree.txt" }, undefined, undefined, {
			cwd: dir,
		} as ExtensionContext);
		expect(readResult.details?.contentIdentity).toBe(editIdentity);
	});
});

describe("write tool reports contentIdentity", () => {
	it("returns a contentIdentity matching the written content", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "write-identity.txt");
		const content = "hello world\n";

		const definition = createWriteToolDefinition(dir);
		const result = await definition.execute("tool-1", { path: "write-identity.txt", content }, undefined, undefined, {
			cwd: dir,
		} as ExtensionContext);

		// The write must have applied.
		expect(await readFile(filePath, "utf8")).toBe(content);

		// details.contentIdentity is present and non-empty.
		expect(result.details?.contentIdentity).toBeTruthy();
		expect(typeof result.details?.contentIdentity).toBe("string");

		// It must equal the identity of the written content (the same
		// scheme the read tool reports).
		expect(result.details?.contentIdentity).toBe(await contentIdentity(content));
	});

	it("reports a contentIdentity that a subsequent read confirms", async () => {
		const dir = await createTempDir();
		const content = "cross check content\n";

		const write = createWriteToolDefinition(dir);
		const writeResult = await write.execute(
			"tool-1",
			{ path: "write-read-agree.txt", content },
			undefined,
			undefined,
			{ cwd: dir } as ExtensionContext,
		);
		const writeIdentity = writeResult.details?.contentIdentity;
		expect(typeof writeIdentity).toBe("string");

		// A read of the written file must report the identical identity,
		// proving read/write share one identity scheme.
		const read = createReadToolDefinition(dir);
		const readResult = await read.execute("read-1", { path: "write-read-agree.txt" }, undefined, undefined, {
			cwd: dir,
		} as ExtensionContext);
		expect(readResult.details?.contentIdentity).toBe(writeIdentity);
	});
});

