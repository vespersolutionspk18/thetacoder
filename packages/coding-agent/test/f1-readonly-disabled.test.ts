/**
 * F1 read-only tools (`grep-f1`, `find-f1`, `ls-f1`) — opt-out path.
 *
 * Asserts that `query.f1ReadOnlyByDefault: false` keeps the three F1
 * read-only tools out of `getAllTools()` even when the F1
 * `LiveQueryToolData` is attached. The `query` tool and the built-in
 * tools remain registered; only the F1 read-only trio is suppressed.
 *
 * This is the user-visible opt-out. The default (omitting the
 * setting, or setting it to `true`) is covered in
 * `f1-readonly-agent-session.test.ts`.
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

describe("AgentSession — F1 read-only tool wiring (opt-out)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `theta-f1-readonly-disabled-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("omits grep-f1, find-f1, ls-f1 from getAllTools() when query.f1ReadOnlyByDefault is false", async () => {
		const live = createLiveQueryToolData({ root: tempDir });
		const session = await createSessionWithLiveQuery({
			root: tempDir,
			liveQueryToolData: live,
			settings: { query: { f1ReadOnlyByDefault: false } },
		});

		try {
			const toolNames = session.getAllTools().map((tool) => tool.name);
			// The three F1 read-only tools are suppressed by the
			// opt-out.
			expect(toolNames).not.toContain("grep-f1");
			expect(toolNames).not.toContain("find-f1");
			expect(toolNames).not.toContain("ls-f1");
			// The `query` tool and the built-in tools are still
			// present — only the F1 read-only trio is gated.
			expect(toolNames).toContain("query");
			expect(toolNames).toContain("read");
			expect(toolNames).toContain("bash");
			expect(toolNames).toContain("edit");
			expect(toolNames).toContain("write");
		} finally {
			session.dispose();
		}
	});
});

