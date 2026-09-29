/**
 * F10 shared evidence store.
 *
 * Parent and child subagents working on the same worktree repeatedly
 * walk the same trees, re-parse the same files, and recompute the same
 * hashes. F1's `manifest` and `syntax-index` modules already produce
 * versioned, content-addressable facts about the worktree; this module
 * gives them a place to live so a child can read what a parent (or a
 * prior child) already computed instead of paying the cost again.
 *
 * The store is deliberately a pure data layer:
 *
 *   - It does not know how to walk a worktree, parse source, or hash
 *     files. Callers hand it an already-serialized `payload`.
 *   - It does not integrate with the agent loop, tool dispatch, or
 *     session state. A future wiring layer (F10+) will decide when to
 *     call `put` / `get` and how to serialize `payload` for IPC.
 *   - The `id` is content-derived (`sha256(kind || canonicalize(payload))`)
 *     so two agents that hash the same input the same way naturally
 *     agree on the id without coordinating.
 *
 * `InMemorySharedEvidenceStore` is a process-local `Map`; a future
 * implementation may back it with a file or a Unix-socket IPC channel,
 * but the public contract is the `SharedEvidenceStore` interface.
 */

import { createHash } from "node:crypto";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Coarse classification of an evidence payload. The union is closed
 * because `evidenceId` mixes the kind into the digest; adding a new
 * kind without a code change would silently collide with an existing
 * payload shape.
 */
export type EvidenceKind =
	| "file-manifest"
	| "syntax-index"
	| "reference-result"
	| "file-content"
	| "compilation-result";

/**
 * One piece of computed repository evidence.
 *
 * `payload` is intentionally `unknown` — the store does not introspect
 * it. Callers are responsible for serializing (e.g. with
 * `JSON.stringify`) and deserializing (e.g. with a type guard) at the
 * boundary. The canonicalization used by `evidenceId` expects a value
 * that `JSON.stringify` can represent deterministically; the helper
 * itself handles `Map` / `Set` / `undefined`-in-arrays normalization.
 */
export interface Evidence {
	/** Content-derived id, see `evidenceId`. */
	id: string;
	kind: EvidenceKind;
	/** Free-form creator label, e.g. `"parent"` or a child session id. */
	source: string;
	/** Wall-clock creation time in milliseconds (`Date.now()`). */
	createdAt: number;
	/** Optional expiry in milliseconds; absence means "never expires". */
	ttlMs?: number;
	/** Serialized evidence payload. Opaque to the store. */
	payload: unknown;
	/**
	 * For `kind: "file-content"`, the SHA-256 hex digest of the file
	 * bytes. Lets readers detect drift between the cached payload and
	 * the current on-disk file without reading either.
	 */
	contentHash?: string;
}

/**
 * A versioned evidence store. Implementations are expected to be
 * safe to call from a single agent loop; concurrent use across
 * multiple child processes is the responsibility of a future
 * transport layer.
 */
export interface SharedEvidenceStore {
	/** Insert or replace an evidence record. */
	put(evidence: Evidence): void;
	/** Look up by id. Returns `undefined` if not present. */
	get(id: string): Evidence | undefined;
	/** Return every evidence record of the given kind, expired or not. */
	getByKind(kind: EvidenceKind): Evidence[];
	/** Like `getByKind` but drops entries whose `ttlMs` has elapsed at `now`. */
	getValidByKind(kind: EvidenceKind, now?: number): Evidence[];
	/** Remove the record with the given id. */
	delete(id: string): void;
	/** Number of records currently held. */
	size(): number;
	/** Drop every record. */
	clear(): void;
}

/* -------------------------------------------------------------------------- */
/* In-memory implementation                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Process-local `SharedEvidenceStore` backed by a `Map<string, Evidence>`.
 *
 * Iteration order of `getByKind` / `getValidByKind` follows insertion
 * order, which is a stable and well-defined promise of the underlying
 * `Map`. Callers that need a different order (e.g. by `createdAt`)
 * should sort the result themselves.
 */
export class InMemorySharedEvidenceStore implements SharedEvidenceStore {
	private readonly entries: Map<string, Evidence> = new Map();

	put(evidence: Evidence): void {
		this.entries.set(evidence.id, evidence);
	}

	get(id: string): Evidence | undefined {
		return this.entries.get(id);
	}

	getByKind(kind: EvidenceKind): Evidence[] {
		const out: Evidence[] = [];
		for (const entry of this.entries.values()) {
			if (entry.kind === kind) out.push(entry);
		}
		return out;
	}

