/**
 * F1 `query` tool — freshness after a worktree mutation.
 *
 * Proves the hard success criterion: after a file in the worktree is
 * created / modified / removed, a subsequent `query` tool call MUST
 * reflect that change — without a full session `reload()`.
 *
 * Three mechanisms are covered, matching the SDK wiring:
 *
 *   1. **Live data source (query tool step).** The `query` tool built
 *      from a `LiveQueryToolData` accessor (`getData: () =>
 *      live.getToolData()`) resolves a fresh snapshot at the start of
 *      every call. After a mutation + `live.refresh()`, the next query
 *      sees the new file and its symbols.
 *
 *   2. **Watcher-driven live index (SDK step).** A file watcher (here a
 *      fake one the test drives) keeps the live syntax index in sync;
 *      a cached `getToolData()` within the TTL window re-snapshots it.
 *      Rebuilds (`refresh()`) do NOT stop the shared watcher;
 *      `dispose()` stops it.
 *
 *   3. **Session mutation bridge (afterToolCall step, no watcher).**
 *      An `AgentSession` with a live data layer refreshes it in its
 *      `afterToolCall` hook after a successful `write` tool call; the
 *      registered `query` tool then serves the fresh snapshot on the
 *      next call — no reload required.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@theta/agent-core";
import type { AssistantMessage, ToolCall, Usage } from "@theta/ai";
import { getModel, streamSimple } from "@theta/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createLiveQueryToolData } from "../src/core/repository/query-data.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createQueryTool } from "../src/core/tools/query.ts";
import { makeFakeWatcher, makeTempDir, removeTempDir, touchFile } from "./live-manifest-helpers.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const EFFECTIVELY_NEVER = 24 * 60 * 60 * 1000;

const zeroUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Extract the `path` field of every result item from a query tool result. */
function filePaths(result: { details?: unknown }): string[] {
	const details = result.details as { output?: { results?: Array<{ path?: unknown }> } } | undefined;
	const results = details?.output?.results;
	if (!results) return [];
	return results.map((r) => r.path).filter((p): p is string => typeof p === "string");
}

/** Extract the `name` field of every symbol result from a query tool result. */
function symbolNames(result: { details?: unknown }): string[] {
	const details = result.details as { output?: { results?: Array<{ name?: unknown }> } } | undefined;
	const results = details?.output?.results;
	if (!results) return [];
	return results.map((r) => r.name).filter((n): n is string => typeof n === "string");
}

describe("query tool — live data source (mutation → refresh → fresh query)", () => {
	let root: string;

	beforeEach(async () => {
		root = await makeTempDir("query-freshness");
		await touchFile(root, "a.ts", "export const alpha = 1;");
	});

	afterEach(async () => {
		await removeTempDir(root);
	});

	it("find-files sees files created after the initial build once the layer is refreshed", async () => {
		const live = createLiveQueryToolData({
			root,
			maxAgeMs: EFFECTIVELY_NEVER,
			semanticBackend: "mock",
		});
		try {
			const tool = createQueryTool({ getData: () => live.getToolData() });

			const before = await tool.execute("call-1", { intent: "find-files", query: "**/*" });
			expect(filePaths(before)).toContain("a.ts");
			expect(filePaths(before)).not.toContain("b.ts");

			// Mutate the worktree (as an edit/write tool would). The
			// session's afterToolCall path forces a refresh here.
			await touchFile(root, "b.ts", "export const beta = 2;");
			await live.refresh();

			// Same tool instance, no reload: the next query is fresh.
			const after = await tool.execute("call-2", { intent: "find-files", query: "**/*" });
			expect(filePaths(after)).toContain("a.ts");
			expect(filePaths(after)).toContain("b.ts");
		} finally {
			await live.dispose();
		}
	});

	it("find-symbol sees symbols from files created after the initial build", async () => {
		const live = createLiveQueryToolData({
			root,
			maxAgeMs: EFFECTIVELY_NEVER,
			semanticBackend: "mock",
		});
		try {
			const tool = createQueryTool({ getData: () => live.getToolData() });

			const before = await tool.execute("call-1", { intent: "find-symbol", query: "beta" });
			expect(symbolNames(before)).not.toContain("beta");

			// Mutate + refresh, as the session bridge does.
			await touchFile(root, "b.ts", "export const beta = 2;");
			await live.refresh();

			const after = await tool.execute("call-2", { intent: "find-symbol", query: "beta" });
			expect(symbolNames(after)).toContain("beta");
		} finally {
			await live.dispose();
		}
	});

	it("reflects a file deletion after a refresh", async () => {
		const live = createLiveQueryToolData({
			root,
			maxAgeMs: EFFECTIVELY_NEVER,
			semanticBackend: "mock",
		});
		try {
			await touchFile(root, "doomed.ts", "export const doomed = 1;");
			const tool = createQueryTool({ getData: () => live.getToolData() });

			const before = await tool.execute("call-1", { intent: "find-files", query: "**/*" });
			expect(filePaths(before)).toContain("doomed.ts");

			await rm(join(root, "doomed.ts"), { force: true });
			await live.refresh();

			const after = await tool.execute("call-2", { intent: "find-files", query: "**/*" });
			expect(filePaths(after)).not.toContain("doomed.ts");
		} finally {
			await live.dispose();
		}
	});
});

