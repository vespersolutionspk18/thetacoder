/**
 * F10 shared evidence — AgentSession consumer.
 *
 * `SharedEvidenceStore` (in-memory or file-backed) is a pure data layer.
 * AgentSession needs a thin wrapper that:
 *
 *   - stamps every record it puts with its own `source` and a
 *     content-derived `id` so the entry is recognizable in the store;
 *   - remembers which evidence it has already seen so a long-lived
 *     session does not re-process the same fact on every poll;
 *   - polls the store on an interval and emits "new evidence" events
 *     to a registered handler.
 *
 * Polling is the right primitive for the file-backed store because the
 * two sides of an IPC boundary cannot share a process-local cache. The
 * consumer is intentionally synchronous on `consume` (a snapshot of the
 * store) and asynchronous on `startPolling` / `stopPolling` (a timer).
 *
 * The consumer does not own the store — it borrows it. A single
 * AgentSession has one consumer; multiple consumers can share the same
 * store when several sessions cooperate on one worktree.
 */

import { type Evidence, type EvidenceKind, evidenceId, isValid, type SharedEvidenceStore } from "./shared-evidence.ts";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Options for a `publish` call. Mirrors the fields of `Evidence` that
 * the consumer is allowed to set on behalf of the caller; `id` and
 * `createdAt` are always derived inside the consumer.
 */
export interface PublishOptions {
	/** Optional expiry in milliseconds from `createdAt`. */
	ttlMs?: number;
	/**
	 * Override the consumer's default `source`. Useful when a single
	 * AgentSession wants to publish under multiple identities (e.g.
	 * "parent" while aggregating, "child" while delegating).
	 */
	source?: string;
}

/**
 * Callback fired when the poller observes a new evidence record.
 * "New" means: not previously seen by this consumer (when
 * `deduplicate` is on) and not emitted by an earlier tick of the same
 * poll cycle.
 */
export type NewEvidenceHandler = (evidence: Evidence) => void;

/**
 * Options accepted by `createSharedEvidenceConsumer`.
 */
export interface SharedEvidenceConsumerOptions {
	/** The store to publish to and read from. */
	store: SharedEvidenceStore;
	/**
	 * Identity of the consumer, recorded as `Evidence.source` on every
	 * record it publishes. Lets a downstream reader tell who produced
	 * each entry.
	 */
	source: string;
	/**
	 * When true (the default), the consumer tracks the ids it has
	 * already emitted and will not re-emit them on subsequent polls.
	 * Disable to deliver every observed record every tick (useful for
	 * a one-shot sweep).
	 */
	deduplicate?: boolean;
	/**
	 * Optional handler invoked synchronously from the polling tick for
	 * every newly observed evidence record. Equivalent to subscribing
	 * via the `onNew` method on the returned consumer.
	 */
	onNew?: NewEvidenceHandler;
}

/**
 * Public surface of the consumer. `publish` and `consume` are
 * straightforward wrappers around the store; `startPolling` /
 * `stopPolling` are the IPC-friendly way to discover evidence other
 * processes have written.
 */
export interface SharedEvidenceConsumer {
	/**
	 * Insert an evidence record. The `id` and `createdAt` fields are
	 * filled in by the consumer; `source` falls back to the
	 * consumer's configured `source` if `options.source` is omitted.
	 * The newly published record is returned so the caller can store
	 * its id for later comparison.
	 */
	publish(kind: EvidenceKind, payload: unknown, options?: PublishOptions): Promise<Evidence>;

	/**
	 * Return every evidence record currently in the store that
	 * matches `predicate`. Expiry is respected: records whose
	 * `ttlMs` has elapsed are filtered out.
	 */
	consume(predicate: (evidence: Evidence) => boolean): Evidence[];

	/**
	 * Begin polling the store every `intervalMs`. Every newly
	 * observed evidence record is delivered to the handlers
	 * registered via `onNew`. Returns a function that stops polling
	 * — convenient for `using`-style teardown.
	 */
	startPolling(intervalMs: number): () => void;

