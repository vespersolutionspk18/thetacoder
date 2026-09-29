/**
 * F10 shared evidence — getByKind filtering.
 *
 * The store has to partition entries by `EvidenceKind` so a child
 * asking for "give me the latest manifest" doesn't wade through
 * syntax-index entries. This test pins that behavior.
 */

import { describe, expect, it } from "vitest";
import { type Evidence, evidenceId, InMemorySharedEvidenceStore } from "../src/core/repository/shared-evidence.ts";

function ev(kind: Evidence["kind"], payload: unknown): Evidence {
	return {
		id: evidenceId(kind, payload),
		kind,
		source: "test",
		createdAt: 1,
		payload,
	};
}

describe("InMemorySharedEvidenceStore — getByKind", () => {
	it("returns only entries matching the requested kind", () => {
		const store = new InMemorySharedEvidenceStore();

		// 3 of file-manifest, 2 of syntax-index.
		const manifests = [
			ev("file-manifest", { root: "/a" }),
			ev("file-manifest", { root: "/b" }),
			ev("file-manifest", { root: "/c" }),
		];
		const syntaxes = [ev("syntax-index", { files: 10 }), ev("syntax-index", { files: 20 })];

		for (const e of [...manifests, ...syntaxes]) store.put(e);

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

		// Every returned entry has the requested kind.
		for (const entry of gotManifests) expect(entry.kind).toBe("file-manifest");
		for (const entry of gotSyntaxes) expect(entry.kind).toBe("syntax-index");
	});

	it("returns an empty array for an empty store", () => {
		const store = new InMemorySharedEvidenceStore();
		expect(store.getByKind("file-manifest")).toEqual([]);
		expect(store.getByKind("syntax-index")).toEqual([]);
	});

	it("includes expired entries (use getValidByKind to filter those)", () => {
		// Per the contract: getByKind returns every entry of the kind,
		// expired or not; getValidByKind is the one that filters TTL.
		const store = new InMemorySharedEvidenceStore();
		const stale: Evidence = {
			id: evidenceId("file-manifest", { root: "/stale" }),
			kind: "file-manifest",
			source: "test",
			createdAt: 0,
			ttlMs: 1,
			payload: { root: "/stale" },
		};
		store.put(stale);

		expect(store.getByKind("file-manifest")).toHaveLength(1);
	});
});

