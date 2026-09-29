import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { contentIdentity } from "../src/core/tools/edit-diff.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "theta-write-hash-stale-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("write tool expectedVersion stale observation", () => {
	it("succeeds when the supplied expectedVersion matches the current file identity", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "write-match.txt");
		const original = "first\n";
		await writeFile(filePath, original, "utf8");

		const expectedVersion = await contentIdentity(original);

		const definition = createWriteToolDefinition(dir);
		const result = await definition.execute(
			"tool-1",
			{
				path: "write-match.txt",
				content: "second\n",
				expectedVersion,
			},
			undefined,
			undefined,
			{ cwd: dir } as ExtensionContext,
		);

		expect(result.content).toEqual([{ type: "text", text: "Successfully wrote to write-match.txt" }]);
		expect(await readFile(filePath, "utf8")).toBe("second\n");
	});

	it("throws Stale observation when the file changed since expectedVersion was captured", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "write-stale.txt");
		const original = "first\n";
		await writeFile(filePath, original, "utf8");

		const expectedVersion = await contentIdentity(original);

		// Mutate the file in between read and write.
		await writeFile(filePath, "mutated-in-between\n", "utf8");

		const definition = createWriteToolDefinition(dir);
		await expect(
			definition.execute(
				"tool-1",
				{
					path: "write-stale.txt",
					content: "new-content\n",
					expectedVersion,
				},
				undefined,
				undefined,
				{ cwd: dir } as ExtensionContext,
			),
		).rejects.toThrow(/Stale observation/);

		// The file must remain at the in-between state, untouched by the failed write.
		expect(await readFile(filePath, "utf8")).toBe("mutated-in-between\n");
	});

	it("throws Stale observation when the file is missing and expectedVersion is set", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "write-missing.txt");
		// File does not exist.

		const definition = createWriteToolDefinition(dir);
		await expect(
			definition.execute(
				"tool-1",
				{
					path: "write-missing.txt",
					content: "new-content\n",
					expectedVersion: "12:abcdef",
				},
				undefined,
				undefined,
				{ cwd: dir } as ExtensionContext,
			),
		).rejects.toThrow(/Stale observation/);

		// The file must not have been created by the failed write.
		const exists = await readFile(filePath, "utf8").catch((error: unknown) => {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				return undefined;
			}
			throw error;
		});
		expect(exists).toBeUndefined();
	});
});

