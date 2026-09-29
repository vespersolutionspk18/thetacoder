/**
 * F10 subagent evidence sharing — basic parent → child copy.
 *
 * The parent has a manifest, a syntax index, and a single file-content
 * record. The function should copy them all into the child's backing
 * file. A fresh `FileSharedEvidenceStore` opened on the same path
 * reads the file and confirms the records survived the round trip.
 */

import { afterEach, describe, expect, it } from "vitest";

import { evidenceId, InMemorySharedEvidenceStore } from "../src/core/repository/shared-evidence.ts";
import { FileSharedEvidenceStore } from "../src/core/repository/shared-evidence-ipc.ts";
import { makeSubagentStorePath, shareEvidenceWithSubagent } from "../src/core/subagent-evidence-share.ts";

describe("shareEvidenceWithSubagent — basic copy", () => {
	let cleanup: (() => Promise<void>) | null = null;

	afterEach(async () => {
		if (cleanup) {
			await cleanup();
			cleanup = null;
		}
	});

	it("copies 3 manifest + 2 syntax-index + 1 file-content entries from parent to child", async () => {
		const parent = new InMemorySharedEvidenceStore();

		// 3 manifest entries with different payload roots.
		for (let i = 0; i < 3; i++) {
			const payload = { root: `/repo/branch-${i}` };
			parent.put({
				id: evidenceId("file-manifest", payload),
				kind: "file-manifest",
				source: "parent",
				createdAt: 1_700_000_000_000 + i,
				payload,
			});
		}

		// 2 syntax-index entries.
		for (let i = 0; i < 2; i++) {
			const payload = { branch: `b-${i}`, files: 10 + i };
			parent.put({
				id: evidenceId("syntax-index", payload),
				kind: "syntax-index",
				source: "parent",
				createdAt: 1_700_000_000_100 + i,
				payload,
			});
		}

		// 1 file-content entry, allowed because we list the path.
		const filePath = "/repo/src/index.ts";
		const filePayload = { path: filePath, content: "export const a = 1;\n", byteLength: 22 };
		parent.put({
			id: evidenceId("file-content", filePayload),
			kind: "file-content",
			source: "parent",
			createdAt: 1_700_000_000_200,
			payload: filePayload,
			contentHash: "h-parent",
		});

		const tmp = await makeSubagentStorePath("basic");
		cleanup = tmp.cleanup;

		const result = await shareEvidenceWithSubagent(parent, tmp.path, {
			taskPaths: [filePath],
		});

		expect(result.manifestCount).toBe(3);
		expect(result.syntaxIndexCount).toBe(2);
		expect(result.fileContentCount).toBe(1);

		// Open a fresh handle on the file as the "child" would and
		// confirm the records survived the IPC round trip.
		const childHandle = new FileSharedEvidenceStore({ path: tmp.path });
		try {
			expect(childHandle.size()).toBe(6);

			const manifests = childHandle.getByKind("file-manifest");
			expect(manifests).toHaveLength(3);
			for (const entry of manifests) {
				expect(entry.kind).toBe("file-manifest");
				expect(entry.source).toBe("parent");
			}

			const syntaxIndices = childHandle.getByKind("syntax-index");
			expect(syntaxIndices).toHaveLength(2);
			for (const entry of syntaxIndices) {
				expect(entry.kind).toBe("syntax-index");
				expect(entry.source).toBe("parent");
			}

			const fileContents = childHandle.getByKind("file-content");
			expect(fileContents).toHaveLength(1);
			expect(fileContents[0].contentHash).toBe("h-parent");
			expect((fileContents[0].payload as { path: string }).path).toBe(filePath);
		} finally {
			await childHandle.destroy();
		}
	});

	it("returns zero counts when the parent store is empty", async () => {
		const parent = new InMemorySharedEvidenceStore();
		const tmp = await makeSubagentStorePath("empty");
		cleanup = tmp.cleanup;

		const result = await shareEvidenceWithSubagent(parent, tmp.path, { taskPaths: [] });

		expect(result).toEqual({ manifestCount: 0, syntaxIndexCount: 0, fileContentCount: 0 });

		// The child file should not exist (empty store → unlink on
		// flush). Confirm the child handle sees zero records.
		const childHandle = new FileSharedEvidenceStore({ path: tmp.path });
		try {
			expect(childHandle.size()).toBe(0);
		} finally {
			await childHandle.destroy();
		}
	});

	it("does not copy file-content records when no task paths are given", async () => {
		const parent = new InMemorySharedEvidenceStore();
		const payload = { path: "/repo/src/x.ts", content: "x", byteLength: 1 };
		parent.put({
			id: evidenceId("file-content", payload),
			kind: "file-content",
			source: "parent",
			createdAt: 1_700_000_000_000,
			payload,
		});

		const tmp = await makeSubagentStorePath("no-task-paths");
		cleanup = tmp.cleanup;

		const result = await shareEvidenceWithSubagent(parent, tmp.path);
		expect(result.fileContentCount).toBe(0);

		const childHandle = new FileSharedEvidenceStore({ path: tmp.path });
		try {
			expect(childHandle.getByKind("file-content")).toHaveLength(0);
		} finally {
			await childHandle.destroy();
		}
	});
});

