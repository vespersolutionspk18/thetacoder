/**
 * F10 SharedEvidenceBridge — consume path.
 *
 * The bridge must read back prior read-evidence through
 * `consumeCachedReads`, applying the user's predicate and dropping
 * expired entries. The store is seeded directly so the test owns
 * the data and can verify predicate matching, kind filtering, and
 * ttl handling in isolation.
 */

import { describe, expect, it } from "vitest";
import type { Evidence } from "../src/core/repository/shared-evidence.ts";
import { InMemorySharedEvidenceStore } from "../src/core/repository/shared-evidence.ts";
import { createSharedEvidenceBridge } from "../src/core/shared-evidence-bridge.ts";

function makeFileContentEvidence(path: string, content: string, overrides: Partial<Evidence> = {}): Evidence {
	const payload = { path, content, byteLength: Buffer.byteLength(content, "utf-8") };
	// Use a synthetic but stable id; the test only cares that the
	// evidence shows up in the consume walk.
	const id = `seed-${path}-${content.length}-${payload.byteLength}`;
	return {
		id,
		kind: "file-content",
		source: "prior-child",
		createdAt: 1_700_000_000_000,
		contentHash: `hash-${id}`,
		payload,
		...overrides,
	};
}

describe("SharedEvidenceBridge — consume", () => {
	it("returns every seeded file-content record that matches the predicate", () => {
		const store = new InMemorySharedEvidenceStore();
		const bridge = createSharedEvidenceBridge({ store, source: "parent" });

		store.put(makeFileContentEvidence("/repo/a.ts", "a"));
		store.put(makeFileContentEvidence("/repo/b.ts", "b"));
		store.put(makeFileContentEvidence("/repo/c.ts", "c"));

		const matches = bridge.consumeCachedReads((e) => (e.payload as { path: string }).path !== "/repo/b.ts");

		expect(matches.map((e) => (e.payload as { path: string }).path).sort()).toEqual(["/repo/a.ts", "/repo/c.ts"]);
	});

	it("returns an empty array when nothing matches", () => {
		const store = new InMemorySharedEvidenceStore();
		const bridge = createSharedEvidenceBridge({ store, source: "parent" });

		store.put(makeFileContentEvidence("/repo/a.ts", "a"));

		const matches = bridge.consumeCachedReads((e) => (e.payload as { path: string }).path === "/repo/never.ts");
		expect(matches).toEqual([]);
	});

	it("only returns file-content records; other kinds are filtered out", () => {
		const store = new InMemorySharedEvidenceStore();
		const bridge = createSharedEvidenceBridge({ store, source: "parent" });

		store.put(makeFileContentEvidence("/repo/a.ts", "a"));
		store.put({
			id: "syntax-index-1",
			kind: "syntax-index",
			source: "prior-child",
			createdAt: 1_700_000_000_000,
			payload: { count: 10 },
		});
		store.put({
			id: "manifest-1",
			kind: "file-manifest",
			source: "prior-child",
			createdAt: 1_700_000_000_000,
			payload: { root: "/repo" },
		});

		const matches = bridge.consumeCachedReads(() => true);
		expect(matches).toHaveLength(1);
		expect(matches[0].kind).toBe("file-content");
	});

	it("drops entries whose ttlMs has elapsed", () => {
		const store = new InMemorySharedEvidenceStore();
		const bridge = createSharedEvidenceBridge({ store, source: "parent" });

		const now = Date.now();
		// expired: created 60s ago with a 30s ttl
		store.put(
			makeFileContentEvidence("/repo/old.ts", "old", {
				createdAt: now - 60_000,
				ttlMs: 30_000,
			}),
		);
		// fresh: created 5s ago with a 30s ttl
		store.put(
			makeFileContentEvidence("/repo/fresh.ts", "fresh", {
				createdAt: now - 5_000,
				ttlMs: 30_000,
			}),
		);
		// never expires
		store.put(makeFileContentEvidence("/repo/forever.ts", "forever"));

		const matches = bridge.consumeCachedReads(() => true);
		const paths = matches.map((e) => (e.payload as { path: string }).path).sort();
		expect(paths).toEqual(["/repo/forever.ts", "/repo/fresh.ts"]);
	});

	it("exposes the full Evidence record to the predicate (id, source, contentHash, payload)", () => {
		const store = new InMemorySharedEvidenceStore();
		const bridge = createSharedEvidenceBridge({ store, source: "parent" });

		const target = makeFileContentEvidence("/repo/target.ts", "abc");
		store.put(target);
		store.put(makeFileContentEvidence("/repo/other.ts", "xyz"));

		const seen: Evidence[] = [];
		const matches = bridge.consumeCachedReads((evidence) => {
			seen.push(evidence);
			return evidence.id === target.id;
		});

		expect(seen.length).toBe(2);
		expect(matches).toHaveLength(1);
		expect(matches[0].id).toBe(target.id);
		expect(matches[0].contentHash).toBe(target.contentHash);
		expect(matches[0].source).toBe(target.source);
		expect((matches[0].payload as { content: string }).content).toBe("abc");
	});
});

