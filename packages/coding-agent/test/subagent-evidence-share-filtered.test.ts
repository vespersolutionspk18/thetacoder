/**
 * F10 subagent evidence sharing — file-content path filtering.
 *
 * The parent has a mix of file-content records spread across many
 * paths. The function should only copy the records whose path
 * matches the subagent's declared `taskPaths`. Records that do
 * not match must be excluded.
 */

import { afterEach, describe, expect, it } from "vitest";

import { evidenceId, InMemorySharedEvidenceStore } from "../src/core/repository/shared-evidence.ts";
import { FileSharedEvidenceStore } from "../src/core/repository/shared-evidence-ipc.ts";
import { makeSubagentStorePath, shareEvidenceWithSubagent } from "../src/core/subagent-evidence-share.ts";

describe("shareEvidenceWithSubagent — file-content path filter", () => {
	let cleanup: (() => Promise<void>) | null = null;

	afterEach(async () => {
		if (cleanup) {
			await cleanup();
			cleanup = null;
		}
	});

	it("only copies file-content entries matching the subagent's task paths", async () => {
		const parent = new InMemorySharedEvidenceStore();

		const wanted = ["/repo/src/api/users.ts", "/repo/src/api/orders.ts"];
		const unwanted = ["/repo/src/internal/secrets.ts", "/repo/test/fixture.ts"];

		for (const path of wanted) {
			const payload = { path, content: `body of ${path}\n`, byteLength: path.length + 7 };
			parent.put({
				id: evidenceId("file-content", payload),
				kind: "file-content",
				source: "parent",
				createdAt: 1_700_000_000_000,
				payload,
				contentHash: `h-${path}`,
			});
		}
		for (const path of unwanted) {
			const payload = { path, content: `body of ${path}\n`, byteLength: path.length + 7 };
			parent.put({
				id: evidenceId("file-content", payload),
				kind: "file-content",
				source: "parent",
				createdAt: 1_700_000_000_100,
				payload,
				contentHash: `h-${path}`,
			});
		}

		// Throw in an unrelated record kind to make sure the
		// filter only narrows file-content.
		const refPayload = { query: "foo" };
		parent.put({
			id: evidenceId("reference-result", refPayload),
			kind: "reference-result",
			source: "parent",
			createdAt: 1_700_000_000_200,
			payload: refPayload,
		});

		const tmp = await makeSubagentStorePath("filtered");
		cleanup = tmp.cleanup;

		const result = await shareEvidenceWithSubagent(parent, tmp.path, {
			taskPaths: wanted,
		});

		// Only the two wanted file-content records were copied.
		expect(result.fileContentCount).toBe(wanted.length);

		const childHandle = new FileSharedEvidenceStore({ path: tmp.path });
		try {
			const fileContents = childHandle.getByKind("file-content");
			expect(fileContents).toHaveLength(wanted.length);

			const copiedPaths = fileContents.map((e) => (e.payload as { path: string }).path).sort();
			expect(copiedPaths).toEqual([...wanted].sort());

			// The unwanted paths must be absent.
			for (const path of unwanted) {
				expect(copiedPaths).not.toContain(path);
			}

			// The reference-result is in the parent but should
			// not have been copied: this function only carries
			// file-manifest, syntax-index, and the filtered
			// file-content records.
			expect(childHandle.getByKind("reference-result")).toHaveLength(0);
		} finally {
			await childHandle.destroy();
		}
	});

	it("a task path that has no matching file-content record yields zero file-content copies", async () => {
		const parent = new InMemorySharedEvidenceStore();
		const payload = { path: "/repo/src/a.ts", content: "a", byteLength: 1 };
		parent.put({
			id: evidenceId("file-content", payload),
			kind: "file-content",
			source: "parent",
			createdAt: 1_700_000_000_000,
			payload,
		});

		const tmp = await makeSubagentStorePath("miss");
		cleanup = tmp.cleanup;

		const result = await shareEvidenceWithSubagent(parent, tmp.path, {
			taskPaths: ["/repo/src/does-not-exist.ts"],
		});

		expect(result.fileContentCount).toBe(0);

		const childHandle = new FileSharedEvidenceStore({ path: tmp.path });
		try {
			expect(childHandle.getByKind("file-content")).toHaveLength(0);
		} finally {
			await childHandle.destroy();
		}
	});

	it("non-file-content records are unaffected by the task-path filter", async () => {
		const parent = new InMemorySharedEvidenceStore();
		const manifestPayload = { root: "/repo" };
		parent.put({
			id: evidenceId("file-manifest", manifestPayload),
			kind: "file-manifest",
			source: "parent",
			createdAt: 1_700_000_000_000,
			payload: manifestPayload,
		});
		const syntaxPayload = { count: 42 };
		parent.put({
			id: evidenceId("syntax-index", syntaxPayload),
			kind: "syntax-index",
			source: "parent",
			createdAt: 1_700_000_000_100,
			payload: syntaxPayload,
		});

		const tmp = await makeSubagentStorePath("non-fc");
		cleanup = tmp.cleanup;

		const result = await shareEvidenceWithSubagent(parent, tmp.path, {
			taskPaths: ["/never/matches.ts"],
		});

		expect(result.manifestCount).toBe(1);
		expect(result.syntaxIndexCount).toBe(1);
		expect(result.fileContentCount).toBe(0);

		const childHandle = new FileSharedEvidenceStore({ path: tmp.path });
		try {
			expect(childHandle.getByKind("file-manifest")).toHaveLength(1);
			expect(childHandle.getByKind("syntax-index")).toHaveLength(1);
		} finally {
			await childHandle.destroy();
		}
	});
});

