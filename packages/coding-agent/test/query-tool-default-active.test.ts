/**
 * F1 `query` tool — default active tool set.
 *
 * The F1 `query` tool is a foundational part of the repository-aware
 * experience, so the SDK auto-adds it to the default active tool list
 * when:
 *
 *   1. the live query data layer is attached (always true when
 *      `createAgentSession` is used — the SDK builds the live handle
 *      internally), and
 *   2. the `query.enabledByDefault` setting is `true` (the default).
 *
 * The user can opt out of the auto-activation by setting
 * `query.enabledByDefault: false` in their settings (see
 * `query-tool-default-active-disabled.test.ts`).
 *
 * This file covers the **enabled** path:
 *   - with no `defaultTools` setting, the `query` tool is appended to
 *     the hardcoded default list `[read, bash, edit, write]`.
 *   - with a `defaultTools` setting, the `query` tool is appended to
 *     the configured list.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@theta/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("F1 query tool — default active tool set (enabled)", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `theta-query-default-active-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSessionWithSettings(settings: Record<string, unknown>) {
		const settingsManager = SettingsManager.inMemory(settings);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
		});
		return session;
	}

	it("appends the query tool to the hardcoded default active set when no defaultTools is configured", async () => {
		// `query.enabledByDefault` defaults to true, and the SDK
		// always attaches the live query data layer. So even with no
		// settings at all, the F1 `query` tool is in the active set.
		const session = await createSessionWithSettings({});

		try {
			const activeNames = session.getActiveToolNames();
			expect(activeNames).toContain("query");
			// The hardcoded default built-ins remain alongside query.
			expect(activeNames).toContain("read");
			expect(activeNames).toContain("bash");
			expect(activeNames).toContain("edit");
			expect(activeNames).toContain("write");
		} finally {
			session.dispose();
		}
	});

	it("appends the query tool to a configured defaultTools list when query.enabledByDefault is true", async () => {
		// The user has set `defaultTools` to a non-default list. The
		// F1 `query` tool is still auto-added because
		// `query.enabledByDefault` defaults to true.
		const session = await createSessionWithSettings({ defaultTools: ["read", "edit"] });

		try {
			const activeNames = session.getActiveToolNames();
			expect(activeNames).toContain("query");
			// The configured list is preserved alongside the auto-added query tool.
			expect(activeNames).toContain("read");
			expect(activeNames).toContain("edit");
			// The default built-ins that were NOT in the configured
			// list (bash, write) stay out of the active set.
			expect(activeNames).not.toContain("bash");
			expect(activeNames).not.toContain("write");
		} finally {
			session.dispose();
		}
	});
});

