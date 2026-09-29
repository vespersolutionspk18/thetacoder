import { LruContentCache } from "../runtime-hotspots.ts";

/** Cached bytes of a previously-read file plus the content identity derived from them. */
export interface FileContentCacheEntry {
	bytes: Buffer;
	hash: string;
	/**
	 * Disk mtime (ms) observed when the entry was cached. Used by `read`
	 * to verify freshness before serving cached bytes; when absent the
	 * entry is treated as unverifiable and re-read from disk.
	 */
	mtimeMs?: number;
	/** Disk size (bytes) observed when the entry was cached. */
	size?: number;
}

/**
 * Shared LRU cache of recently-read file bytes + their content identity.
 *
 * Owned by the `read` tool: populated lazily on the first disk read of a
 * given absolute path. The next read of the same path skips `ops.readFile`
 * and reuses the buffer; image processing still runs on every call (its
 * output depends on runtime options), and identity is only relevant for
 * text files.
 *
 * Cache keys are the resolved absolute paths used by `read`, `edit`, and
 * `write` (see `resolveToCwd` in `path-utils.ts`). `edit` and `write` MUST
 * call `invalidateFileContentCache` after a successful write so a repeat
 * read never serves bytes from before the mutation.
 *
 * Mutations performed outside the tools (e.g. via `bash` or an external
 * editor) are not invalidated by path. Per the audit's invalidation
 * contract ("verify hashes at query and mutation boundaries"), `read`
 * verifies a cached entry against the disk's mtime/size before serving it
 * (when the read operations provide a `stat`), and re-reads when they
 * disagree. Custom operations without `stat` keep the historical
 * trust-the-cache contract. A stale `contentIdentity` value is still
 * caught by the edit/write optimistic-concurrency prechecks.
 */
const fileContentCache = new LruContentCache<string, FileContentCacheEntry>({ maxEntries: 100 });

export function getFileContentCacheEntry(path: string): FileContentCacheEntry | undefined {
	return fileContentCache.get(path);
}

export function putFileContentCacheEntry(path: string, value: FileContentCacheEntry): void {
	fileContentCache.put(path, value);
}

/** Drop the cached entry for `path` (the same resolved-absolute-path key `read` uses). */
export function invalidateFileContentCache(path: string): void {
	fileContentCache.delete(path);
}

/** Test-only: drop all cached entries so a test starts from a clean cache. */
export function resetFileContentCacheForTests(): void {
	fileContentCache.clear();
}

