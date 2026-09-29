/**
 * F10 shared evidence consumer — polling fires onNew.
 *
 * Polling is the bridge between the file-backed store (which is
 * process-isolated) and a long-lived AgentSession. The polling tick
 * must:
 *   - fire `onNew` for every record it has not yet seen,
 *   - leave a stopped polling loop alone.
 */

import { describe, expect, it } from "vitest";
import { InMemorySharedEvidenceStore } from "../src/core/repository/shared-evidence.ts";
import { createSharedEvidenceConsumer } from "../src/core/repository/shared-evidence-consumer.ts";

describe("SharedEvidenceConsumer — polling", () => {
	it("fires onNew when new evidence is published to the store", async () => {
		const store = new InMemorySharedEvidenceStore();
		const received: string[] = [];
		const consumer = createSharedEvidenceConsumer({
			store,
			source: "s",
			onNew: (e) => received.push(e.id),
		});

		consumer.startPolling(10);
		try {
			// Wait a tick so the interval is actually armed.
			await new Promise((r) => setTimeout(r, 15));
			await consumer.publish("file-manifest", { v: 1 });
			await new Promise((r) => setTimeout(r, 30));
		} finally {
			consumer.stopPolling();
		}

		const expectedId = store.getByKind("file-manifest")[0]?.id;
		expect(expectedId).toBeDefined();
		expect(received).toContain(expectedId);
	});

	it("does not re-emit evidence it has already seen", async () => {
		const store = new InMemorySharedEvidenceStore();
		const seen: string[] = [];
		const consumer = createSharedEvidenceConsumer({
			store,
			source: "s",
			onNew: (e) => seen.push(e.id),
		});

		consumer.startPolling(5);
		try {
			await new Promise((r) => setTimeout(r, 10));
			await consumer.publish("file-manifest", { v: 1 });
			await new Promise((r) => setTimeout(r, 60));
		} finally {
			consumer.stopPolling();
		}

		// Only one emission despite multiple ticks.
		expect(seen).toHaveLength(1);
	});

	it("startPolling returns a stop function that ends the interval", async () => {
		const store = new InMemorySharedEvidenceStore();
		const seen: string[] = [];
		const consumer = createSharedEvidenceConsumer({
			store,
			source: "s",
			onNew: (e) => seen.push(e.id),
		});

		const stop = consumer.startPolling(5);
		await new Promise((r) => setTimeout(r, 10));
		await consumer.publish("file-manifest", { v: 1 });
		await new Promise((r) => setTimeout(r, 30));
		stop();

		const before = seen.length;
		// Publish more; the stopped interval must not pick it up.
		await consumer.publish("file-manifest", { v: 2 });
		await new Promise((r) => setTimeout(r, 30));
		expect(seen.length).toBe(before);
	});

	it("fires onNew for evidence published by a different consumer", async () => {
		const store = new InMemorySharedEvidenceStore();
		const seen: string[] = [];
		const observer = createSharedEvidenceConsumer({
			store,
			source: "observer",
			onNew: (e) => seen.push(e.id),
		});
		const producer = createSharedEvidenceConsumer({ store, source: "producer" });

		observer.startPolling(5);
		try {
			await new Promise((r) => setTimeout(r, 10));
			const ev = await producer.publish("file-manifest", { v: 1 });
			await new Promise((r) => setTimeout(r, 30));
			expect(seen).toContain(ev.id);
		} finally {
			observer.stopPolling();
		}
	});
});

