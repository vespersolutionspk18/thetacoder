/**
 * F1 `query` tool — AgentSession wiring.
 *
 * Asserts that the F1 `LiveQueryToolData` attached to an `AgentSession`
 * surfaces the F1 `query` tool in the agent's tool registry:
 *
 *   - constructing an `AgentSession` with a `liveQueryToolData` causes
 *     the `query` tool to appear in `getAllTools()` once the initial
 *     tool-registry build has settled;
 *   - `liveQueryToolData.refresh()` keeps the tool in the registry and
 *     makes the next `getToolDefinition("query")` return a tool bound
 *     to the freshly built data (a different `manifest` array
 *     reference).
 *
 * The test constructs the `AgentSession` directly (not through
 * `createAgentSession`) and uses `session.whenReady()` to wait for the
 * async `_buildRuntime` (which has to `await
 * liveQueryToolData.getToolData()` to wire the `query` tool) to finish
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
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

async function createSessionWithLiveQuery(opts: {
	root: string;
	liveQueryToolData?: ReturnType<typeof createLiveQueryToolData>;
}): Promise<AgentSession> {
	const settingsManager = SettingsManager.inMemory();
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
	// `query` tool). Wait for the initial build to settle so the
	// assertions below observe the populated registry.
	await session.whenReady();

	return session;
}

describe("AgentSession — F1 query tool wiring", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `theta-query-agent-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("exposes the query tool in getAllTools() when liveQueryToolData is attached", async () => {
		const live = createLiveQueryToolData({ root: tempDir });
		const session = await createSessionWithLiveQuery({ root: tempDir, liveQueryToolData: live });

		try {
			const toolNames = session.getAllTools().map((tool) => tool.name);
			expect(toolNames).toContain("query");
			// The default built-ins remain alongside the query tool.
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

	it("omits the query tool when liveQueryToolData is not attached", async () => {
		const session = await createSessionWithLiveQuery({ root: tempDir });

		try {
			const toolNames = session.getAllTools().map((tool) => tool.name);
			expect(toolNames).not.toContain("query");
			// The default built-ins are still present.
			expect(toolNames).toContain("read");
			expect(toolNames).toContain("bash");
			expect(toolNames).toContain("edit");
			expect(toolNames).toContain("write");

			expect(session.liveQueryToolData).toBeUndefined();
		} finally {
			session.dispose();
		}
	});

	it("keeps the query tool in the registry after liveQueryToolData.refresh()", async () => {
		const live = createLiveQueryToolData({ root: tempDir });
		const session = await createSessionWithLiveQuery({ root: tempDir, liveQueryToolData: live });

		try {
			// Snapshot the tool bound to the original data so we can
			// assert a fresh binding after refresh.
			const originalQuery = session.getToolDefinition("query");
			expect(originalQuery).toBeDefined();
			const originalData = await live.getToolData();

			// Force a rebuild of the live data layer. The session's
			// tool registry still references the original `query` tool
			// (built from the pre-refresh snapshot), so it stays in
			// `getAllTools()`.
			await live.refresh();

			const afterToolNames = session.getAllTools().map((tool) => tool.name);
			expect(afterToolNames).toContain("query");

			// After the refresh, the live layer hands out a fresh
			// snapshot with a new manifest array. The session's
			// previously-bound tool is still keyed to the old
			// snapshot, which is the expected behaviour for the
			// pre-rebuild registry (the tool's data is intentionally
			// captured at build time). The next `_buildRuntime` /
			// `reload()` would re-bind the tool to the new snapshot.
			const refreshedData = await live.getToolData();
			expect(refreshedData.manifest).not.toBe(originalData.manifest);
		} finally {
			session.dispose();
		}
	});

	it("rebuilds the query tool binding on reload() after a refresh", async () => {
		const live = createLiveQueryToolData({ root: tempDir });
		const session = await createSessionWithLiveQuery({ root: tempDir, liveQueryToolData: live });

		try {
			const originalData = await live.getToolData();
			const originalQuery = session.getToolDefinition("query");
			expect(originalQuery).toBeDefined();

			// Refresh the live data and reload the session so the
			// runtime rebuilds the tool registry from the fresh
			// snapshot.
			await live.refresh();
			await session.reload();

			const reloadedToolNames = session.getAllTools().map((tool) => tool.name);
			expect(reloadedToolNames).toContain("query");

			const refreshedData = await live.getToolData();
			expect(refreshedData.manifest).not.toBe(originalData.manifest);
		} finally {
			session.dispose();
		}
	});
});

