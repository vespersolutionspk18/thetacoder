/**
 * F10 file-backed shared evidence — TTL handling.
 *
 * The TTL rule lives in `isValid` (shared-evidence.ts). The file
 * store must apply the same rule from the in-memory cache. We use
 * synthetic `now` values so the test is deterministic.
 *
 * (File name kept as the spec named it: `tll.test.ts`. The internal
 * `describe` block uses the correct `TTL` spelling.)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Evidence } from "../src/core/repository/shared-evidence.ts";
import { evidenceId } from "../src/core/repository/shared-evidence.ts";
import { FileSharedEvidenceStore } from "../src/core/repository/shared-evidence-ipc.ts";

import { makeStorePath, type TempStore } from "./file-shared-evidence-helpers.ts";

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

describe("FileSharedEvidenceStore — TTL", () => {
	let tmp: TempStore;
	const handles: FileSharedEvidenceStore[] = [];
	let store: FileSharedEvidenceStore | null = null;

	beforeEach(async () => {
		tmp = await makeStorePath("ttl");
	});

	afterEach(async () => {
		if (store) await store.destroy();
		store = null;
		for (const h of handles) await h.destroy();
		handles.length = 0;
		await tmp.cleanup();
	});

	it("drops an entry whose age has reached ttlMs", async () => {
		store = new FileSharedEvidenceStore({ path: tmp.path });
		const shortLived: Evidence = ev("syntax-index", { count: 1 }, 1_000, 100);
		await store.putAsync(shortLived);

		// Boundary: createdAt + ttlMs is considered expired (the
		// rule is `now - createdAt < ttlMs`, strict less than).
		expect(store.getValidByKind("syntax-index", 1_100).map((e) => e.id)).toEqual([]);
	});

	it("keeps the entry alive just before the TTL boundary", async () => {
		store = new FileSharedEvidenceStore({ path: tmp.path });
		const shortLived: Evidence = ev("syntax-index", { count: 1 }, 1_000, 100);
		await store.putAsync(shortLived);

		expect(store.getValidByKind("syntax-index", 1_099).map((e) => e.id)).toEqual([shortLived.id]);
	});

	it("treats entries without ttlMs as never expired", async () => {
		store = new FileSharedEvidenceStore({ path: tmp.path });
		const noTtl: Evidence = ev("file-manifest", { root: "/r" }, 1_000);
		await store.putAsync(noTtl);

		expect(store.getValidByKind("file-manifest", 1_000_000_000).map((e) => e.id)).toEqual([noTtl.id]);
	});

	it("getValidByKind respects TTL after a fresh handle on the same file", async () => {
		// Parent writes, then a child opens the same file. The TTL
		// check applies to the payload's `createdAt`, not to the
		// current wall clock, so an expired entry is dropped
		// regardless of when the child opened the store. We keep
		// the parent handle around so the file is not removed by
		// teardown before the child reads it.
		const parent = new FileSharedEvidenceStore({ path: tmp.path });
		handles.push(parent);
		const stale: Evidence = ev("file-manifest", { root: "/stale" }, 1_000, 100);
		await parent.putAsync(stale);

		const child = new FileSharedEvidenceStore({ path: tmp.path });
		handles.push(child);
		store = child;
		expect(child.getValidByKind("file-manifest", 1_200)).toEqual([]);
		// But getByKind returns the raw entry, expired or not.
		expect(child.getByKind("file-manifest")).toHaveLength(1);
	});

	it("filters out only the expired entry among multiple of the same kind", async () => {
		store = new FileSharedEvidenceStore({ path: tmp.path });
		const alive: Evidence = ev("file-manifest", { root: "/alive" }, 1_000, 500);
		const expired: Evidence = ev("file-manifest", { root: "/expired" }, 1_000, 100);
		const noTtl: Evidence = ev("file-manifest", { root: "/forever" }, 1_000);
		await store.putAsync(alive);
		await store.putAsync(expired);
		await store.putAsync(noTtl);

		const got = store.getValidByKind("file-manifest", 1_400);
		const ids = got.map((e) => e.id).sort();
		expect(ids).toEqual([alive.id, noTtl.id].sort());
	});
});

