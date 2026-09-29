/**
 * F10 file-backed shared evidence — clear.
 *
 * `clear` empties the in-memory cache and (on persistence) removes
 * the backing file. A fresh handle on the same path must see an
 * empty store.
 */

import { stat } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSharedEvidenceStore } from "../src/core/repository/shared-evidence-ipc.ts";

import { makeEvidence, makeStorePath, type TempStore } from "./file-shared-evidence-helpers.ts";

describe("FileSharedEvidenceStore — clear", () => {
	let tmp: TempStore;
	const handles: FileSharedEvidenceStore[] = [];

	beforeEach(async () => {
		tmp = await makeStorePath("clear");
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

	it("drops every record and removes the backing file", async () => {
		const store = open();
		await store.putAsync(makeEvidence("file-manifest", { a: 1 }));
		await store.putAsync(makeEvidence("syntax-index", { b: 2 }));
		expect(store.size()).toBe(2);

		// File exists before clear.
		await expect(stat(tmp.path)).resolves.toBeDefined();

		store.clear();
		await store.clearAsync();

		expect(store.size()).toBe(0);

		// File should be gone after clear (the contract: empty
		// store removes the file so a fresh process sees absence).
		await expect(stat(tmp.path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("a fresh handle after clear sees an empty store", async () => {
		const writer = open();
		await writer.putAsync(makeEvidence("file-manifest", { a: 1 }));
		await writer.clearAsync();

		const peer = new FileSharedEvidenceStore({ path: tmp.path });
		handles.push(peer);
		expect(peer.size()).toBe(0);
		expect(peer.getByKind("file-manifest")).toEqual([]);
	});

	it("clear is a no-op (and harmless) on an already-empty store", async () => {
		const store = open();
		expect(store.size()).toBe(0);

		store.clear();
		await store.clearAsync();

		expect(store.size()).toBe(0);
	});

	it("after clear, the store can be re-populated and a fresh handle sees the new entries", async () => {
		const writer = open();
		const old = makeEvidence("file-manifest", { phase: "old" });
		await writer.putAsync(old);
		await writer.clearAsync();

		const fresh = makeEvidence("file-manifest", { phase: "fresh" });
		await writer.putAsync(fresh);

		const peer = new FileSharedEvidenceStore({ path: tmp.path });
		handles.push(peer);
		expect(peer.size()).toBe(1);
		expect(peer.get(old.id)).toBeUndefined();
		expect(peer.get(fresh.id)).toEqual(fresh);
	});
});

