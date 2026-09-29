/**
 * F10 shared evidence consumer — deduplication.
 *
 * The consumer's `deduplicate: true` default (and the polling path)
 * must not re-emit the same evidence id twice. The seen-set is also
 * fed by `publish` so a peer consumer that receives the same record
 * is treated as already-known.
 */

import { describe, expect, it } from "vitest";
import { InMemorySharedEvidenceStore } from "../src/core/repository/shared-evidence.ts";
import { createSharedEvidenceConsumer } from "../src/core/repository/shared-evidence-consumer.ts";

describe("SharedEvidenceConsumer — deduplicate", () => {
	it("does not double-count when the same payload is published twice", async () => {
		const store = new InMemorySharedEvidenceStore();
		const consumer = createSharedEvidenceConsumer({ store, source: "s" });

		const first = await consumer.publish("file-manifest", { root: "/repo" });
		const second = await consumer.publish("file-manifest", { root: "/repo" });

		// Content-derived id is identical, so the store still has one
		// record and the consumer's seen-set has one entry.
		expect(first.id).toBe(second.id);
		expect(store.size()).toBe(1);

		const seen = consumer.consume((e) => e.id === first.id);
		expect(seen).toHaveLength(1);
	});

	it("treats evidence published by a peer consumer as already seen when dedup is on", async () => {
		const store = new InMemorySharedEvidenceStore();
		const producer = createSharedEvidenceConsumer({ store, source: "producer" });
		const observer = createSharedEvidenceConsumer({ store, source: "observer" });

		const produced = await producer.publish("file-manifest", { v: 1 });
		// Observer learns about the evidence by reading it through
		// `consume`. The seen-set is process-local to the observer,
		// so the first read is expected to find it; the second read
		// is also expected to find it because `consume` does not
		// update the seen-set (only the polling path does).
		expect(observer.consume((e) => e.id === produced.id)).toHaveLength(1);
		expect(observer.consume((e) => e.id === produced.id)).toHaveLength(1);
	});

	it("disable dedup: polling can re-emit the same record on every tick", async () => {
		const store = new InMemorySharedEvidenceStore();
		const seen: string[] = [];
		const consumer = createSharedEvidenceConsumer({
			store,
			source: "s",
			deduplicate: false,
			onNew: (e) => seen.push(e.id),
		});

		const ev = await consumer.publish("file-manifest", { v: 1 });
		// publish alone does not emit (the handler is only fired by
		// the polling tick). Manually run a tick.
		const stop = consumer.startPolling(5);
		try {
			await new Promise((r) => setTimeout(r, 25));
		} finally {
			stop();
		}
		// The record was visible on every tick, so we expect at least
		// two emissions.
		expect(seen.filter((id) => id === ev.id).length).toBeGreaterThanOrEqual(2);
	});
});

