/**
 * F10 subagent example — end-to-end shared evidence round trip.
 *
 * This test exercises the same wiring the production
 * `examples/extensions/subagent/index.ts` uses, but with a real
 * `node` child process and the example's `evidence-share.ts` as
 * the surface. The child (`test/fixtures/subagent-evidence-child.ts`)
 * is a TS script run through `tsx`; it opens the shared file the
 * parent prepared, verifies the parent's records, publishes its
 * own, and exits.
 *
 * The test exercises:
 *
 *   - `sharedEvidence.makeStorePath` — temp dir + path for the
 *     shared store.
 *   - `sharedEvidence.share` — copy the curated parent subset
 *     into the child-side file.
 *   - The `THETA_SHARED_EVIDENCE_PATH` env var convention.
 *   - `sharedEvidence.consumeChild` — observe the child's
 *     evidence after exit.
 *
 * Together they cover the full parent → child → parent loop the
 * example extension runs every time a subagent is spawned.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SHARED_EVIDENCE_ENV_VAR, sharedEvidence } from "../examples/extensions/subagent/evidence-share.ts";
import { evidenceId, InMemorySharedEvidenceStore } from "../src/core/repository/shared-evidence.ts";
import { createSharedEvidenceConsumer } from "../src/core/repository/shared-evidence-consumer.ts";
import { consumeChildEvidence } from "../src/core/subagent-evidence-share.ts";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(HERE, "../../../..");
const CHILD_SCRIPT = resolve(HERE, "../fixtures/subagent-evidence-child.ts");

/** Absolute path to the `tsx` loader entry, used to launch the
 * child fixture as a TS script. We resolve it from the test
 * process's own `node_modules` so the path always matches the
 * `node` we are about to spawn. */
const TSX_LOADER = join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");

/**
 * `node --import` on Windows refuses bare absolute paths: the
 * loader hook must be a `file://` URL. `pathToFileURL` is the
 * portable conversion.
 */
const TSX_LOADER_URL = pathToFileURL(TSX_LOADER).href;

/**
 * `node:child_process.spawn` cannot launch `.cmd` files without
 * `shell: true` on Windows, and `shell: true` breaks paths that
 * contain spaces. We sidestep both by running the child directly
 * under `process.execPath` (the current `node`) with the `tsx`
 * loader as a `--import` hook.
 */
const SPAWN_OPTS = {} as const;

