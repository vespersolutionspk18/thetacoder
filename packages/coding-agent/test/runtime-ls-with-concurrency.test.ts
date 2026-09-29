import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createLsToolDefinition } from "../src/core/tools/ls.ts";

function getTextOutput(result: any): string {
	return (result.content?.find((c: any) => c.type === "text")?.text as string) || "";
}

const noCtx = {} as ExtensionContext;

describe("ls tool bounded concurrency", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `runtime-ls-concurrency-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("uses boundedAll under the hood — concurrent stat calls respect the limit", async () => {
		// Create a handful of real entries so the real filesystem path is exercised.
		for (let i = 0; i < 12; i++) {
			writeFileSync(join(testDir, `entry-${i.toString().padStart(2, "0")}.txt`), "x");
		}

		let inFlight = 0;
		let maxObserved = 0;
		const tool = createLsToolDefinition(testDir, {
			operations: {
				exists: async () => true,
				stat: async (p: string) => {
					inFlight++;
					maxObserved = Math.max(maxObserved, inFlight);
					// Small artificial delay so multiple in-flight stats can overlap.
					await new Promise((resolve) => setTimeout(resolve, 10));
					inFlight--;
					const { stat } = await import("fs/promises");
					return stat(p);
				},
				readdir: async (p: string) => {
					const { readdir } = await import("fs/promises");
					return readdir(p);
				},
			},
		});

		const result = await tool.execute("call-1", { path: testDir }, undefined, undefined, noCtx);
		const text = getTextOutput(result);
		expect(text).toBeTruthy();
		// Every entry that was created should be in the output.
		expect(text).toContain("entry-00.txt");
		expect(text).toContain("entry-11.txt");
		// Concurrency must be bounded at 8 by the implementation.
		expect(maxObserved).toBeGreaterThan(1);
		expect(maxObserved).toBeLessThanOrEqual(8);
	});

	it("still skips unstatable entries and keeps results in alphabetical order", async () => {
		writeFileSync(join(testDir, "alpha.txt"), "x");
		writeFileSync(join(testDir, "beta.txt"), "x");
		writeFileSync(join(testDir, "gamma.txt"), "x");

		const tool = createLsToolDefinition(testDir, {
			operations: {
				exists: async () => true,
				stat: async (p: string) => {
					if (p.endsWith("beta.txt")) {
						throw new Error("synthetic stat failure");
					}
					const { stat } = await import("fs/promises");
					return stat(p);
				},
				readdir: async (p: string) => {
					const { readdir } = await import("fs/promises");
					return readdir(p);
				},
			},
		});

		const result = await tool.execute("call-2", { path: testDir }, undefined, undefined, noCtx);
		const text = getTextOutput(result);
		const lines = text.split("\n");
		// Filter the empty / notice lines and confirm the visible file list.
		const fileLines = lines.filter((l) => l.endsWith(".txt"));
		expect(fileLines).toEqual(["alpha.txt", "gamma.txt"]);
	});
});

