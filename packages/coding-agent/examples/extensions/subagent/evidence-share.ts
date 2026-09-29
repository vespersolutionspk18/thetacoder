/**
 * F10 shared-evidence wiring for the subagent extension.
 *
 * The example extension loads as a `.ts` file via jiti; the production
 * binary uses the same jiti path. A relative import to the package's
 * own source keeps the F10 surface usable from the example without
 * requiring a new entry in the package's public `exports` map.
 *
 * The F10 surface itself lives at
 * `packages/coding-agent/src/core/subagent-evidence-share.ts` and
 * `packages/coding-agent/src/core/repository/shared-evidence*.ts`.
 * Those modules are the canonical home; this file is a thin re-export
 * so the extension code does not have to repeat the long relative
 * path at every call site.
 *
 * Environment variable: the parent passes the subagent's evidence
 * file path to the child process as `THETA_SHARED_EVIDENCE_PATH`. The
 * child reads this on startup, opens the same file with a
 * `FileSharedEvidenceStore`, and uses the parent's evidence to
 * short-circuit the work it would otherwise repeat.
 */

import type { Evidence, SharedEvidenceStore } from "../../../src/core/repository/shared-evidence.ts";
import type { SharedEvidenceConsumer } from "../../../src/core/repository/shared-evidence-consumer.ts";
import {
	consumeChildEvidence,
	makeSubagentStorePath,
	shareEvidenceWithSubagent,
} from "../../../src/core/subagent-evidence-share.ts";

/**
 * Environment variable the parent uses to tell the child where the
 * shared evidence file lives. The child picks it up in its startup
 * hook; see `childStorePathFromEnv` below.
 */
export const SHARED_EVIDENCE_ENV_VAR = "THETA_SHARED_EVIDENCE_PATH";

export interface ShareOptions {
	/**
	 * Absolute paths the subagent is expected to read. Used to
	 * filter `file-content` records so the child does not receive
	 * arbitrary files the parent happened to read earlier.
	 */
	taskPaths?: string[];
}

export interface ShareResult {
	manifestCount: number;
	syntaxIndexCount: number;
	fileContentCount: number;
}

export interface ConsumeChildOptions {
	pollIntervalMs?: number;
	timeoutMs?: number;
	/** Filter for evidence whose `source` matches. */
	childSource?: string;
}

export interface ConsumeChildResult {
	consumed: Evidence[];
	timedOut: boolean;
}

export interface SharedEvidenceWire {
	/**
	 * Copy a curated subset of the parent's evidence into the
	 * subagent's backing file. The child reads the file on startup.
	 */
	share(parentStore: SharedEvidenceStore, childStorePath: string, options?: ShareOptions): Promise<ShareResult>;
	/**
	 * Poll the child's evidence file and surface the records it
	 * produced. Returns when the child exits or the configured
	 * timeout elapses.
	 */
	consumeChild(
		parentConsumer: SharedEvidenceConsumer,
		childStorePath: string,
		childPid: number,
		options?: ConsumeChildOptions,
	): Promise<ConsumeChildResult>;
	/**
	 * Read the `THETA_SHARED_EVIDENCE_PATH` env var. Returns the
	 * path when set, `undefined` otherwise. Used by the child side
	 * to discover the parent's file at startup.
	 */
	childStorePathFromEnv(env?: NodeJS.ProcessEnv): string | undefined;
	/**
	 * Create a unique file path for a subagent evidence store inside
	 * the OS temp dir. The file is not created — the store will
	 * create it on first write. The returned `cleanup` removes the
	 * temp dir and is safe to call after the work, even on failure.
	 */
	makeStorePath(prefix: string): Promise<{ path: string; dir: string; cleanup: () => Promise<void> }>;
}

export const sharedEvidence: SharedEvidenceWire = {
	share: shareEvidenceWithSubagent,
	consumeChild: consumeChildEvidence,
	childStorePathFromEnv(env = process.env) {
		const value = env[SHARED_EVIDENCE_ENV_VAR];
		if (typeof value !== "string" || value.length === 0) return undefined;
		return value;
	},
	makeStorePath: makeSubagentStorePath,
};