	/** Stop the active polling interval, if any. Idempotent. */
	stopPolling(): void;
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Create a consumer bound to a store.
 *
 * The consumer does not take ownership of the store: the caller is
 * responsible for closing / destroying it when the surrounding session
 * shuts down.
 */
export function createSharedEvidenceConsumer(options: SharedEvidenceConsumerOptions): SharedEvidenceConsumer {
	const store = options.store;
	const defaultSource = options.source;
	const deduplicate = options.deduplicate ?? true;
	const seen: Set<string> = new Set();
	const handlers: Set<NewEvidenceHandler> = new Set();
	let interval: ReturnType<typeof setInterval> | null = null;

	if (options.onNew) handlers.add(options.onNew);

	/**
	 * One polling tick. Walks every entry the store currently holds,
	 * drops the ones the consumer has already seen (when dedup is on)
	 * or has already emitted this tick, and fires `onNew` for the
	 * rest. Expiry is applied so an entry that just rolled past its
	 * `ttlMs` is not emitted.
	 */
	function tick(): void {
		const stamp = Date.now();
		for (const evidence of allEvidence(store)) {
			if (deduplicate && seen.has(evidence.id)) continue;
			if (!isValid(evidence, stamp)) {
				// Remember expired ids so a future tick does not
				// bother re-evaluating them when deduplication is on.
				if (deduplicate) seen.add(evidence.id);
				continue;
			}
			if (deduplicate) seen.add(evidence.id);
			for (const handler of handlers) {
				try {
					handler(evidence);
				} catch {
					// Handler failures must not break the polling
					// loop or skip later evidence. The consumer
					// is a fire-and-forget broadcaster; it has
					// no opinion on what handlers do with the
					// record.
				}
			}
		}
	}

	return {
		async publish(kind, payload, options) {
			const evidence: Evidence = {
				id: evidenceId(kind, payload),
				kind,
				source: options?.source ?? defaultSource,
				createdAt: Date.now(),
				...(options?.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
				payload,
			};
			store.put(evidence);
			return evidence;
		},

		consume(predicate) {
			const stamp = Date.now();
			const out: Evidence[] = [];
			for (const evidence of allEvidence(store)) {
				if (!isValid(evidence, stamp)) continue;
				if (predicate(evidence)) out.push(evidence);
			}
			return out;
		},

		startPolling(intervalMs) {
			// Restart cleanly: an existing interval is replaced.
			// This makes it cheap to call `startPolling` from a
			// config reload without leaking the previous timer.
			if (interval !== null) clearInterval(interval);
			// First tick is delayed by one interval so a consumer
			// that publishes at startup is not surprised by an
			// immediate echo of its own evidence (the seen-set
			// also covers that case, but the delay keeps the
			// timing predictable for tests).
			interval = setInterval(tick, intervalMs);
			const stop = (): void => {
				if (interval !== null) {
					clearInterval(interval);
					interval = null;
				}
			};
			return stop;
		},

		stopPolling() {
			if (interval !== null) {
				clearInterval(interval);
				interval = null;
			}
		},
	};
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Materialize every evidence record in the store as a snapshot array.
 * `SharedEvidenceStore` does not expose an `entries()` method, so we
 * walk the kinds and collect. The duplication is bounded by the
 * number of distinct `EvidenceKind` values, which is small and closed
 * (see `shared-evidence.ts`).
 */
function allEvidence(store: SharedEvidenceStore): Evidence[] {
	const kinds: EvidenceKind[] = [
		"file-manifest",
		"syntax-index",
		"reference-result",
		"file-content",
		"compilation-result",
	];
	const out: Evidence[] = [];
	for (const kind of kinds) {
		for (const entry of store.getByKind(kind)) {
			out.push(entry);
		}
	}
	return out;
}

