/**
 * F10 shared evidence — TTL handling.
 *
 * `Evidence.ttlMs` is optional. When present, `getValidByKind` must
 * drop entries whose age has reached the TTL at the supplied `now`.
 * Without `now`, the store falls back to `Date.now()` — this test
 * always passes a synthetic `now` so it stays deterministic.
 */

import { describe, expect, it } from "vitest";
import {
	type Evidence,
	evidenceId,
	InMemorySharedEvidenceStore,
	isValid,
} from "../src/core/repository/shared-evidence.ts";

function ev(kind: Evidence["kind"], payload: unknown, createdAt: number, ttlMs?: number): Evidence {
	return {
		id: evidenceId(kind, payload),
		kind,
		source: "test",
		createdAt,
		ttlMs,
		payload,
	};
}

describe("InMemorySharedEvidenceStore — TTL", () => {
	it("treats entries without ttlMs as never expired", () => {
		const store = new InMemorySharedEvidenceStore();
		const noTtl: Evidence = ev("file-manifest", { root: "/r" }, 1_000);
		store.put(noTtl);

		expect(store.getValidByKind("file-manifest", 1_000_000_000).map((e) => e.id)).toEqual([noTtl.id]);
	});

	it("drops an entry whose age has reached ttlMs", () => {
		const store = new InMemorySharedEvidenceStore();
		const shortLived: Evidence = ev("syntax-index", { count: 1 }, 1_000, 100);
		store.put(shortLived);

		// Exactly at the boundary: createdAt + ttlMs → not strictly less
		// than, so the entry is considered expired.
		expect(store.getValidByKind("syntax-index", 1_100).map((e) => e.id)).toEqual([]);
	});

	it("keeps the entry alive just before the TTL boundary", () => {
		const store = new InMemorySharedEvidenceStore();
		const shortLived: Evidence = ev("syntax-index", { count: 1 }, 1_000, 100);
		store.put(shortLived);

		expect(store.getValidByKind("syntax-index", 1_099).map((e) => e.id)).toEqual([shortLived.id]);
	});

	it("filters out only the expired entry among multiple of the same kind", () => {
		const store = new InMemorySharedEvidenceStore();
		const alive: Evidence = ev("file-manifest", { root: "/alive" }, 1_000, 500);
		const expired: Evidence = ev("file-manifest", { root: "/expired" }, 1_000, 100);
		const noTtl: Evidence = ev("file-manifest", { root: "/forever" }, 1_000);
		store.put(alive);
		store.put(expired);
		store.put(noTtl);

		// At now=1400:
		//   alive    age=400 < 500 → valid
		//   expired  age=400 ≥ 100 → dropped
		//   noTtl    always valid
		const got = store.getValidByKind("file-manifest", 1_400);
		const ids = got.map((e) => e.id).sort();
		expect(ids).toEqual([alive.id, noTtl.id].sort());
	});

	it("isValid matches the rule 'now - createdAt < ttlMs'", () => {
		const e: Evidence = ev("syntax-index", { x: 1 }, 1_000, 100);
		expect(isValid(e, 1_050)).toBe(true);
		expect(isValid(e, 1_100)).toBe(false);
		expect(isValid(e, 1_101)).toBe(false);
	});

	it("falls back to Date.now() when 'now' is not provided", () => {
		const store = new InMemorySharedEvidenceStore();
		// Use a TTL that we know is well in the past relative to "now".
		const longExpired: Evidence = {
			id: evidenceId("file-content", { path: "/old" }),
			kind: "file-content",
			source: "test",
			createdAt: 0,
			ttlMs: 1,
			payload: { path: "/old" },
		};
		store.put(longExpired);

		expect(store.getValidByKind("file-content")).toEqual([]);
	});
});

