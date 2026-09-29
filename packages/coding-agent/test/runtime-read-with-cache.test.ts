import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

const noCtx = {} as ExtensionContext;

describe("read tool cache integration", () => {
	let testDir: string;
	let testFile: string;
	const fileContents = "alpha\nbeta\ngamma\ndelta\n";

	beforeEach(() => {
		testDir = join(tmpdir(), `runtime-read-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
		testFile = join(testDir, "cached.txt");
		writeFileSync(testFile, fileContents);
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("skips the underlying file read on the second call to the same path", async () => {
		let readCalls = 0;
		const tool = createReadToolDefinition(testDir, {
			operations: {
				access: async () => undefined,
				readFile: async (p) => {
					readCalls++;
					// Re-read the real file so the tool gets accurate content on the
					// first (cache-miss) call.
					const { readFile } = await import("fs/promises");
					return readFile(p);
				},
			},
		});

		const first = await tool.execute("call-1", { path: testFile }, undefined, undefined, noCtx);
		const firstOutput = getTextOutput(first);
		expect(firstOutput).toContain("alpha");
		expect(readCalls).toBe(1);

		const second = await tool.execute("call-2", { path: testFile }, undefined, undefined, noCtx);
		const secondOutput = getTextOutput(second);
		expect(secondOutput).toContain("alpha");
		// The cache hit should mean the underlying readFile is NOT called again.
		expect(readCalls).toBe(1);
	});

	it("reuses the cached content identity across calls", async () => {
		const tool = createReadToolDefinition(testDir, {
			operations: {
				access: async () => undefined,
				readFile: vi.fn(async (p: string) => {
					const { readFile } = await import("fs/promises");
					return readFile(p);
				}),
			},
		});

		const first = await tool.execute("call-id-1", { path: testFile }, undefined, undefined, noCtx);
		const second = await tool.execute("call-id-2", { path: testFile }, undefined, undefined, noCtx);

		const firstIdentity = first.details?.contentIdentity;
		const secondIdentity = second.details?.contentIdentity;
		expect(firstIdentity).toBeTruthy();
		expect(secondIdentity).toBe(firstIdentity);
	});

	it("falls back to disk read on cache miss and still works", async () => {
		const tool = createReadToolDefinition(testDir, {
			operations: {
				access: async () => undefined,
				readFile: async (p) => {
					const { readFile } = await import("fs/promises");
					return readFile(p);
				},
			},
		});

		const result = await tool.execute("call-miss", { path: testFile }, undefined, undefined, noCtx);
		expect(getTextOutput(result)).toContain("beta");
		expect(result.details?.contentIdentity).toBeTruthy();
	});
});

