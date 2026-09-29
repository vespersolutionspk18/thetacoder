/**
 * F10 subagent child worker fixture.
 *
 * Stands in for the subagent process in the
 * `subagent-example-shared-evidence` test. The parent
 * (the test itself) writes its evidence into the shared file
 * pointed to by the `THETA_SHARED_EVIDENCE_PATH` env var, then
 * spawns this script. The child:
 *
 *   1. Opens the file with a `FileSharedEvidenceStore` and
 *      verifies the parent's records are there. The observed
 *      counts and the file-content paths land in a sidecar
 *      file `<storePath>.observed` so the test can read them
 *      back without parsing the child's stdout.
 *   2. Publishes its own evidence through a `SharedEvidenceConsumer`
 *      bound to the same file so the parent observes it on
 *      the next `consumeChildEvidence` tick.
 *   3. Exits. The parent then polls the file, sees the new
 *      `child`-sourced records, and resolves.
 *
 * The script never throws on a "missing evidence" check; it
 * records what it saw and lets the test fail with a clear
 * diff if the parent's share step did not land.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SHARED_EVIDENCE_ENV_VAR } from "../../examples/extensions/subagent/evidence-share.ts";
import { createSharedEvidenceConsumer } from "../../src/core/repository/shared-evidence-consumer.ts";
import { FileSharedEvidenceStore } from "../../src/core/repository/shared-evidence-ipc.ts";

interface ObservedFile {
	storePath: string;
	manifestCount: number;
	syntaxIndexCount: number;
	fileContentCount: number;
	fileContentPaths: string[];
	fileContentContentHashes: string[];
	parentSourceSeen: string[];
}

async function writeObservation(sidecarPath: string, observed: ObservedFile): Promise<void> {
	await mkdir(dirname(sidecarPath), { recursive: true });
	await writeFile(sidecarPath, JSON.stringify(observed, null, 2), "utf-8");
}

async function main(): Promise<void> {
	const storePath = process.env[SHARED_EVIDENCE_ENV_VAR];
	if (typeof storePath !== "string" || storePath.length === 0) {
		throw new Error(`Missing env var ${SHARED_EVIDENCE_ENV_VAR}`);
	}

	const store = new FileSharedEvidenceStore({ path: storePath });

	// Capture the parent's records before we publish anything. The
	// test asserts on these counts, so we serialize them to a
	// sidecar rather than relying on stdout (stdout is the JSON
	// event stream consumed by the real subagent wrapper).
	const manifestEntries = store.getByKind("file-manifest");
	const syntaxIndexEntries = store.getByKind("syntax-index");
	const fileContentEntries = store.getByKind("file-content");
	const parentSourceSeen = Array.from(
		new Set([
			...manifestEntries.map((e) => e.source),
			...syntaxIndexEntries.map((e) => e.source),
			...fileContentEntries.map((e) => e.source),
		]),
	);

	const observed: ObservedFile = {
		storePath,
		manifestCount: manifestEntries.length,
		syntaxIndexCount: syntaxIndexEntries.length,
		fileContentCount: fileContentEntries.length,
		fileContentPaths: fileContentEntries.map((e) => (e.payload as { path: string }).path).sort(),
		fileContentContentHashes: fileContentEntries.map((e) => e.contentHash ?? "").sort(),
		parentSourceSeen: parentSourceSeen.sort(),
	};

	// Publish a known marker record so the parent can confirm it
	// sees the child. Two kinds, one for each end of the IPC bridge.
	const consumer = createSharedEvidenceConsumer({ store, source: "child" });
	await consumer.publish("file-content", {
		path: "/child-output/from-subagent-child.ts",
		content: "child wrote this record\n",
		byteLength: 28,
	});
	await consumer.publish("reference-result", {
		query: "from-child",
		results: ["child-result-1", "child-result-2"],
	});
	// Drain pending writes so the parent's poller never races the
	// child's exit.
	await store.flush();

	await writeObservation(`${storePath}.observed`, observed);
}

main()
	.then(() => {
		process.exit(0);
	})
	.catch((err: unknown) => {
		// Surface the failure to the parent on stderr; the test
		// also reads `.observed` so a missing sidecar is itself
		// a signal that the child threw.
		// eslint-disable-next-line no-console
		console.error(err);
		process.exit(1);
	});

