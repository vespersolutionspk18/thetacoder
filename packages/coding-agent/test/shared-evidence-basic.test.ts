/**
 * F10 shared evidence — basic put / get / size.
 *
 * The store is a thin `Map` wrapper, so this test exercises the
 * happy-path surface area: insert, look up, count, then clear.
 */

import { describe, expect, it } from "vitest";
import {
	type Evidence,
	type EvidenceKind,
	evidenceId,
	InMemorySharedEvidenceStore,
} from "../src/core/repository/shared-evidence.ts";

function makeEvidence(kind: EvidenceKind, payload: unknown, id?: string): Evidence {
	return {
		id: id ?? evidenceId(kind, payload),
		kind,
		source: "test",
		createdAt: 1_700_000_000_000,
		payload,
	};
}

describe("InMemorySharedEvidenceStore — basic", () => {
	it("starts empty", () => {
		const store = new InMemorySharedEvidenceStore();
		expect(store.size()).toBe(0);
		expect(store.get("missing")).toBeUndefined();
	});

	it("stores and retrieves an evidence record", () => {
		const store = new InMemorySharedEvidenceStore();
		const ev = makeEvidence("file-manifest", { root: "/repo" });

		store.put(ev);

		expect(store.size()).toBe(1);
		expect(store.get(ev.id)).toBe(ev);
	});

	it("replaces an existing record when the same id is put again", () => {
		const store = new InMemorySharedEvidenceStore();
		const first = makeEvidence("syntax-index", { count: 10 });
		const second: Evidence = { ...first, source: "updated", payload: { count: 20 } };

		store.put(first);
		store.put(second);

		expect(store.size()).toBe(1);
		expect(store.get(first.id)?.source).toBe("updated");
		expect(store.get(first.id)?.payload).toEqual({ count: 20 });
	});

	it("clear() drops every record", () => {
		const store = new InMemorySharedEvidenceStore();
		store.put(makeEvidence("file-manifest", { a: 1 }));
		store.put(makeEvidence("syntax-index", { b: 2 }));
		expect(store.size()).toBe(2);

		store.clear();
		expect(store.size()).toBe(0);
		expect(store.getByKind("file-manifest")).toEqual([]);
		expect(store.getByKind("syntax-index")).toEqual([]);
	});
});

