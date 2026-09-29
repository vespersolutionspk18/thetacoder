/**
 * Shared helpers for the file-backed shared-evidence tests.
 *
 * Provides:
 *  - `makeEvidence()` — produce a deterministic `Evidence` for a kind/payload.
 *  - `makeStorePath()` — create a unique temp file path for a test.
 *  - `cleanupStore()` — destroy a store and remove its temp dir.
 *  - `withTempStore()` — convenience that wires both ends together.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Evidence, EvidenceKind } from "../src/core/repository/shared-evidence.ts";
import { evidenceId } from "../src/core/repository/shared-evidence.ts";

/* -------------------------------------------------------------------------- */
/* Evidence factory                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build a deterministic `Evidence` with optional overrides. By
 * default the id is the content-derived `evidenceId(kind, payload)`,
 * the source is `"test"`, and `createdAt` is a stable epoch so
 * `getValidByKind(now)` results are predictable.
 */
export function makeEvidence(
	kind: EvidenceKind,
	payload: unknown,
	createdAt = 1_700_000_000_000,
	id?: string,
): Evidence {
	return {
		id: id ?? evidenceId(kind, payload),
		kind,
		source: "test",
		createdAt,
		payload,
	};
}

/* -------------------------------------------------------------------------- */
/* Temp dir / store lifecycle                                                  */
/* -------------------------------------------------------------------------- */

export interface TempStore {
	/** Absolute path to the backing JSON file. */
	path: string;
	/** Absolute path to the temp dir that contains the file. */
	dir: string;
	/** Remove the temp dir; safe to call after the test, even on failure. */
	cleanup: () => Promise<void>;
}

/**
 * Create a unique temp file path for a file-backed test. The file
 * itself is not created — the store will create it on first write.
 * `cleanup` removes the whole temp dir.
 */
export async function makeStorePath(prefix: string): Promise<TempStore> {
	const dir = await mkdtemp(join(tmpdir(), `fsev-${prefix}-`));
	const path = join(dir, "evidence.json");
	return {
		path,
		dir,
		cleanup: async () => {
			await rm(dir, { recursive: true, force: true });
		},
	};
}

