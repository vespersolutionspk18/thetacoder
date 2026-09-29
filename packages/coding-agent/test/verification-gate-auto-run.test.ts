/**
 * F16 verification-runner wiring — gate-driven auto-run.
 *
 * When `verification.autoRunChecks` is enabled and the gate verdict is
 * blocked only because a required check lacks current evidence, the
 * session spawns the missing check through the F16 runner
 * (`createLocalBashOperations` + structured parsers), records the
 * snapshot-bound outcome, and re-evaluates the gate. The audit's
 * "automatic checks" safeguard: the runner must stay opt-in; with
 * `autoRunChecks` off (the default) no command may spawn.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@theta/agent-core";
import { getModel, streamSimple } from "@theta/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) {
		cleanup();
	}
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "theta-verify-autorun-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

async function createSession(worktreeRoot: string, options: { autoRunChecks: boolean; policyJson: string }) {
	const settingsManager = SettingsManager.inMemory({
		verification: { enabled: true, autoRunChecks: options.autoRunChecks },
	});
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);

	mkdirSync(join(worktreeRoot, ".theta"), { recursive: true });
	writeFileSync(join(worktreeRoot, ".theta", "verification.json"), options.policyJson);

	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			streamFn: streamSimple,
			initialState: {
				model,
				systemPrompt: "test",
				tools: [],
				thinkingLevel: "high",
			},
		}),
		sessionManager,
		settingsManager,
		cwd: worktreeRoot,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
	});
	cleanups.push(() => session.dispose());
	return { session };
}

function makePassingCheckPolicy(): string {
	return JSON.stringify({
		version: 1,
		concurrency: 1,
		checks: [{ id: "tsc-noEmit", kind: "typecheck", command: "exit 0", parser: "raw" }],
	});
}

describe("F16 gate — auto-run verification checks", () => {
	it("spawns the missing check and unblocks the gate when autoRunChecks is on", async () => {
		const dir = makeTempDir();
		const { session } = await createSession(dir, {
			autoRunChecks: true,
			policyJson: makePassingCheckPolicy(),
		});

		// A TypeScript change produces the file-inferred `tsc-noEmit`
		// requirement, which the policy binds to the `tsc-noEmit` check.
		// No objective text: an objective-derived requirement would be
		// inherently unbound and the honest verdict would stay `unknown`.
		session.recordChange({ path: "src/foo.ts", contentHash: "h1" });

		await (session as unknown as { _evaluateCompletionGate: () => Promise<void> })._evaluateCompletionGate();

		const state = session.getCurrentTaskState();
		expect(state).toBeDefined();
		// The runner produced a snapshot-bound passing verification for
		// the required check, so the re-evaluated verdict is satisfied.
		const verifications = state?.verifications.filter((v) => v.command === "exit 0") ?? [];
		expect(verifications.length).toBe(1);
		expect(verifications[0]?.passed).toBe(true);
		const latest = state?.gateHistory?.[state.gateHistory.length - 1];
		expect(latest?.status).toBe("satisfied");
	});

	it("does not spawn any check when autoRunChecks is off (default)", async () => {
		const dir = makeTempDir();
		const { session } = await createSession(dir, {
			autoRunChecks: false,
			policyJson: makePassingCheckPolicy(),
		});

		session.setObjective("Typecheck must pass.");
		session.recordChange({ path: "src/foo.ts", contentHash: "h1" });

		await (session as unknown as { _evaluateCompletionGate: () => Promise<void> })._evaluateCompletionGate();

		const state = session.getCurrentTaskState();
		const verifications = state?.verifications.filter((v) => v.command === "exit 0") ?? [];
		expect(verifications.length).toBe(0);
		// Without runner-produced evidence the verdict stays blocked
		// (required check, no evidence at all).
		const latest = state?.gateHistory?.[state.gateHistory.length - 1];
		expect(latest?.status).toBe("blocked");
	});

	it("records a failed outcome (not a hang) when the check command fails", async () => {
		const dir = makeTempDir();
		const { session } = await createSession(dir, {
			autoRunChecks: true,
			policyJson: JSON.stringify({
				version: 1,
				concurrency: 1,
				checks: [{ id: "tsc-noEmit", kind: "typecheck", command: "exit 1", parser: "raw" }],
			}),
		});

		session.setObjective("Typecheck must pass.");
		session.recordChange({ path: "src/foo.ts", contentHash: "h1" });

		await (session as unknown as { _evaluateCompletionGate: () => Promise<void> })._evaluateCompletionGate();

		const state = session.getCurrentTaskState();
		const verifications = state?.verifications.filter((v) => v.command === "exit 1") ?? [];
		expect(verifications.length).toBe(1);
		expect(verifications[0]?.passed).toBe(false);
		const latest = state?.gateHistory?.[state.gateHistory.length - 1];
		expect(latest?.status).toBe("blocked");
	});
});

