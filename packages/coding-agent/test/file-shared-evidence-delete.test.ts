/**
 * F10 file-backed shared evidence — delete.
 *
 * `delete` updates the in-memory cache immediately and then persists.
 * A fresh handle on the same path must not see the deleted entry.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Evidence } from "../src/core/repository/shared-evidence.ts";
import { FileSharedEvidenceStore } from "../src/core/repository/shared-evidence-ipc.ts";

import { makeEvidence, makeStorePath, type TempStore } from "./file-shared-evidence-helpers.ts";

describe("FileSharedEvidenceStore — delete", () => {
	let tmp: TempStore;
	const handles: FileSharedEvidenceStore[] = [];

	beforeEach(async () => {
		tmp = await makeStorePath("delete");
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

	it("removes the entry so get returns undefined", async () => {
		const store = open();
		const entry = makeEvidence("file-manifest", { root: "/repo" });
		await store.putAsync(entry);

		expect(store.get(entry.id)).toEqual(entry);

		store.delete(entry.id);
		await store.deleteAsync(entry.id);

		expect(store.get(entry.id)).toBeUndefined();
		expect(store.size()).toBe(0);
	});

	it("the deletion is visible to a fresh handle on the same path", async () => {
		const writer = open();
		const entry = makeEvidence("file-manifest", { root: "/repo" });
		await writer.putAsync(entry);

		const peer = new FileSharedEvidenceStore({ path: tmp.path });
		handles.push(peer);
		expect(peer.get(entry.id)).toBeDefined();

		await writer.deleteAsync(entry.id);

		const peer2 = new FileSharedEvidenceStore({ path: tmp.path });
		handles.push(peer2);
		expect(peer2.get(entry.id)).toBeUndefined();
		expect(peer2.size()).toBe(0);
	});

	it("is a no-op for an id that is not present", async () => {
		const store = open();
		const entry = makeEvidence("file-manifest", { root: "/repo" });
		await store.putAsync(entry);

		store.delete("not-a-real-id");
		await store.deleteAsync("not-a-real-id");

		expect(store.size()).toBe(1);
		expect(store.get(entry.id)).toEqual(entry);
	});

	it("can be re-inserted after deletion with the same id", async () => {
		const store = open();
		const first: Evidence = { ...makeEvidence("compilation-result", { ok: true }), source: "first" };
		const second: Evidence = { ...first, source: "second" };

		await store.putAsync(first);
		await store.deleteAsync(first.id);
		await store.putAsync(second);

		expect(store.size()).toBe(1);
		expect(store.get(first.id)?.source).toBe("second");
	});
});

