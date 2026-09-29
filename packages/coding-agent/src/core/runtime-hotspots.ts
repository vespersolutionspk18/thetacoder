/**
 * F11 runtime hotspots layer.
 *
 * Two bounded improvements behind the F11 audit (Section 8 P3 Finding):
 *   1. An immutable content cache (`ContentCache` / `LruContentCache`) used by
 *      the `read` tool to skip disk reads for recently-touched files.
 *   2. A bounded-concurrency helper (`boundedAll`) used by the `ls` tool to
 *      stat many entries in parallel without unbounded I/O fan-out.
 *
 * Both pieces are deliberately small, dependency-free, and opt-in by the
 * caller. The original code paths remain available as fallbacks.
 */

/* -------------------------------------------------------------------------- */
/* Content cache                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Minimal key/value cache contract.
 *
 * `LruContentCache` is the default production implementation, but tools
 * can swap in a different backing store (e.g. an instrumented test fake)
 * without changing the call sites.
 */
export interface ContentCache<K, V> {
	get(key: K): V | undefined;
	put(key: K, value: V): void;
	delete(key: K): void;
	size(): number;
	clear(): void;
}

export interface LruContentCacheOptions {
	/**
	 * Maximum number of entries to retain before evicting the
	 * least-recently-used one. Must be a positive integer.
	 */
	maxEntries: number;
}

/**
 * Least-recently-used cache backed by a `Map`.
 *
 * Relies on `Map` insertion-order semantics:
 *   - On `get`, a hit promotes the entry by deleting and re-inserting it.
 *   - On `put`, the oldest entry is removed when capacity is exceeded.
 *
 * `get`/`put`/`delete` are O(1). Values are stored by reference — this
 * cache is intended for immutable, byte-stable payloads (e.g. file
 * bytes + a content hash) so reference sharing is safe.
 */
export class LruContentCache<K, V> implements ContentCache<K, V> {
	private readonly maxEntries: number;
	private readonly store: Map<K, V>;

	constructor(options: LruContentCacheOptions) {
		if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) {
			throw new Error(`LruContentCache: maxEntries must be a positive integer, got ${options.maxEntries}`);
		}
		this.maxEntries = options.maxEntries;
		this.store = new Map();
	}

	get(key: K): V | undefined {
		const value = this.store.get(key);
		if (value === undefined) return undefined;
		// Promote to most-recently-used by re-inserting.
		this.store.delete(key);
		this.store.set(key, value);
		return value;
	}

	put(key: K, value: V): void {
		if (this.store.has(key)) {
			// Replace existing entry; promote it to most-recently-used.
			this.store.delete(key);
		} else if (this.store.size >= this.maxEntries) {
			// Evict the oldest (first-inserted) entry.
			const oldest = this.store.keys().next().value;
			if (oldest !== undefined) {
				this.store.delete(oldest);
			}
		}
		this.store.set(key, value);
	}

	delete(key: K): void {
		this.store.delete(key);
	}

	size(): number {
		return this.store.size;
	}

	clear(): void {
		this.store.clear();
	}
}

/* -------------------------------------------------------------------------- */
/* Bounded concurrency                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Run `worker(item)` for each entry in `items`, with at most `limit` calls
 * in flight at any time. Resolves to the array of worker results in the
 * same order as `items`.
 *
 * On error, the returned promise rejects with the first worker error.
 * Workers already in flight are allowed to finish but their results are
 * not observed by the caller; the runner is fail-fast.
 *
 * `limit` must be a positive integer.
 */
export async function boundedAll<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
	if (!Number.isInteger(limit) || limit <= 0) {
		throw new Error(`boundedAll: limit must be a positive integer, got ${limit}`);
	}
	if (items.length === 0) {
		return [];
	}

	const results: R[] = new Array(items.length);
	let nextIndex = 0;
	let inFlight = 0;
	let settled = false;

	return new Promise((resolve, reject) => {
		const launch = (): void => {
			while (!settled && inFlight < limit && nextIndex < items.length) {
				const i = nextIndex++;
				inFlight++;
				Promise.resolve()
					.then(() => worker(items[i]))
					.then(
						(value) => {
							results[i] = value;
							inFlight--;
							if (settled) return;
							if (nextIndex >= items.length && inFlight === 0) {
								settled = true;
								resolve(results);
							} else {
								launch();
							}
						},
						(error) => {
							inFlight--;
							if (!settled) {
								settled = true;
								reject(error);
							}
						},
					);
			}
		};
		launch();
	});
}

