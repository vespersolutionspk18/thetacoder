/**
 * F10 SharedEvidenceBridge — publish path.
 *
 * A successful read tool call must end up as a `file-content`
 * `Evidence` record in the store, carrying the path, the byte
 * length, and the content hash. The bridge is the only writer; the
 * test drives the bridge directly so the assertion focuses on the
 * shape of the published record.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Evidence } from "../src/core/repository/shared-evidence.ts";
import { InMemorySharedEvidenceStore } from "../src/core/repository/shared-evidence.ts";
import { FileSharedEvidenceStore } from "../src/core/repository/shared-evidence-ipc.ts";
import { createSharedEvidenceBridge, type SharedEvidenceBridge } from "../src/core/shared-evidence-bridge.ts";

function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf-8").digest("hex");
}

interface TempDir {
	dir: string;
	cleanup: () => Promise<void>;
}

async function makeTempDir(prefix: string): Promise<TempDir> {
	const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
	return {
		dir,
		cleanup: async () => {
			await rm(dir, { recursive: true, force: true });
		},
	};
}

describe("SharedEvidenceBridge — publish", () => {
	let bridge: SharedEvidenceBridge;
	let store: InMemorySharedEvidenceStore;
	let tmp: TempDir | null = null;
	let fileStore: FileSharedEvidenceStore | null = null;

	beforeEach(() => {
		store = new InMemorySharedEvidenceStore();
		bridge = createSharedEvidenceBridge({ store, source: "child-session" });
	});

	afterEach(async () => {
		if (fileStore) {
			await fileStore.destroy();
			fileStore = null;
		}
		if (tmp) {
			await tmp.cleanup();
			tmp = null;
		}
	});

	it("publishes a file-content evidence record with path, contentHash, and byteLength", async () => {
		const path = "/repo/src/example.ts";
		const content = "export const x = 1;\n";
		const contentHash = sha256Hex(content);

		const evidence = await bridge.publishRead(path, content, contentHash);

		expect(evidence.kind).toBe("file-content");
		expect(evidence.source).toBe("child-session");
		expect(evidence.contentHash).toBe(contentHash);
		expect(evidence.id.length).toBeGreaterThan(0);
		expect(typeof evidence.createdAt).toBe("number");

		const payload = evidence.payload as {
			path: string;
			content: string;
			byteLength: number;
		};
		expect(payload.path).toBe(path);
		expect(payload.content).toBe(content);
		expect(payload.byteLength).toBe(Buffer.byteLength(content, "utf-8"));
	});

	it("lands the published record in the store so a consumer can fetch by id", async () => {
		const path = "/repo/src/index.ts";
		const content = "console.log('hi');\n";
		const contentHash = sha256Hex(content);

		const evidence = await bridge.publishRead(path, content, contentHash);
		const fetched = store.get(evidence.id);

		expect(fetched).toEqual(evidence);
		expect(store.size()).toBe(1);
		expect(store.getByKind("file-content")).toHaveLength(1);
	});

	it("records optional offset and limit when the read was a slice", async () => {
		const path = "/repo/src/large.ts";
		const slice = "line a\nline b\n";
		const contentHash = sha256Hex(slice);

		const evidence = await bridge.publishRead(path, slice, contentHash, {
			offset: 10,
			limit: 2,
		});

		const payload = evidence.payload as {
			path: string;
			content: string;
			byteLength: number;
			offset?: number;
			limit?: number;
		};
		expect(payload.offset).toBe(10);
		expect(payload.limit).toBe(2);
	});

	it("stamps ttlMs onto the evidence when the caller asks for one", async () => {
		const evidence = await bridge.publishRead("/repo/src/short.ts", "x", sha256Hex("x"), { ttlMs: 30_000 });

		expect(evidence.ttlMs).toBe(30_000);
	});

	it("produces a stable id for the same path+content+offset+limit", async () => {
		const path = "/repo/src/same.ts";
		const content = "same content\n";
		const contentHash = sha256Hex(content);

		const first = await bridge.publishRead(path, content, contentHash, { offset: 1, limit: 1 });
		const second = await bridge.publishRead(path, content, contentHash, { offset: 1, limit: 1 });

		expect(first.id).toBe(second.id);
		// Putting the same id is a no-op for the store's size.
		expect(store.size()).toBe(1);
	});

	it("persists through a file-backed store (writes to disk so a peer can read it)", async () => {
		tmp = await makeTempDir("bridge-publish-file");
		const path = join(tmp.dir, "evidence.json");
		fileStore = new FileSharedEvidenceStore({ path });
		const fileBridge = createSharedEvidenceBridge({ store: fileStore, source: "child" });

		const content = "persistent content\n";
		const contentHash = sha256Hex(content);
		const evidence = await fileBridge.publishRead("/repo/src/file-backed.ts", content, contentHash);
		await fileStore.flush();

		// A fresh handle on the same backing file sees the entry.
		const peer = new FileSharedEvidenceStore({ path });
		try {
			const peerFetched = peer.get(evidence.id) as Evidence | undefined;
			expect(peerFetched).toBeDefined();
			expect(peerFetched?.kind).toBe("file-content");
			expect(peerFetched?.contentHash).toBe(contentHash);
			const payload = peerFetched?.payload as { content: string; byteLength: number };
			expect(payload.content).toBe(content);
			expect(payload.byteLength).toBe(Buffer.byteLength(content, "utf-8"));
		} finally {
			await peer.destroy();
		}
	});
});

