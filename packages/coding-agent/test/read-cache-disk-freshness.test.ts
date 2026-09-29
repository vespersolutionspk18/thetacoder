/**
 * F11 read cache — disk-freshness verification.
 *
 * The cache-consult path in the read tool must verify a cached entry's
 * mtime/size fingerprint against the disk before serving cached bytes. A
 * mutation performed outside the edit/write tools (e.g. via `bash` or an
 * external editor) bypasses `invalidateFileContentCache`, so the stat
 * check is the only thing preventing the model from seeing pre-mutation
 * bytes — and, worse, a pre-mutation `contentIdentity` that makes every
 * subsequent `expectedVersion` edit fail in a loop.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { resetFileContentCacheForTests } from "../src/core/tools/file-content-cache.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

function makeCtx(dir: string): ExtensionContext {
	return { cwd: dir } as ExtensionContext;
}

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

describe("read tool — cache freshness verification", () => {
	let tempDir: string;
	let testFile: string;

	beforeEach(() => {
		resetFileContentCacheForTests();
		tempDir = mkdtempSync(join(tmpdir(), "theta-read-freshness-"));
		testFile = join(tempDir, "file.txt");
		writeFileSync(testFile, "one\n", "utf-8");
	});

	afterEach(() => {
		resetFileContentCacheForTests();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("serves cached bytes when the file is unchanged", async () => {
		const tool = createReadToolDefinition(tempDir);
		const first = await tool.execute("call-1", { path: testFile }, undefined, undefined, makeCtx(tempDir));
		const second = await tool.execute("call-2", { path: testFile }, undefined, undefined, makeCtx(tempDir));
		expect(getTextOutput(second)).toBe(getTextOutput(first));
	});

	it("serves fresh bytes and a fresh identity after an external (non-tool) mutation", async () => {
		const tool = createReadToolDefinition(tempDir);
		await tool.execute("call-1", { path: testFile }, undefined, undefined, makeCtx(tempDir));

		// External mutation (simulating `bash` or an editor): the
		// invalidation hooks never fire for this write.
		writeFileSync(testFile, "one\ntwo changed externally\n", "utf-8");

		const second = await tool.execute("call-2", { path: testFile }, undefined, undefined, makeCtx(tempDir));
		expect(getTextOutput(second)).toContain("changed externally");
		// The identity must differ from what an edit against the OLD
		// content would have computed: derive the fresh identity from the
		// on-disk bytes, not from the first (pre-mutation) read.
		const freshIdentity = second.details?.contentIdentity;
		expect(typeof freshIdentity).toBe("string");
		// A third read must be stable (cache now holds fresh bytes).
		const third = await tool.execute("call-3", { path: testFile }, undefined, undefined, makeCtx(tempDir));
		expect(third.details?.contentIdentity).toBe(freshIdentity);
		expect(getTextOutput(third)).toContain("changed externally");
	});

	it("serves fresh bytes when an external mutation preserves file size but changes mtime", async () => {
		const tool = createReadToolDefinition(tempDir);
		await tool.execute("call-1", { path: testFile }, undefined, undefined, makeCtx(tempDir));

		// Same byte length, different content. Only the mtime differs.
		const initial = readFileSync(testFile, "utf-8");
		const changed = initial.replace("one", "TWO");
		expect(Buffer.byteLength(changed, "utf-8")).toBe(Buffer.byteLength(initial, "utf-8"));
		writeFileSync(testFile, changed, "utf-8");

		const second = await tool.execute("call-2", { path: testFile }, undefined, undefined, makeCtx(tempDir));
		expect(getTextOutput(second)).toContain("TWO");
	});

	it("keeps the historical trust-the-cache contract when no stat operation is available (remote read operations)", async () => {
		let readCalls = 0;
		const tool = createReadToolDefinition(tempDir, {
			operations: {
				readFile: async (p) => {
					readCalls++;
					return Buffer.from(readFileSync(p, "utf-8"), "utf-8");
				},
				access: async () => {},
				// No stat: custom remote operations cannot verify disk
				// freshness, so the cache contract stays "trust the
				// cached entry" (freshness is the remote's problem).
			},
		});
		const first = await tool.execute("call-1", { path: testFile }, undefined, undefined, makeCtx(tempDir));
		const second = await tool.execute("call-2", { path: testFile }, undefined, undefined, makeCtx(tempDir));
		expect(readCalls).toBe(1);
		expect(second.details?.contentIdentity).toBe(first.details?.contentIdentity);
	});
});

