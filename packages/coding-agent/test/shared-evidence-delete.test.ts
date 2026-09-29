/**
 * F10 shared evidence — delete.
 *
 * After `delete(id)` the entry must be gone: `get` returns
 * `undefined`, `getByKind` does not surface it, and `size` shrinks by
 * one. Deleting a non-existent id is a no-op.
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

describe("InMemorySharedEvidenceStore — delete", () => {
	it("removes the entry so get returns undefined", () => {
		const store = new InMemorySharedEvidenceStore();
		const entry = ev("file-manifest", { root: "/repo" });
		store.put(entry);

		expect(store.get(entry.id)).toBe(entry);

		store.delete(entry.id);

		expect(store.get(entry.id)).toBeUndefined();
		expect(store.size()).toBe(0);
	});

	it("removes the entry from getByKind results", () => {
		const store = new InMemorySharedEvidenceStore();
		const a = ev("syntax-index", { a: 1 });
		const b = ev("syntax-index", { b: 2 });
		const c = ev("syntax-index", { c: 3 });
		store.put(a);
		store.put(b);
		store.put(c);

		store.delete(b.id);

		const remaining = store
			.getByKind("syntax-index")
			.map((e) => e.id)
			.sort();
		expect(remaining).toEqual([a.id, c.id].sort());
	});

	it("is a no-op for an id that is not present", () => {
		const store = new InMemorySharedEvidenceStore();
		const entry = ev("file-manifest", { root: "/repo" });
		store.put(entry);

		store.delete("not-a-real-id");

		expect(store.size()).toBe(1);
		expect(store.get(entry.id)).toBe(entry);
	});

	it("can be re-inserted after deletion with the same id", () => {
		const store = new InMemorySharedEvidenceStore();
		const first: Evidence = { ...ev("compilation-result", { ok: true }), source: "first" };
		const second: Evidence = { ...first, source: "second" };

		store.put(first);
		store.delete(first.id);
		store.put(second);

		expect(store.size()).toBe(1);
		expect(store.get(first.id)?.source).toBe("second");
	});
});

