/**
 * F10 file-backed shared evidence — getByKind filtering.
 *
 * The store partitions entries by `EvidenceKind` so a caller asking
 * for "the latest manifest" does not have to wade through
 * `syntax-index` entries. This test pins the file-backed store's
 * behaviour across mixed kinds and across handle boundaries.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSharedEvidenceStore } from "../src/core/repository/shared-evidence-ipc.ts";

import { makeEvidence, makeStorePath, type TempStore } from "./file-shared-evidence-helpers.ts";

describe("FileSharedEvidenceStore — getByKind", () => {
	let tmp: TempStore;
	const handles: FileSharedEvidenceStore[] = [];

	beforeEach(async () => {
		tmp = await makeStorePath("get-by-kind");
	});

	afterEach(async () => {
		for (const h of handles) await h.destroy();
		handles.length = 0;
		await tmp.cleanup();
	});

	function open(): FileSharedEvidenceStore {
		const h = new FileSharedEvidenceStore({ path: tmp.path });
		handles.push(h);
		return h;
	}

	it("returns only entries matching the requested kind", async () => {
		const store = open();
		const manifests = [
			makeEvidence("file-manifest", { root: "/a" }),
			makeEvidence("file-manifest", { root: "/b" }),
			makeEvidence("file-manifest", { root: "/c" }),
		];
		const syntaxes = [makeEvidence("syntax-index", { files: 10 }), makeEvidence("syntax-index", { files: 20 })];

		for (const e of [...manifests, ...syntaxes]) await store.putAsync(e);

		const gotManifests = store.getByKind("file-manifest");
		const gotSyntaxes = store.getByKind("syntax-index");
		const gotReferences = store.getByKind("reference-result");
		const gotFileContent = store.getByKind("file-content");
		const gotCompilation = store.getByKind("compilation-result");

		expect(gotManifests).toHaveLength(3);
		expect(gotSyntaxes).toHaveLength(2);
		expect(gotReferences).toHaveLength(0);
		expect(gotFileContent).toHaveLength(0);
		expect(gotCompilation).toHaveLength(0);

		for (const entry of gotManifests) expect(entry.kind).toBe("file-manifest");
		for (const entry of gotSyntaxes) expect(entry.kind).toBe("syntax-index");
	});

	it("returns an empty array for an empty store", () => {
		const store = open();
		expect(store.getByKind("file-manifest")).toEqual([]);
		expect(store.getByKind("syntax-index")).toEqual([]);
	});

	it("includes expired entries (use getValidByKind to filter those)", async () => {
		// Per the shared contract: getByKind returns every entry of
		// the kind, expired or not; getValidByKind is the one that
		// filters TTL.
		const store = open();
		const longExpired = {
			...makeEvidence("file-manifest", { root: "/stale" }),
			createdAt: 0,
			ttlMs: 1,
		};
		await store.putAsync(longExpired);

		expect(store.getByKind("file-manifest")).toHaveLength(1);
	});

	it("getByKind on a fresh handle returns the same partition as the writer", async () => {
		const writer = open();
		await writer.putAsync(makeEvidence("file-manifest", { root: "/a" }));
		await writer.putAsync(makeEvidence("file-manifest", { root: "/b" }));
		await writer.putAsync(makeEvidence("syntax-index", { files: 5 }));

		const peer = new FileSharedEvidenceStore({ path: tmp.path });
		handles.push(peer);

		expect(peer.getByKind("file-manifest")).toHaveLength(2);
		expect(peer.getByKind("syntax-index")).toHaveLength(1);
	});
});

