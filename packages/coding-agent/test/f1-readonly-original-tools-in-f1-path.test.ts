/**
 * F1 build path — original `grep` / `find` / `ls` re-registered when
 * the user opted in via `defaultTools`.
 *
 * The F1 build path normally only registers the coding tools
 * (read, bash, edit, write) + the `query` tool + the F1 read-only
 * trio (`grep-f1`, `find-f1`, `ls-f1`). The filesystem-backed
 * `grep` / `find` / `ls` tools are dropped, which silently swallows
 * a user-supplied `defaultTools: ["grep", "find", "ls"]`.
 *
 * The fix: when the F1 live data layer is attached AND the user's
 * `defaultTools` setting names any of the three, the matching
 * original tool is re-registered into the F1 build path. The F1
 * versions stay available under their `-f1` suffix so the F1 path
 * still works for explicit F1-mode calls.
 *
 * This test asserts the wiring: with `defaultTools: ["grep", "find",
 * "ls"]` and `liveQueryToolData` attached, `getAllTools()` returns
 * both the original tool and the matching `-f1` tool for each
 * entry. The coding tools and the `query` tool remain in the list.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@theta/agent-core";
import { getModel, streamSimple } from "@theta/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createLiveQueryToolData } from "../src/core/repository/query-data.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

async function createSessionWithLiveQuery(opts: {
	root: string;
	liveQueryToolData?: ReturnType<typeof createLiveQueryToolData>;
	settings?: Partial<Settings>;
}): Promise<AgentSession> {
	const settingsManager = SettingsManager.inMemory(opts.settings ?? {});
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			streamFn: streamSimple,
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "high",
			},
		}),
		sessionManager,
		settingsManager,
		cwd: opts.root,
		modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
		resourceLoader: createTestResourceLoader(),
		liveQueryToolData: opts.liveQueryToolData,
	});

	// `_buildRuntime` is async when `liveQueryToolData` is attached
	// (it has to `await liveQueryToolData.getToolData()` to wire the
	// F1 tools). Wait for the initial build to settle so the
	// assertions below observe the populated registry.
	await session.whenReady();

	return session;
}

describe("AgentSession — original grep/find/ls coexist with F1 read-only tools", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(
			tmpdir(),
			`theta-f1-readonly-original-tools-in-f1-path-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("registers the original grep, find, and ls alongside the F1 trio when defaultTools opts in", async () => {
		const live = createLiveQueryToolData({ root: tempDir });
		const session = await createSessionWithLiveQuery({
			root: tempDir,
			liveQueryToolData: live,
			settings: { defaultTools: ["grep", "find", "ls"] },
		});

		try {
			const toolNames = session.getAllTools().map((tool) => tool.name);

			// The original filesystem-backed tools are now in the
			// registry because the user opted in via defaultTools.
			expect(toolNames).toContain("grep");
			expect(toolNames).toContain("find");
			expect(toolNames).toContain("ls");

			// The F1 read-only tools are also still present, so
			// explicit F1-mode calls keep working.
			expect(toolNames).toContain("grep-f1");
			expect(toolNames).toContain("find-f1");
			expect(toolNames).toContain("ls-f1");

			// The rest of the F1 build path is unchanged: coding
			// tools + the F1 `query` tool.
			expect(toolNames).toContain("read");
			expect(toolNames).toContain("bash");
			expect(toolNames).toContain("edit");
			expect(toolNames).toContain("write");
			expect(toolNames).toContain("query");
		} finally {
			session.dispose();
		}
	});

	it("does not register original grep/find/ls when defaultTools omits them", async () => {
		const live = createLiveQueryToolData({ root: tempDir });
		const session = await createSessionWithLiveQuery({
			root: tempDir,
			liveQueryToolData: live,
			// No defaultTools override; the F1 path should leave the
			// original trio out, matching the prior behavior.
		});

		try {
			const toolNames = session.getAllTools().map((tool) => tool.name);
			expect(toolNames).not.toContain("grep");
			expect(toolNames).not.toContain("find");
			expect(toolNames).not.toContain("ls");
			// F1 trio still present.
			expect(toolNames).toContain("grep-f1");
			expect(toolNames).toContain("find-f1");
			expect(toolNames).toContain("ls-f1");
		} finally {
			session.dispose();
		}
	});

	it("registers only the defaultTools entry that was opted in", async () => {
		const live = createLiveQueryToolData({ root: tempDir });
		const session = await createSessionWithLiveQuery({
			root: tempDir,
			liveQueryToolData: live,
			// User opted in to only `grep`. The other two original
			// tools stay out of the registry.
			settings: { defaultTools: ["grep"] },
		});

		try {
			const toolNames = session.getAllTools().map((tool) => tool.name);
			expect(toolNames).toContain("grep");
			expect(toolNames).not.toContain("find");
			expect(toolNames).not.toContain("ls");
			// F1 versions are unaffected.
			expect(toolNames).toContain("grep-f1");
			expect(toolNames).toContain("find-f1");
			expect(toolNames).toContain("ls-f1");
		} finally {
			session.dispose();
		}
	});
});