interface ObservedFile {
	storePath: string;
	manifestCount: number;
	syntaxIndexCount: number;
	fileContentCount: number;
	fileContentPaths: string[];
	fileContentContentHashes: string[];
	parentSourceSeen: string[];
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function waitForExit(child: ReturnType<typeof spawn>): Promise<number> {
	return new Promise<number>((resolveExit, rejectExit) => {
		const local = child;
		if (local.exitCode !== null) {
			resolveExit(local.exitCode ?? 0);
			return;
		}
		local.once("error", rejectExit);
		local.once("exit", (code) => resolveExit(code ?? 0));
	});
}

/* -------------------------------------------------------------------------- */
/* Test isolation                                                             */
/* -------------------------------------------------------------------------- */

describe("subagent example — shared evidence end-to-end", () => {
	let child: ReturnType<typeof spawn> | null = null;
	let childStoreCleanup: (() => Promise<void>) | null = null;
	let childStderr: string = "";

	afterEach(async () => {
		if (child && child.exitCode === null && !child.killed) {
			child.kill();
		}
		child = null;
		childStderr = "";
		if (childStoreCleanup) {
			try {
				await childStoreCleanup();
			} catch {
				/* ignore — best-effort */
			}
			childStoreCleanup = null;
		}
	});

	/* ----------------------------------------------------------------------- */
	/* Core round-trip                                                          */
	/* ----------------------------------------------------------------------- */

	it("parent shares evidence, child reads it, parent observes child's evidence", async () => {
		// 1. Seed the parent store with a realistic mix:
		//    - 2 file-manifest records (always copied)
		//    - 1 syntax-index record (always copied)
		//    - 2 file-content records (only the ones whose path
		//      matches `taskPaths` are copied)
		const parentStore = new InMemorySharedEvidenceStore();

		const wantedPaths = ["/work/seed/a.ts", "/work/seed/b.ts"];
		const unwantedPath = "/work/seed/secret.ts";

		for (let i = 0; i < 2; i++) {
			const payload = { root: `/work/branch-${i}`, files: 10 + i };
			parentStore.put({
				id: evidenceId("file-manifest", payload),
				kind: "file-manifest",
				source: "parent",
				createdAt: 1_700_000_000_000 + i,
				payload,
			});
		}

		const syntaxPayload = { branch: "main", files: 42 };
		parentStore.put({
			id: evidenceId("syntax-index", syntaxPayload),
			kind: "syntax-index",
			source: "parent",
			createdAt: 1_700_000_000_100,
			payload: syntaxPayload,
		});

		for (const path of wantedPaths) {
			const payload = { path, content: `body of ${path}\n`, byteLength: path.length + 7 };
			parentStore.put({
				id: evidenceId("file-content", payload),
				kind: "file-content",
				source: "parent",
				createdAt: 1_700_000_000_200,
				payload,
				contentHash: `h-${path}`,
			});
		}

		// This record should NOT survive the share because its
		// path is not in `taskPaths`.
		const unwantedPayload = { path: unwantedPath, content: "top secret", byteLength: 10 };
		parentStore.put({
			id: evidenceId("file-content", unwantedPayload),
			kind: "file-content",
			source: "parent",
			createdAt: 1_700_000_000_300,
			payload: unwantedPayload,
			contentHash: `h-${unwantedPath}`,
		});

		// 2. Make a temp store path. The example extension uses
		//    the same `sharedEvidence.makeStorePath` helper, so
		//    this exercises the production surface.
		const childStore = await sharedEvidence.makeStorePath("example-test");
		childStoreCleanup = childStore.cleanup;

		// 3. Copy a curated subset of the parent's evidence to
		//    the child-side file. `taskPaths` is the same set the
		//    real extension would pass in for a subagent that
		//    is expected to read `a.ts` and `b.ts`.
		const shareResult = await sharedEvidence.share(parentStore, childStore.path, {
			taskPaths: wantedPaths,
		});
		expect(shareResult.manifestCount).toBe(2);
		expect(shareResult.syntaxIndexCount).toBe(1);
		expect(shareResult.fileContentCount).toBe(wantedPaths.length);

		// 4. Create the parent consumer. `consumeChildEvidence`
		//    borrows a consumer for housekeeping; we give it a
		//    real one bound to the parent store.
		const parentConsumer = createSharedEvidenceConsumer({ store: parentStore, source: "parent" });

		// 5. Spawn the child. We pass the env var the production
		//    extension passes; the child fixture reads it and
		//    opens the file.
		child = spawn(process.execPath, ["--import", TSX_LOADER_URL, CHILD_SCRIPT], {
			...SPAWN_OPTS,
			env: {
				...process.env,
				[SHARED_EVIDENCE_ENV_VAR]: childStore.path,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		const childPid = child.pid;
		expect(childPid).toBeDefined();
		if (childPid === undefined) throw new Error("child did not get a pid");
		child.stderr?.on("data", (chunk: Buffer) => {
			childStderr += chunk.toString();
		});

		// 6. Wait for the child to exit cleanly. `consumeChildEvidence`
		//    would also detect this, but failing fast here makes
		//    the assertion errors easier to read if the child
		//    script itself errors out.
		const exitCode = await waitForExit(child);
		if (exitCode !== 0) {
			throw new Error(`child exited with code ${exitCode}; stderr:\n${childStderr || "(no stderr captured)"}`);
		}

		// 7. Read the sidecar the child wrote. The child records
		//    what it observed about the parent's evidence so the
		//    test can verify the share without parsing stdout.
		const observedRaw = await readFile(`${childStore.path}.observed`, "utf-8");
		const observed = JSON.parse(observedRaw) as ObservedFile;

		expect(observed.manifestCount).toBe(2);
		expect(observed.syntaxIndexCount).toBe(1);
		expect(observed.fileContentCount).toBe(wantedPaths.length);
		expect(observed.fileContentPaths).toEqual([...wantedPaths].sort());
		expect(observed.parentSourceSeen).toEqual(["parent"]);
		// The `unwantedPath` must not be present, even though
		// the parent had a record for it.
		expect(observed.fileContentPaths).not.toContain(unwantedPath);

		// 8. Pull the child's evidence back. We use the same
		//    `consumeChildEvidence` the example extension uses.
		const childEvidence = await consumeChildEvidence(parentConsumer, childStore.path, childPid, {
			childSource: "child",
			pollIntervalMs: 25,
			timeoutMs: 10_000,
		});

		expect(childEvidence.timedOut).toBe(false);
		// Two records: the file-content and the reference-result
		// the child published.
		expect(childEvidence.consumed).toHaveLength(2);
		const kinds = childEvidence.consumed.map((e) => e.kind).sort();
		expect(kinds).toEqual(["file-content", "reference-result"]);
		for (const entry of childEvidence.consumed) {
			expect(entry.source).toBe("child");
		}
	});

	/* ----------------------------------------------------------------------- */
	/* Empty parent store                                                      */
	/* ----------------------------------------------------------------------- */

	it("runs end-to-end when the parent store has only a manifest and no file-content", async () => {
		const parentStore = new InMemorySharedEvidenceStore();
		// Drop one manifest in there so the child has *something*
		// to observe and we can prove the share ran.
		const manifestPayload = { root: "/work/empty-case" };
		parentStore.put({
			id: evidenceId("file-manifest", manifestPayload),
			kind: "file-manifest",
			source: "parent",
			createdAt: 1_700_000_000_000,
			payload: manifestPayload,
		});

		const childStore = await sharedEvidence.makeStorePath("empty-parent");
		childStoreCleanup = childStore.cleanup;

		const shareResult = await sharedEvidence.share(parentStore, childStore.path, { taskPaths: [] });
		expect(shareResult.manifestCount).toBe(1);
		expect(shareResult.fileContentCount).toBe(0);

		const parentConsumer = createSharedEvidenceConsumer({ store: parentStore, source: "parent" });
		child = spawn(process.execPath, ["--import", TSX_LOADER_URL, CHILD_SCRIPT], {
			...SPAWN_OPTS,
			env: { ...process.env, [SHARED_EVIDENCE_ENV_VAR]: childStore.path },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const childPid = child.pid;
		if (childPid === undefined) throw new Error("child did not get a pid");
		child.stderr?.on("data", (chunk: Buffer) => {
			childStderr += chunk.toString();
		});

		const exitCode = await waitForExit(child);
		if (exitCode !== 0) {
			throw new Error(`child exited with code ${exitCode}; stderr:\n${childStderr || "(no stderr captured)"}`);
		}

		const observedRaw = await readFile(`${childStore.path}.observed`, "utf-8");
		const observed = JSON.parse(observedRaw) as ObservedFile;
		expect(observed.manifestCount).toBe(1);
		expect(observed.fileContentCount).toBe(0);
		expect(observed.parentSourceSeen).toEqual(["parent"]);

		const childEvidence = await consumeChildEvidence(parentConsumer, childStore.path, childPid, {
			childSource: "child",
			pollIntervalMs: 25,
			timeoutMs: 10_000,
		});
		expect(childEvidence.timedOut).toBe(false);
		expect(childEvidence.consumed).toHaveLength(2);
	});
});

