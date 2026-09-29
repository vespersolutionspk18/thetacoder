/**
 * F10 file-backed shared evidence — persistence round-trip.
 *
 * The whole point of the file layer: a child process opened on the
 * same path sees the evidence the parent put there. These tests
 * simulate that by opening a second `FileSharedEvidenceStore`
 * pointing at the same file after the first one wrote.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSharedEvidenceStore } from "../src/core/repository/shared-evidence-ipc.ts";

import { makeEvidence, makeStorePath, type TempStore } from "./file-shared-evidence-helpers.ts";

describe("FileSharedEvidenceStore — persistence", () => {
	let tmp: TempStore;
	const handles: FileSharedEvidenceStore[] = [];

	beforeEach(async () => {
		tmp = await makeStorePath("persist");
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

	it("a fresh handle on the same path sees the parent's put", async () => {
		const parent = open();
		const ev = makeEvidence("file-manifest", { root: "/repo" });
		await parent.putAsync(ev);

		const child = open();
		expect(child.size()).toBe(1);
		expect(child.get(ev.id)).toEqual(ev);
	});

	it("the child sees every entry the parent put, in stable order", async () => {
		const parent = open();
		const e1 = makeEvidence("file-manifest", { a: 1 });
		const e2 = makeEvidence("syntax-index", { b: 2 });
		const e3 = makeEvidence("reference-result", { c: 3 });
		await parent.putAsync(e1);
		await parent.putAsync(e2);
		await parent.putAsync(e3);

		const child = open();
		expect(child.size()).toBe(3);
		const ids = new Set([e1.id, e2.id, e3.id]);
		for (const id of ids) {
			expect(child.get(id)).toBeDefined();
		}
	});

	it("reload() refreshes the in-memory cache from disk", async () => {
		const writer = open();
		const reader = open();
		const ev = makeEvidence("file-content", { path: "/x" });

		// Reader was opened before the writer put anything; the
		// reader's cache is therefore empty until reload().
		expect(reader.size()).toBe(0);

		await writer.putAsync(ev);
		expect(writer.size()).toBe(1);
		expect(reader.size()).toBe(0);

		await reader.reload();
		expect(reader.size()).toBe(1);
		expect(reader.get(ev.id)).toEqual(ev);
	});

	it("a put made with the sync API is visible to a fresh handle after flush()", async () => {
		const writer = open();
		const ev = makeEvidence("file-manifest", { sync: true });
		writer.put(ev);

		// The sync `put` schedules an async persist. We wait for it
		// to land via `flush()` rather than a fixed delay, so the
		// test stays deterministic regardless of how slow the disk
		// is on a given machine.
		await writer.flush();

		const child = open();
		expect(child.size()).toBe(1);
		expect(child.get(ev.id)?.payload).toEqual({ sync: true });
	});
});

