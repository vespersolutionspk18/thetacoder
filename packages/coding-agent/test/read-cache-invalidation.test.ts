import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { resetFileContentCacheForTests } from "../src/core/tools/file-content-cache.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

const ORIGINAL = "alpha\nbeta\ngamma\n";
const REWRITTEN = "completely\nnew\ncontent\n";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "theta-read-cache-invalidation-"));
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => {
	// The cache is a process-wide singleton shared by all tools; start every
	// test from a clean slate so cross-test entries cannot mask a miss.
	resetFileContentCacheForTests();
});

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeCtx(dir: string): ExtensionContext {
	return { cwd: dir } as ExtensionContext;
}

function getTextOutput(content: ReadonlyArray<{ type: string; text?: string }>): string {
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

describe("read tool cache invalidation after edit/write", () => {
	it("serves the edited content, not the stale cached bytes", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "doc.txt");
		await writeFile(filePath, ORIGINAL, "utf8");

		let diskReads = 0;
		const read = createReadToolDefinition(dir, {
			operations: {
				access: async () => undefined,
				readFile: async (p) => {
					diskReads += 1;
					return readFile(p);
				},
			},
		});
		const ctx = makeCtx(dir);

		const first = await read.execute("call-1", { path: filePath }, undefined, undefined, ctx);
		expect(getTextOutput(first.content)).toContain("alpha");
		expect(getTextOutput(first.content)).toContain("beta");
		expect(diskReads).toBe(1);

		const edit = createEditToolDefinition(dir);
		await edit.execute(
			"call-2",
			{ path: filePath, edits: [{ oldText: "beta", newText: "BETA-EDITED" }] },
			undefined,
			undefined,
			ctx,
		);
		expect(await readFile(filePath, "utf8")).toBe("alpha\nBETA-EDITED\ngamma\n");

		const second = await read.execute("call-3", { path: filePath }, undefined, undefined, ctx);
		const secondText = getTextOutput(second.content);
		expect(secondText).toContain("BETA-EDITED");
		expect(secondText).not.toContain("alpha\nbeta");
		// Invalidation must have forced the second read back to disk.
		expect(diskReads).toBe(2);
	});

	it("serves the rewritten content after the write tool overwrites the file", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "doc.txt");
		await writeFile(filePath, ORIGINAL, "utf8");

		let diskReads = 0;
		const read = createReadToolDefinition(dir, {
			operations: {
				access: async () => undefined,
				readFile: async (p) => {
					diskReads += 1;
					return readFile(p);
				},
			},
		});
		const ctx = makeCtx(dir);

		const first = await read.execute("call-1", { path: filePath }, undefined, undefined, ctx);
		expect(getTextOutput(first.content)).toContain("gamma");
		expect(diskReads).toBe(1);

		const write = createWriteToolDefinition(dir);
		await write.execute("call-2", { path: filePath, content: REWRITTEN }, undefined, undefined, ctx);
		expect(await readFile(filePath, "utf8")).toBe(REWRITTEN);

		const second = await read.execute("call-3", { path: filePath }, undefined, undefined, ctx);
		const secondText = getTextOutput(second.content);
		expect(secondText).toContain("completely");
		expect(secondText).not.toContain("alpha");
		// Invalidation must have forced the second read back to disk.
		expect(diskReads).toBe(2);
	});

	it("keeps skipping the disk read on back-to-back reads of an unmodified file", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "doc.txt");
		await writeFile(filePath, ORIGINAL, "utf8");

		let diskReads = 0;
		const read = createReadToolDefinition(dir, {
			operations: {
				access: async () => undefined,
				readFile: async (p) => {
					diskReads += 1;
					return readFile(p);
				},
			},
		});
		const ctx = makeCtx(dir);

		const first = await read.execute("call-1", { path: filePath }, undefined, undefined, ctx);
		const second = await read.execute("call-2", { path: filePath }, undefined, undefined, ctx);

		expect(getTextOutput(first.content)).toContain("gamma");
		expect(getTextOutput(second.content)).toBe(getTextOutput(first.content));
		expect(first.details?.contentIdentity).toBe(second.details?.contentIdentity);
		// No mutation happened, so the cache must still be reused.
		expect(diskReads).toBe(1);
	});
});

