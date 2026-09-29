import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	addConstraint,
	createInitialTaskState,
	getLatestTaskState,
	markHypothesisResolved,
	recordChange,
	recordDecision,
	recordEvidence,
	recordVerification,
	type TaskState,
} from "../src/core/task-state.ts";

describe("TaskState persistence via SessionManager JSONL", () => {
	let tempDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `task-state-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cwd = join(tempDir, "project");
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** Build a non-empty TaskState with deterministic structure for the test. */
	function buildState(id: string): TaskState {
		let s = createInitialTaskState(id);
		s = addConstraint(s, { text: "no any", source: "user" });
		s = addConstraint(s, { text: "keep it pure", source: "model" });
		s = recordDecision(s, { text: "use jsonl", rationale: "append-only" });
		const withHyp: TaskState = {
			...s,
			hypotheses: [...s.hypotheses, { id: "hyp-1", text: "tests will pass", status: "open", madeAt: Date.now() }],
		};
		const resolved = markHypothesisResolved(withHyp, "hyp-1", "confirmed");
		const withVerification = recordVerification(resolved, {
			kind: "test",
			command: "npm test",
			passed: true,
		});
		const withFile = recordChange(withVerification, {
			path: "src/foo.ts",
			contentHash: "sha256:abc",
		});
		const withEvidence = recordEvidence(withFile, {
			kind: "log",
			hash: "sha256:log1",
			byteLength: 256,
		});
		return withEvidence;
	}

	it("persists a TaskState through JSONL and reloads the latest on reopen", () => {
		const session = SessionManager.create(cwd, tempDir);
		const stateId = session.getSessionId();

		// Add a message so the session has an assistant message (which is when
		// the file is first flushed; see _persist).
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		const original = buildState(stateId);
		const entryId = session.appendTaskState(original);
		expect(entryId).toBeTruthy();

		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeTruthy();

		// Verify the entry is present in memory.
		const entries = session.getEntries();
		const taskEntry = entries.find((e) => e.type === "task_state");
		expect(taskEntry).toBeDefined();

		// Snapshot the file path before we drop the manager reference.
		const filePath = sessionFile!;

		// Drop reference and reopen.
		const reopened = SessionManager.open(filePath, tempDir);
		expect(reopened.getSessionId()).toBe(stateId);

		const branch = reopened.getBranch();
		const latest = getLatestTaskState(branch);
		expect(latest).toBeDefined();
		expect(latest).toEqual(original);

		// Top-level invariants must round-trip
		expect(latest!.id).toBe(original.id);
		expect(latest!.constraints).toEqual(original.constraints);
		expect(latest!.decisions).toEqual(original.decisions);
		expect(latest!.hypotheses).toEqual(original.hypotheses);
		expect(latest!.changedFiles).toEqual(original.changedFiles);
		expect(latest!.verifications).toEqual(original.verifications);
		expect(latest!.evidence).toEqual(original.evidence);
	});

	it("returns the most recent task_state when multiple have been appended", () => {
		const session = SessionManager.create(cwd, tempDir);
		const stateId = session.getSessionId();

		// Force flush with an assistant message.
		session.appendMessage({ role: "user", content: "u", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "a" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		const first = createInitialTaskState(stateId);
		const withConstraint = addConstraint(first, { text: "v1", source: "user" });
		session.appendTaskState(withConstraint);

		// A second TaskState snapshot — must be the one returned by getLatest.
		const second = addConstraint(withConstraint, { text: "v2", source: "model" });
		session.appendTaskState(second);

		const filePath = session.getSessionFile();
		expect(filePath).toBeTruthy();

		const reopened = SessionManager.open(filePath!, tempDir);
		const latest = getLatestTaskState(reopened.getBranch());
		expect(latest).toBeDefined();
		expect(latest!.constraints).toHaveLength(2);
		expect(latest!.constraints.map((c) => c.text).sort()).toEqual(["v1", "v2"]);
	});

	it("getLatestTaskState returns undefined when no task_state entries exist", () => {
		const session = SessionManager.create(cwd, tempDir);
		session.appendMessage({ role: "user", content: "u", timestamp: 1 });

		const filePath = session.getSessionFile();
		expect(filePath).toBeTruthy();

		const reopened = SessionManager.open(filePath!, tempDir);
		expect(getLatestTaskState(reopened.getBranch())).toBeUndefined();
	});
});

