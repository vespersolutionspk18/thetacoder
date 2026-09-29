/**
 * F1 read-only tools (`grep-f1`, `find-f1`, `ls-f1`) — AgentSession wiring.
 *
 * Asserts that the F1 read-only tools are registered into the agent's
 * tool registry by default when the F1 `LiveQueryToolData` is attached
 * to an `AgentSession`:
 *
 *   - constructing an `AgentSession` with a `liveQueryToolData` causes
 *     the three F1 read-only tools to appear in `getAllTools()` once
 *     the initial tool-registry build has settled;
 *   - `liveQueryToolData.refresh()` keeps the three F1 read-only tools
 *     in the registry;
 *   - `session.reload()` keeps the three F1 read-only tools in the
 *     registry.
 *
 * The F1 read-only tools share the same manifest + symbol index that
 * the `query` tool is bound to, so they are cheap to enable whenever
 * the live data layer is available. The opt-out path is covered in
 * `f1-readonly-disabled.test.ts`.
 *
 * The test constructs the `AgentSession` directly (not through
 * `createAgentSession`) and uses `session.whenReady()` to wait for the
 * async `_buildRuntime` (which has to `await
 * liveQueryToolData.getToolData()` to wire the F1 tools) to finish
 * before reading the tool list.
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

describe("AgentSession — F1 read-only tool wiring (default: enabled)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `theta-f1-readonly-agent-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("exposes grep-f1, find-f1, ls-f1 in getAllTools() when liveQueryToolData is attached", async () => {
		const live = createLiveQueryToolData({ root: tempDir });
		const session = await createSessionWithLiveQuery({ root: tempDir, liveQueryToolData: live });

		try {
			const toolNames = session.getAllTools().map((tool) => tool.name);
			// The three F1 read-only tools are registered by default.
			expect(toolNames).toContain("grep-f1");
			expect(toolNames).toContain("find-f1");
			expect(toolNames).toContain("ls-f1");
			// The `query` tool and the built-ins are still present
			// alongside the F1 read-only tools.
			expect(toolNames).toContain("query");
			expect(toolNames).toContain("read");
			expect(toolNames).toContain("bash");
			expect(toolNames).toContain("edit");
			expect(toolNames).toContain("write");

			// The session exposes the live data handle so callers can
			// trigger refreshes or inspect the data layer.
			expect(session.liveQueryToolData).toBe(live);
		} finally {
			session.dispose();
		}
	});

	it("keeps the F1 read-only tools in the registry after liveQueryToolData.refresh()", async () => {
		const live = createLiveQueryToolData({ root: tempDir });
		const session = await createSessionWithLiveQuery({ root: tempDir, liveQueryToolData: live });

		try {
			// Snapshot the F1 read-only tools bound to the original
			// data so we can assert they remain registered after
			// the live layer refreshes.
			const originalGrepF1 = session.getToolDefinition("grep-f1");
			const originalFindF1 = session.getToolDefinition("find-f1");
			const originalLsF1 = session.getToolDefinition("ls-f1");
			expect(originalGrepF1).toBeDefined();
			expect(originalFindF1).toBeDefined();
			expect(originalLsF1).toBeDefined();

			// Force a rebuild of the live data layer. The session's
			// tool registry still references the original F1 tools
			// (built from the pre-refresh snapshot), so they stay
			// in `getAllTools()`.
			await live.refresh();

			const afterToolNames = session.getAllTools().map((tool) => tool.name);
			expect(afterToolNames).toContain("grep-f1");
			expect(afterToolNames).toContain("find-f1");
			expect(afterToolNames).toContain("ls-f1");
		} finally {
			session.dispose();
		}
	});

	it("keeps the F1 read-only tools in the registry after session.reload()", async () => {
		const live = createLiveQueryToolData({ root: tempDir });
		const session = await createSessionWithLiveQuery({ root: tempDir, liveQueryToolData: live });

		try {
			// Reload the session so the runtime rebuilds the tool
			// registry from a fresh live snapshot. The F1 read-only
			// tools should be re-registered from the new snapshot.
			await live.refresh();
			await session.reload();

			const reloadedToolNames = session.getAllTools().map((tool) => tool.name);
			expect(reloadedToolNames).toContain("grep-f1");
			expect(reloadedToolNames).toContain("find-f1");
			expect(reloadedToolNames).toContain("ls-f1");
			// `query` is also re-registered from the fresh snapshot.
			expect(reloadedToolNames).toContain("query");
		} finally {
			session.dispose();
		}
	});
});

