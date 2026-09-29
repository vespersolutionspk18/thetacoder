/**
 * F10 shared evidence consumer — predicate filtering.
 *
 * `consume` takes a predicate so callers can filter by kind, source,
 * payload, or anything else without the consumer having to bake every
 * possible query into the API.
 */

import { describe, expect, it } from "vitest";
import { InMemorySharedEvidenceStore } from "../src/core/repository/shared-evidence.ts";
import { createSharedEvidenceConsumer } from "../src/core/repository/shared-evidence-consumer.ts";

describe("SharedEvidenceConsumer — predicate filtering", () => {
	it("filters by kind", async () => {
		const store = new InMemorySharedEvidenceStore();
		const consumer = createSharedEvidenceConsumer({ store, source: "s" });

		const manifest = await consumer.publish("file-manifest", { path: "a" });
		const indexA = await consumer.publish("syntax-index", { path: "a" });
		const indexB = await consumer.publish("syntax-index", { path: "b" });

		const indexes = consumer.consume((e) => e.kind === "syntax-index");
		expect(indexes.map((e) => e.id).sort()).toEqual([indexA.id, indexB.id].sort());

		const manifests = consumer.consume((e) => e.kind === "file-manifest");
		expect(manifests.map((e) => e.id)).toEqual([manifest.id]);
	});

	it("filters by source", async () => {
		const store = new InMemorySharedEvidenceStore();
		const c1 = createSharedEvidenceConsumer({ store, source: "parent" });
		const c2 = createSharedEvidenceConsumer({ store, source: "child" });

		await c1.publish("file-manifest", { v: 1 });
		await c2.publish("file-manifest", { v: 2 });

		const fromParent = store.getByKind("file-manifest").filter((e) => e.source === "parent");
		expect(fromParent).toHaveLength(1);
		expect(fromParent[0].source).toBe("parent");
	});

	it("filters by payload content", async () => {
		const store = new InMemorySharedEvidenceStore();
		const consumer = createSharedEvidenceConsumer({ store, source: "s" });

		await consumer.publish("reference-result", { file: "a.ts" });
		await consumer.publish("reference-result", { file: "b.ts" });

		const aOnly = consumer.consume((e) => {
			return e.kind === "reference-result" && (e.payload as { file: string }).file === "a.ts";
		});
		expect(aOnly).toHaveLength(1);
		expect(aOnly[0].payload).toEqual({ file: "a.ts" });
	});

	it("returns an empty array when nothing matches", async () => {
		const store = new InMemorySharedEvidenceStore();
		const consumer = createSharedEvidenceConsumer({ store, source: "s" });

		await consumer.publish("file-manifest", { root: "/repo" });

		const none = consumer.consume((e) => e.kind === "compilation-result");
		expect(none).toEqual([]);
	});

	it("drops expired records from the consume result", async () => {
		const store = new InMemorySharedEvidenceStore();
		const consumer = createSharedEvidenceConsumer({ store, source: "s" });

		// 1ms ttl — the next tick of `consume` will see this as expired.
		await consumer.publish("file-content", { v: 1 }, { ttlMs: 1 });
		await new Promise((r) => setTimeout(r, 5));

		const remaining = consumer.consume((e) => e.kind === "file-content");
		expect(remaining).toEqual([]);
	});
});

