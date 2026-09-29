/**
 * F10 shared evidence consumer — IPC compatibility with the file store.
 *
 * The whole point of the consumer is to bridge AgentSession across
 * process boundaries. These tests use `FileSharedEvidenceStore` to
 * exercise the same publish / consume / poll contract on the IPC
 * transport. A "peer" handle on the same backing file represents
 * another process.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSharedEvidenceConsumer } from "../src/core/repository/shared-evidence-consumer.ts";
import { FileSharedEvidenceStore } from "../src/core/repository/shared-evidence-ipc.ts";

import { makeStorePath, type TempStore } from "./file-shared-evidence-helpers.ts";

describe("SharedEvidenceConsumer — file-backed (IPC)", () => {
	let tmp: TempStore;
	let store: FileSharedEvidenceStore | null = null;

	beforeEach(async () => {
		tmp = await makeStorePath("consumer-ipc");
	});

	afterEach(async () => {
		if (store) {
			await store.destroy();
			store = null;
		}
		await tmp.cleanup();
	});

	it("publishes through the file-backed store and reads back through consume", async () => {
		store = new FileSharedEvidenceStore({ path: tmp.path });
		const consumer = createSharedEvidenceConsumer({ store, source: "session-1" });

		const ev = await consumer.publish("file-manifest", { root: "/repo" });
		await store.flush();

		const found = consumer.consume((e) => e.id === ev.id);
		expect(found).toHaveLength(1);
		expect(found[0]?.source).toBe("session-1");
	});

	it("polling detects evidence written by a peer handle on the same file", async () => {
		store = new FileSharedEvidenceStore({ path: tmp.path });
		const observed: string[] = [];
		const consumer = createSharedEvidenceConsumer({
			store,
			source: "observer",
			onNew: (e) => observed.push(e.id),
		});

		// A second handle on the same path simulates another process.
		let peer: FileSharedEvidenceStore | null = new FileSharedEvidenceStore({ path: tmp.path });
		try {
			consumer.startPolling(10);
			try {
				await new Promise((r) => setTimeout(r, 15));
				// The peer writes through its own consumer, which
				// mutates the file-backed store. To make the new
				// record visible to the observer's in-memory cache
				// the observer's store must reload from disk before
				// the next tick.
				const peerConsumer = createSharedEvidenceConsumer({
					store: peer,
					source: "peer",
				});
				const ev = await peerConsumer.publish("file-manifest", { v: 1 });
				await peer.flush();
				// Reload so the observer's local cache mirrors disk.
				await store.reload();
				await new Promise((r) => setTimeout(r, 30));
				expect(observed).toContain(ev.id);
			} finally {
				consumer.stopPolling();
			}
		} finally {
			if (peer) await peer.destroy();
			peer = null;
		}
	});

	it("a fresh handle on the same file sees published evidence", async () => {
		// First handle: publish and flush.
		store = new FileSharedEvidenceStore({ path: tmp.path });
		const c1 = createSharedEvidenceConsumer({ store, source: "first" });
		const ev = await c1.publish("file-manifest", { root: "/repo" });
		await store.flush();
		expect(store.size()).toBe(1);
		expect(store.get(ev.id)?.source).toBe("first");

		// Second handle on the same path: simulates a fresh process
		// opening the same backing file. It should observe the
		// record the first handle wrote.
		const second = new FileSharedEvidenceStore({ path: tmp.path });
		try {
			const c2 = createSharedEvidenceConsumer({ store: second, source: "second" });
			const found = c2.consume((e) => e.kind === "file-manifest");
			expect(found).toHaveLength(1);
			expect(found[0]?.source).toBe("first");
		} finally {
			await second.destroy();
		}
	});
});

