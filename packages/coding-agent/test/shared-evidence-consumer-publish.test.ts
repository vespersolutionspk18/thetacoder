/**
 * F10 shared evidence consumer — publish + consume.
 *
 * The consumer's main job is to stamp `id`, `source`, and `createdAt`
 * and put the record into the store. `consume` then reads it back
 * through a predicate filter. This test covers that round-trip on the
 * in-memory store.
 */

import { describe, expect, it } from "vitest";
import { InMemorySharedEvidenceStore } from "../src/core/repository/shared-evidence.ts";
import { createSharedEvidenceConsumer } from "../src/core/repository/shared-evidence-consumer.ts";

describe("SharedEvidenceConsumer — publish + consume", () => {
	it("publishes an evidence record and reads it back through consume", async () => {
		const store = new InMemorySharedEvidenceStore();
		const consumer = createSharedEvidenceConsumer({
			store,
			source: "session-1",
		});

		const ev = await consumer.publish("file-manifest", { root: "/repo" });

		expect(ev.id).toBeTypeOf("string");
		expect(ev.id.length).toBeGreaterThan(0);
		expect(ev.source).toBe("session-1");
		expect(ev.kind).toBe("file-manifest");
		expect(ev.payload).toEqual({ root: "/repo" });
		expect(typeof ev.createdAt).toBe("number");

		const found = consumer.consume((e) => e.id === ev.id);
		expect(found).toHaveLength(1);
		expect(found[0]).toEqual(ev);
	});

	it("uses options.source when provided, otherwise the consumer default", async () => {
		const store = new InMemorySharedEvidenceStore();
		const consumer = createSharedEvidenceConsumer({
			store,
			source: "default-source",
		});

		const defaultPublished = await consumer.publish("syntax-index", { a: 1 });
		const overridden = await consumer.publish("syntax-index", { a: 2 }, { source: "override" });

		expect(defaultPublished.source).toBe("default-source");
		expect(overridden.source).toBe("override");
	});

	it("applies ttlMs when provided", async () => {
		const store = new InMemorySharedEvidenceStore();
		const consumer = createSharedEvidenceConsumer({ store, source: "s" });

		const ev = await consumer.publish("file-content", { x: 1 }, { ttlMs: 60_000 });
		expect(ev.ttlMs).toBe(60_000);

		// Without ttlMs: omitted.
		const forever = await consumer.publish("file-content", { x: 2 });
		expect(forever.ttlMs).toBeUndefined();
	});
});

