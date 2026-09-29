/**
 * F10 file-backed shared evidence — basic put / get / size.
 *
 * Happy path through the file-backed store. Mirrors the in-memory
 * basic test so a reader can compare the two side by side and see
 * that the file layer preserves the contract.
 */

import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Evidence } from "../src/core/repository/shared-evidence.ts";
import { FileSharedEvidenceStore } from "../src/core/repository/shared-evidence-ipc.ts";

import { makeEvidence, makeStorePath, type TempStore } from "./file-shared-evidence-helpers.ts";

describe("FileSharedEvidenceStore — basic", () => {
	let tmp: TempStore;
	let store: FileSharedEvidenceStore | null = null;

	beforeEach(async () => {
		tmp = await makeStorePath("basic");
	});

	afterEach(async () => {
		if (store) await store.destroy();
		store = null;
		await tmp.cleanup();
	});

	it("starts empty when the backing file does not exist", () => {
		store = new FileSharedEvidenceStore({ path: tmp.path });
		expect(store.size()).toBe(0);
		expect(store.get("missing")).toBeUndefined();
	});

	it("stores and retrieves an evidence record", async () => {
		store = new FileSharedEvidenceStore({ path: tmp.path });
		const ev = makeEvidence("file-manifest", { root: "/repo" });

		store.put(ev);
		await store.putAsync(ev); // ensure persistence completes

		expect(store.size()).toBe(1);
		expect(store.get(ev.id)).toEqual(ev);
	});

	it("replaces an existing record when the same id is put again", async () => {
		store = new FileSharedEvidenceStore({ path: tmp.path });
		const first = makeEvidence("syntax-index", { count: 10 });
		const second: Evidence = { ...first, source: "updated", payload: { count: 20 } };

		store.put(first);
		store.put(second);
		await store.putAsync(second);

		expect(store.size()).toBe(1);
		expect(store.get(first.id)?.source).toBe("updated");
		expect(store.get(first.id)?.payload).toEqual({ count: 20 });
	});

	it("persists synchronously enough that a fresh handle sees the put", async () => {
		store = new FileSharedEvidenceStore({ path: tmp.path });
		const ev = makeEvidence("file-manifest", { a: 1 });
		await store.putAsync(ev);

		// New process / new handle on the same path picks up the entry.
		const peer = new FileSharedEvidenceStore({ path: tmp.path });
		try {
			expect(peer.size()).toBe(1);
			expect(peer.get(ev.id)).toEqual(ev);
		} finally {
			await peer.destroy();
		}
	});

	it("clear() drops every record (in-memory)", async () => {
		store = new FileSharedEvidenceStore({ path: tmp.path });
		store.put(makeEvidence("file-manifest", { a: 1 }));
		store.put(makeEvidence("syntax-index", { b: 2 }));
		expect(store.size()).toBe(2);

		store.clear();
		await store.clearAsync();

		expect(store.size()).toBe(0);
		expect(store.getByKind("file-manifest")).toEqual([]);
		expect(store.getByKind("syntax-index")).toEqual([]);
	});

	it("tolerates a pre-existing but empty file", () => {
		// Some upstream tooling may `touch` the file before the first
		// put. The store should treat an empty file the same as a
		// missing one.
		// The await + sync write is intentional: we want the file
		// present on disk by the time the store opens it.
		return writeFile(tmp.path, "", "utf-8").then(() => {
			store = new FileSharedEvidenceStore({ path: tmp.path });
			expect(store.size()).toBe(0);
		});
	});
});

