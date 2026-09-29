/**
 * F1 manifest — content hash.
 *
 * Writes a file with known bytes, builds a manifest with
 * `computeHashes: true`, and asserts the SHA-256 matches the digest of
 * the same bytes computed independently with node:crypto.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildManifest, getFile, resetPackageCacheForTests } from "../src/core/repository/manifest.ts";

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

describe("buildManifest content hashing", () => {
	let tempRoot: string;

	beforeEach(async () => {
		resetPackageCacheForTests();
		tempRoot = await mkdtemp(join(tmpdir(), "theta-file-manifest-hash-"));
		await mkdir(join(tempRoot, "src"), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("computes sha256 of file bytes when computeHashes is true", async () => {
		const content = "hello, theta\n";
		await writeFile(join(tempRoot, "src", "hello.ts"), content);

		const manifest = await buildManifest({
			root: tempRoot,
			computeHashes: true,
		});

		const entry = getFile(manifest, "src/hello.ts");
		expect(entry).toBeDefined();
		expect(entry?.contentHash).toBe(sha256Hex(new TextEncoder().encode(content)));
	});

	it("omits contentHash when computeHashes is false", async () => {
		await writeFile(join(tempRoot, "src", "quiet.ts"), "export const x = 1;\n");

		const manifest = await buildManifest({ root: tempRoot });
		const entry = getFile(manifest, "src/quiet.ts");
		expect(entry).toBeDefined();
		expect(entry?.contentHash).toBeUndefined();
	});

	it("matches sha256 for binary-looking content", async () => {
		const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, 0x0a, 0x0d]);
		await writeFile(join(tempRoot, "src", "blob.bin"), bytes);

		const manifest = await buildManifest({
			root: tempRoot,
			computeHashes: true,
		});

		const entry = getFile(manifest, "src/blob.bin");
		expect(entry).toBeDefined();
		expect(entry?.contentHash).toBe(sha256Hex(bytes));
	});
});

