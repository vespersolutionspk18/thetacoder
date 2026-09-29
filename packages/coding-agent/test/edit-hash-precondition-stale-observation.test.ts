import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { computeEditsDiff, contentIdentity } from "../src/core/tools/edit-diff.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "theta-edit-hash-stale-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit tool expectedVersion stale observation", () => {
	it("throws Stale observation when the file changed since expectedVersion was captured", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "stale.txt");
		const original = "alpha\nbeta\ngamma\n";
		await writeFile(filePath, original, "utf8");

		const expectedVersion = await contentIdentity(original);

		// Mutate the file in between read and edit so the identity no longer matches.
		await writeFile(filePath, "alpha\nbeta-changed\ngamma\n", "utf8");

		const definition = createEditToolDefinition(dir);
		await expect(
			definition.execute(
				"tool-1",
				{
					path: "stale.txt",
					edits: [{ oldText: "beta", newText: "BETA" }],
					expectedVersion,
				},
				undefined,
				undefined,
				{ cwd: dir } as ExtensionContext,
			),
		).rejects.toThrow(/Stale observation/);

		// The file must remain unchanged after the failed edit.
		expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta-changed\ngamma\n");
	});

	it("computeEditsDiff short-circuits with Stale observation when expectedVersion is stale", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "preview-stale.txt");
		const original = "alpha\nbeta\ngamma\n";
		await writeFile(filePath, original, "utf8");

		const expectedVersion = await contentIdentity(original);

		// Mutate the file before the preview is requested.
		await writeFile(filePath, "alpha\nbeta-changed\ngamma\n", "utf8");

		const result = await computeEditsDiff(filePath, [{ oldText: "beta", newText: "BETA" }], dir, expectedVersion);
		expect(result).toEqual({ error: "Stale observation" });
	});

	it("computeEditsDiff returns a normal diff when expectedVersion matches", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "preview-match.txt");
		const original = "alpha\nbeta\ngamma\n";
		await writeFile(filePath, original, "utf8");

		const expectedVersion = await contentIdentity(original);

		const result = await computeEditsDiff(filePath, [{ oldText: "beta", newText: "BETA" }], dir, expectedVersion);
		if ("error" in result) {
			throw new Error(`unexpected error: ${result.error}`);
		}
		expect(result.diff).toContain("BETA");
	});

	it("computeEditsDiff without expectedVersion always computes the diff", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "preview-none.txt");
		await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");

		const result = await computeEditsDiff(filePath, [{ oldText: "beta", newText: "BETA" }], dir);
		if ("error" in result) {
			throw new Error(`unexpected error: ${result.error}`);
		}
		expect(result.diff).toContain("BETA");
	});
});