	getValidByKind(kind: EvidenceKind, now?: number): Evidence[] {
		const stamp = now ?? Date.now();
		const out: Evidence[] = [];
		for (const entry of this.entries.values()) {
			if (entry.kind !== kind) continue;
			if (!isValid(entry, stamp)) continue;
			out.push(entry);
		}
		return out;
	}

	delete(id: string): void {
		this.entries.delete(id);
	}

	size(): number {
		return this.entries.size;
	}

	clear(): void {
		this.entries.clear();
	}
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Compute a stable id for a `(kind, payload)` pair:
 *
 *   id = sha256(EvidenceKind || 0x1f || canonicalize(payload))
 *
 * `canonicalize` is a deterministic JSON serialization that:
 *   - sorts object keys lexicographically (so key insertion order does
 *     not change the digest),
 *   - normalizes `Map` to a sorted array of `[key, value]` entries,
 *   - normalizes `Set` to a sorted array of values,
 *   - drops `undefined` object properties and array holes,
 *   - throws on cycles or `BigInt` (deliberately: we cannot represent
 *     them in a stable digest).
 *
 * Two callers that hash the same logical input the same way produce
 * the same id without coordinating; two callers that hand in
 * semantically distinct inputs never collide.
 */
export function evidenceId(kind: EvidenceKind, payload: unknown): string {
	const hash = createHash("sha256");
	hash.update(kind);
	hash.update("\x1f");
	hash.update(canonicalize(payload));
	return hash.digest("hex");
}

/**
 * True when `evidence` is still usable at `now`: either it has no
 * `ttlMs` (never expires) or it was created less than `ttlMs` ago.
 *
 * Defined as a top-level export so callers that maintain their own
 * index (e.g. a per-kind cache) can apply the same rule.
 */
export function isValid(evidence: Evidence, now: number): boolean {
	if (evidence.ttlMs === undefined) return true;
	return now - evidence.createdAt < evidence.ttlMs;
}

/* -------------------------------------------------------------------------- */
/* Canonicalization                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic JSON serialization. Object keys are sorted; `Map` and
 * `Set` are normalized to sorted arrays so two structurally equal
 * inputs always produce the same string.
 */
function canonicalize(value: unknown): string {
	return JSON.stringify(toCanonicalValue(value));
}

/**
 * Recursive structural normalizer. Returns a value that
 * `JSON.stringify` can serialize to a stable string. Throws on values
 * that cannot be represented deterministically (functions, symbols,
 * `BigInt`, non-finite numbers).
 */
function toCanonicalValue(value: unknown): unknown {
	if (value === null) return null;
	if (value === undefined) return undefined;

	const t = typeof value;
	if (t === "string" || t === "boolean") return value;
	if (t === "number") {
		if (!Number.isFinite(value as number)) {
			throw new TypeError("canonicalize: non-finite numbers are not supported");
		}
		return value;
	}
	if (t === "bigint") {
		throw new TypeError("canonicalize: BigInt is not supported");
	}
	if (t === "function" || t === "symbol") {
		throw new TypeError(`canonicalize: ${t} values are not supported`);
	}

	if (Array.isArray(value)) {
		const out: unknown[] = [];
		for (const item of value) {
			const c = toCanonicalValue(item);
			if (c !== undefined) out.push(c);
		}
		return out;
	}

	if (value instanceof Map) {
		// Map → sorted [key, value] pairs so insertion order does not
		// affect the digest. Keys are canonicalized too, so nested maps
		// stay stable.
		const entries: Array<[unknown, unknown]> = [];
		for (const [k, v] of value) {
			entries.push([toCanonicalValue(k), toCanonicalValue(v)]);
		}
		entries.sort(compareCanonicalUnknown);
		return { __kind: "Map", entries };
	}

	if (value instanceof Set) {
		const items: unknown[] = [];
		for (const item of value) items.push(toCanonicalValue(item));
		items.sort(compareCanonicalUnknown);
		return { __kind: "Set", items };
	}

	// Plain object (or class instance treated as data): sort keys.
	if (typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		const keys = Object.keys(obj).sort();
		for (const k of keys) {
			const c = toCanonicalValue(obj[k]);
			if (c !== undefined) sorted[k] = c;
		}
		return sorted;
	}

	return undefined;
}

/**
 * Comparator for canonicalized values. The intermediate string form
 * is the actual order we want; we compare those once per element to
 * avoid quadratic work.
 */
function compareCanonicalUnknown(a: unknown, b: unknown): number {
	const sa = canonicalize(a);
	const sb = canonicalize(b);
	if (sa < sb) return -1;
	if (sa > sb) return 1;
	return 0;
}

