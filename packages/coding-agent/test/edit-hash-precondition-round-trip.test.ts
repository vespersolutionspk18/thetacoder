import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { contentIdentity } from "../src/core/tools/edit-diff.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "theta-edit-hash-roundtrip-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit tool expectedVersion round-trip", () => {
	it("succeeds when the supplied expectedVersion matches the current file identity", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "roundtrip.txt");
		const original = "alpha\nbeta\ngamma\n";
		await writeFile(filePath, original, "utf8");

		const expectedVersion = await contentIdentity(original);

		const definition = createEditToolDefinition(dir);
		const result = await definition.execute(
			"tool-1",
			{
				path: "roundtrip.txt",
				edits: [{ oldText: "beta", newText: "BETA" }],
				expectedVersion,
			},
			undefined,
			undefined,
			{ cwd: dir } as ExtensionContext,
		);

		expect(result.content).toEqual([{ type: "text", text: "Successfully replaced 1 block(s) in roundtrip.txt." }]);
		expect(await readFile(filePath, "utf8")).toBe("alpha\nBETA\ngamma\n");
	});
});