describe("live query data — watcher keeps the symbol index fresh", () => {
	let root: string;
	let fake: ReturnType<typeof makeFakeWatcher>;

	beforeEach(async () => {
		root = await makeTempDir("query-freshness-watcher");
		await touchFile(root, "a.ts", "export const alpha = 1;");
		fake = makeFakeWatcher();
	});

	afterEach(async () => {
		await removeTempDir(root);
	});

	it("re-snapshots the live symbol index on a cached getToolData() after a watcher event", async () => {
		const live = createLiveQueryToolData({
			root,
			watcher: fake.watcher,
			maxAgeMs: EFFECTIVELY_NEVER,
			semanticBackend: "mock",
		});
		try {
			const first = await live.getToolData();
			expect(first.liveSyntaxIndex).toBeDefined();
			// The data layer owns the watcher: it starts it exactly once.
			expect(fake.startCalls).toBe(1);

			const firstNames = first.symbolIndex.map((s) => s.name);
			expect(firstNames).toContain("alpha");
			expect(firstNames).not.toContain("zeta");

			// External mutation (not via a tool): the watcher event
			// updates the live index.
			await touchFile(root, "new.ts", "export const zeta = 1;");
			await fake.fire({ kind: "create", path: "new.ts", timestamp: Date.now() });

			// Cached path (within the TTL): the symbol index must
			// reflect the watcher event even without a rebuild.
			const cached = await live.getToolData();
			const cachedNames = cached.symbolIndex.map((s) => s.name);
			expect(cachedNames).toContain("alpha");
			expect(cachedNames).toContain("zeta");
		} finally {
			await live.dispose();
		}
	});

	it("keeps the shared watcher running across refresh() and stops it on dispose()", async () => {
		const live = createLiveQueryToolData({
			root,
			watcher: fake.watcher,
			maxAgeMs: EFFECTIVELY_NEVER,
			semanticBackend: "mock",
		});
		try {
			await live.getToolData();
			expect(fake.stopCalls).toBe(0);

			// A rebuild must NOT stop the shared watcher...
			await live.refresh();
			expect(fake.stopCalls).toBe(0);

			// ...so later watcher events still update the new live index.
			await touchFile(root, "late.ts", "export const omega = 1;");
			await fake.fire({ kind: "create", path: "late.ts", timestamp: Date.now() });
			const after = await live.getToolData();
			const names = after.symbolIndex.map((s) => s.name);
			expect(names).toContain("omega");

			// dispose() stops the watcher.
			await live.dispose();
			expect(fake.stopCalls).toBe(1);
		} finally {
			await live.dispose();
		}
	});
});

describe("AgentSession — query tool freshness after a write mutation", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `theta-query-freshness-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("refreshes the live data layer after a successful write so the next query is fresh (no reload, no watcher)", async () => {
		writeFileSync(join(tempDir, "a.ts"), "export const alpha = 1;", "utf-8");

		const settingsManager = SettingsManager.inMemory();
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			streamFn: streamSimple,
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "high",
			},
		});
		// No watcher on purpose: this test proves the mutation →
		// refresh bridge (step 3) makes the next query fresh without
		// relying on the watcher. `maxAgeMs: EFFECTIVELY_NEVER` means
		// only `refresh()` can invalidate the cached snapshot.
		const live = createLiveQueryToolData({
			root: tempDir,
			maxAgeMs: EFFECTIVELY_NEVER,
			semanticBackend: "mock",
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
			resourceLoader: createTestResourceLoader(),
			liveQueryToolData: live,
		});
		try {
			await session.whenReady();

			// The SDK path auto-activates `query` when
			// `query.enabledByDefault` is set; do it explicitly here.
			session.setActiveToolsByName(["read", "bash", "edit", "write", "query"]);

			const queryTool = session.agent.state.tools.find((t) => t.name === "query");
			expect(queryTool).toBeDefined();
			expect(agent.afterToolCall).toBeDefined();

			// First query: only a.ts is visible.
			const before = await queryTool!.execute("q1", { intent: "find-files", query: "**/*" });
			expect(filePaths(before)).toContain("a.ts");
			expect(filePaths(before)).not.toContain("b.ts");

			// Mutate the worktree (as a `write` tool call would).
			writeFileSync(join(tempDir, "b.ts"), "export const beta = 2;", "utf-8");

			// Drive the session's afterToolCall hook for a successful
			// `write` tool call — the bridge under test.
			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "b.ts" } }],
				usage: zeroUsage,
				stopReason: "stop",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				timestamp: Date.now(),
			};
			const toolCall = assistantMessage.content[0] as ToolCall;
			await agent.afterToolCall!({
				assistantMessage,
				toolCall,
				args: { path: "b.ts", content: "export const beta = 2;" },
				result: { content: [{ type: "text", text: "ok" }], details: { contentIdentity: "hash-1" } },
				isError: false,
				context: { systemPrompt: "You are a helpful assistant.", messages: [] },
			});

			// Second query: same tool instance, NO reload — must see
			// the new file (manifest) and its symbol (syntax index).
			const after = await queryTool!.execute("q2", { intent: "find-files", query: "**/*" });
			expect(filePaths(after)).toContain("a.ts");
			expect(filePaths(after)).toContain("b.ts");

			const symbols = await queryTool!.execute("q3", { intent: "find-symbol", query: "beta" });
			expect(symbolNames(symbols)).toContain("beta");
		} finally {
			await live.dispose();
			session.dispose();
		}
	});
});

