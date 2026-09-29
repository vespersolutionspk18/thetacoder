/**
 * F10 shared evidence — SDK startup wiring.
 *
 * `createAgentSession` must construct the session's shared-evidence
 * store from `THETA_SHARED_EVIDENCE_PATH` so a parent process (or the
 * subagent extension) can hand the session a cross-process store
 * without code changes. Sessions started without the env var keep the
 * no-store behavior.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@theta/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir && existsSync(tempDir)) {
		rmSync(tempDir, { recursive: true, force: true });
	}
	tempDir = undefined;
	if (process.env.THETA_SHARED_EVIDENCE_PATH !== undefined) {
		delete process.env.THETA_SHARED_EVIDENCE_PATH;
	}
});

function makeWorkdirs(): { cwd: string; agentDir: string } {
	tempDir = join(tmpdir(), `theta-f10-sdk-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const cwd = join(tempDir, "project");
	const agentDir = join(tempDir, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	return { cwd, agentDir };
}

describe("createAgentSession — THETA_SHARED_EVIDENCE_PATH wiring (F10)", () => {
	it("attaches the shared-evidence bridge when the env var is set", async () => {
		const { cwd, agentDir } = makeWorkdirs();
		process.env.THETA_SHARED_EVIDENCE_PATH = join(tempDir!, "evidence.json");
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			sessionManager: SessionManager.inMemory(cwd),
		});
		expect((session as unknown as { sharedEvidenceBridge?: unknown }).sharedEvidenceBridge).toBeDefined();
		session.dispose();
	});

	it("leaves the bridge undefined without the env var", async () => {
		const { cwd, agentDir } = makeWorkdirs();
		delete process.env.THETA_SHARED_EVIDENCE_PATH;
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			sessionManager: SessionManager.inMemory(cwd),
		});
		expect((session as unknown as { sharedEvidenceBridge?: unknown }).sharedEvidenceBridge).toBeUndefined();
		session.dispose();
	});
});

