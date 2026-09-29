/**
 * F1 `query` tool — default active tool set (disabled).
 *
 * The user can opt out of the F1 `query` tool's auto-activation by
 * setting `query.enabledByDefault: false` in their settings. The
 * tool remains registered in the runtime (so callers can still
 * inspect it via `getAllTools()`) but is NOT added to the default
 * active tool list.
 *
 * This file covers the **disabled** path:
 *   - with `query.enabledByDefault: false` and no `defaultTools`
 *     setting, the active set is the hardcoded default
 *     `[read, bash, edit, write]` without `query`.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@theta/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("F1 query tool — default active tool set (disabled via query.enabledByDefault: false)", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `theta-query-default-active-disabled-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does NOT append the query tool to the default active set when query.enabledByDefault is false", async () => {
		// The user has explicitly disabled the auto-activation of
		// the F1 `query` tool. The live data layer is still attached
		// (the SDK always wires it), so the tool is registered in
		// the runtime — but it must NOT be in the active set.
		const settingsManager = SettingsManager.inMemory({ query: { enabledByDefault: false } });
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
		});

		try {
			const activeNames = session.getActiveToolNames();
			expect(activeNames).not.toContain("query");
			// The hardcoded default built-ins are still active.
			expect(activeNames).toContain("read");
			expect(activeNames).toContain("bash");
			expect(activeNames).toContain("edit");
			expect(activeNames).toContain("write");
		} finally {
			session.dispose();
		}
	});
});

