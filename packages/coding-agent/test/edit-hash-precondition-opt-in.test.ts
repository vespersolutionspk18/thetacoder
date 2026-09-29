import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "theta-edit-hash-optin-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit/write opt-in: no expectedVersion keeps the original behavior", () => {
	it("edit succeeds when the file changed in between, as long as expectedVersion is not supplied", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "optin-edit.txt");
		await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");

		// Mutate the file in between. With no expectedVersion, the edit still runs.
		await writeFile(filePath, "alpha\nBETA\ngamma\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const result = await definition.execute(
			"tool-1",
			{
				path: "optin-edit.txt",
				edits: [{ oldText: "alpha", newText: "ALPHA" }],
				// expectedVersion deliberately omitted.
			},
			undefined,
			undefined,
			{ cwd: dir } as ExtensionContext,
		);

		expect(result.content).toEqual([{ type: "text", text: "Successfully replaced 1 block(s) in optin-edit.txt." }]);
		expect(await readFile(filePath, "utf8")).toBe("ALPHA\nBETA\ngamma\n");
	});

	it("write overwrites an existing file when expectedVersion is not supplied", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "optin-write.txt");
		await writeFile(filePath, "original\n", "utf8");

		const definition = createWriteToolDefinition(dir);
		const result = await definition.execute(
			"tool-1",
			{
				path: "optin-write.txt",
				content: "replacement\n",
				// expectedVersion deliberately omitted.
			},
			undefined,
			undefined,
			{ cwd: dir } as ExtensionContext,
		);

		expect(result.content).toEqual([{ type: "text", text: "Successfully wrote to optin-write.txt" }]);
		expect(await readFile(filePath, "utf8")).toBe("replacement\n");
	});
});

