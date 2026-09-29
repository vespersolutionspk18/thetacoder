/**
 * F10 shared evidence — AgentSession bridge.
 *
 * `SharedEvidenceStore` and `SharedEvidenceConsumer` are pure data
 * layers. `AgentSession` needs a thin wrapper that:
 *
 *   - knows how to translate a successful `read` tool result into a
 *     `file-content` evidence record (path + contentHash + byteLength
 *     + the actual text), so a parent agent that already read the
 *     same file can read it back from the store instead of re-reading
 *     from disk;
 *   - knows how to read those records back out for a parent (or any
 *     cooperating) session.
 *
 * The bridge borrows a `SharedEvidenceStore` from its owner — it does
 * not create or destroy the store. When the session is constructed
 * without one, no bridge is built and the tool-execution path becomes
 * a no-op for shared evidence.
 *
 * Multi-process safety: the bridge is a thin publisher over a
 * `SharedEvidenceStore`. If that store is the file-backed
 * `FileSharedEvidenceStore`, two processes opening the same path
 * share a coherent view through the file. The in-memory store only
 * shares within a single process. The choice of store is the owner's;
 * the bridge neither knows nor cares.
 */

import { type Evidence, evidenceId, isValid, type SharedEvidenceStore } from "./repository/shared-evidence.ts";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Payload stored on `file-content` evidence records. Carries enough
 * information for a consumer to reconstruct what the producer read:
 *
 *   - `path` — the absolute file path the producer used;
 *   - `content` — the text bytes (truncated/offset slices are recorded
 *     via `offset` / `limit` so the consumer can rebuild the read);
 *   - `byteLength` — the length of `content` in UTF-8 bytes;
 *   - `offset` / `limit` — when the read was a slice, the
 *     1-indexed start line and the line count.
 */
export interface ReadEvidencePayload {
	path: string;
	content: string;
	byteLength: number;
	offset?: number;
	limit?: number;
}

/**
 * Options for constructing a `SharedEvidenceBridge`.
 */
export interface SharedEvidenceBridgeOptions {
	/**
	 * The store to publish to and read from. The bridge does not own
	 * the store — destroying or closing it is the caller's job.
	 */
	store: SharedEvidenceStore;
	/**
	 * Identity recorded as `Evidence.source` on every record the bridge
	 * publishes. Usually a stable session id or `"parent"` / `"child"`.
	 * Lets a downstream consumer tell who produced each record.
	 */
	source: string;
}

/**
 * Options for a `publishRead` call. All fields are optional.
 */
export interface PublishReadOptions {
	/** 1-indexed start line, when the read was a slice. */
	offset?: number;
	/** Line count of the slice, when the read was bounded by `limit`. */
	limit?: number;
	/**
	 * Expiry in milliseconds from `createdAt`. When set, `consume` will
	 * drop the record after that window. Defaults to no expiry.
	 */
	ttlMs?: number;
}

/**
 * Public surface of the bridge. `publishRead` is a thin convenience
 * over the underlying `SharedEvidenceStore` that knows how to shape a
 * `read` result; `consumeCachedReads` is the inverse, returning every
 * stored `file-content` record that matches the caller's predicate.
 */
export interface SharedEvidenceBridge {
	/**
	 * Publish a successful read result. Returns the freshly recorded
	 * `Evidence` so the caller can correlate later reads against the
	 * same id.
	 *
	 * `contentHash` is stored on the top-level `Evidence.contentHash`
	 * field (the canonical digest the read tool already computed);
	 * `path`, `content`, and `byteLength` live in the `payload`.
	 */
	publishRead(path: string, content: string, contentHash: string, options?: PublishReadOptions): Promise<Evidence>;

	/**
	 * Return every `file-content` record in the store that matches
	 * `predicate`. Expiry is honored: records whose `ttlMs` has
	 * elapsed at the time of the call are filtered out.
	 */
	consumeCachedReads(predicate: (evidence: Evidence) => boolean): Evidence[];
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a bridge bound to a store. Returns an object with
 * `publishRead` and `consumeCachedReads`; no background timers or
 * listeners are registered, so the bridge is cheap to construct and
 * safe to discard.
 */
export function createSharedEvidenceBridge(options: SharedEvidenceBridgeOptions): SharedEvidenceBridge {
	const { store, source } = options;
	return {
		async publishRead(path, content, contentHash, opts) {
			const payload: ReadEvidencePayload = {
				path,
				content,
				byteLength: Buffer.byteLength(content, "utf-8"),
				...(opts?.offset !== undefined ? { offset: opts.offset } : {}),
				...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
			};
			const evidence: Evidence = {
				id: evidenceId("file-content", payload),
				kind: "file-content",
				source,
				createdAt: Date.now(),
				...(opts?.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
				payload,
				contentHash,
			};
			store.put(evidence);
			return evidence;
		},

		consumeCachedReads(predicate) {
			const stamp = Date.now();
			const out: Evidence[] = [];
			// Walk the kind directly; `consumeCachedReads` is a
			// file-content-only view. We could route through the
			// `SharedEvidenceConsumer.consume` helper for shared
			// dedup/polling semantics, but the bridge does not
			// maintain a seen-set and the consumer does not know
			// about kind filtering, so a direct walk is simpler
			// and cheaper.
			for (const evidence of store.getByKind("file-content")) {
				if (!isValid(evidence, stamp)) continue;
				if (predicate(evidence)) out.push(evidence);
			}
			return out;
		},
	};
}

