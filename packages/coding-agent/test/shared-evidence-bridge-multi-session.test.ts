/**
 * F10 SharedEvidenceBridge — parent + child cross-session flow.
 *
 * The bridge exists so a parent agent can read what a child has
 * already read. This test exercises the full path:
 *
 *   1. The child AgentSession has a `read` tool that returns a
 *      known result. The session's `afterToolCall` hook publishes
 *      that result to the shared store.
 *   2. The parent AgentSession, bound to the same store, asks its
 *      bridge for cached reads and finds the child's record.
 *
 * Both sessions share a single `InMemorySharedEvidenceStore`; a
 * file-backed store is also exercised at the end to confirm the
 * pattern survives a process boundary.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@theta/agent-core";
import { Agent } from "@theta/agent-core";
import type { AssistantMessageEventStream, Model, SimpleStreamOptions } from "@theta/ai";
import { createAssistantMessageEventStream } from "@theta/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { InMemorySharedEvidenceStore } from "../src/core/repository/shared-evidence.ts";
import { FileSharedEvidenceStore } from "../src/core/repository/shared-evidence-ipc.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSharedEvidenceBridge, type SharedEvidenceBridge } from "../src/core/shared-evidence-bridge.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

/* -------------------------------------------------------------------------- */
/* Faux provider used to satisfy the agent loop without real LLM calls.       */
/* -------------------------------------------------------------------------- */

const FAUX_PROVIDER = "faux";
const FAUX_MODEL_ID = "faux-1";
const FAUX_API = "anthropic-messages" as const;

const fauxModel: Model<typeof FAUX_API> = {
	id: FAUX_MODEL_ID,
	name: "Faux Model",
	api: FAUX_API,
	provider: FAUX_PROVIDER,
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};

/** A no-op stream function: the agent never produces a real LLM call. */
function identityStreamFn(): (
	model: Model<any>,
	context: unknown,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
	return (_model, _context, _options) => {
		const stream = createAssistantMessageEventStream();
		// Push a benign done event so the loop sees a complete response.
		// The agent is never prompted in these tests, so this is purely
		// defensive against accidental tool execution paths.
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					content: [],
					api: FAUX_API,
					provider: FAUX_PROVIDER,
					model: FAUX_MODEL_ID,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			});
		});
		return stream;
	};
}

/* -------------------------------------------------------------------------- */
/* Session factory                                                            */
/* -------------------------------------------------------------------------- */

interface TestSession {
	session: AgentSession;
	tempDir: string;
	dispose: () => void;
}

async function createTestSession(options: {
	store: InMemorySharedEvidenceStore | FileSharedEvidenceStore;
	source: string;
}): Promise<TestSession> {
	const tempDir = join(tmpdir(), `bridge-multi-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const agent = new Agent({
		getApiKey: () => "faux-key",
		initialState: {
			model: fauxModel,
			systemPrompt: "test",
			tools: [],
		},
		streamFn: identityStreamFn(),
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);

	const authStorage = AuthStorage.inMemory({
		[fauxModel.provider]: { type: "api_key", key: "faux-key" },
	});
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	modelRegistry.registerProvider(fauxModel.provider, {
		baseUrl: fauxModel.baseUrl,
		api: fauxModel.api,
		models: [
			{
				id: fauxModel.id,
				name: fauxModel.name,
				api: fauxModel.api,
				reasoning: fauxModel.reasoning,
				input: fauxModel.input,
				cost: fauxModel.cost,
				contextWindow: fauxModel.contextWindow,
				maxTokens: fauxModel.maxTokens,
				baseUrl: fauxModel.baseUrl,
			},
		],
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
		sharedEvidenceStore: options.store,
		sharedEvidenceSource: options.source,
	});

	const dispose = (): void => {
		session.dispose();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	};

	return { session, tempDir, dispose };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("SharedEvidenceBridge — parent + child across one store", () => {
	let child: TestSession | null = null;
	let parent: TestSession | null = null;
	let fileStore: FileSharedEvidenceStore | null = null;
	let fileTemp: { dir: string; cleanup: () => Promise<void> } | null = null;

	afterEach(async () => {
		child?.dispose();
		parent?.dispose();
		child = null;
		parent = null;
		if (fileStore) {
			await fileStore.destroy();
			fileStore = null;
		}
		if (fileTemp) {
			await fileTemp.cleanup();
			fileTemp = null;
		}
	});

	it("child publishes a read; parent consumes it from the shared store", async () => {
		const store = new InMemorySharedEvidenceStore();
		child = await createTestSession({ store, source: "child-session" });
		parent = await createTestSession({ store, source: "parent-session" });

		expect(child.session.sharedEvidenceBridge).toBeDefined();
		expect(parent.session.sharedEvidenceBridge).toBeDefined();

		// The child drives a read. We invoke the agent's
		// `afterToolCall` hook directly because we are not running
		// the agent loop in this test — the goal is to verify the
		// AgentSession wiring, not the full loop.
		const readResult = {
			content: [{ type: "text" as const, text: "export const x = 1;\n" }],
			details: { contentIdentity: "h-1" },
		};
		const toolCall = {
			type: "toolCall" as const,
			id: "tc-1",
			name: "read",
			arguments: { path: "/repo/src/x.ts" },
		};
		const ctx = {
			assistantMessage: {
				role: "assistant" as const,
				content: [],
				api: FAUX_API,
				provider: FAUX_PROVIDER,
				model: FAUX_MODEL_ID,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse" as const,
				timestamp: Date.now(),
			},
			toolCall,
			args: toolCall.arguments,
			result: readResult,
			isError: false,
			context: { systemPrompt: "test", messages: [], tools: [] },
		};

		await child.session.agent.afterToolCall?.(ctx);

		// The parent, on the same store, can now read what the child read.
		const parentBridge: SharedEvidenceBridge = parent.session.sharedEvidenceBridge!;
		const cached = parentBridge.consumeCachedReads((e) => (e.payload as { path: string }).path === "/repo/src/x.ts");

		expect(cached).toHaveLength(1);
		const evidence = cached[0];
		expect(evidence.kind).toBe("file-content");
		expect(evidence.source).toBe("child-session");
		expect(evidence.contentHash).toBe("h-1");
		const payload = evidence.payload as { path: string; content: string; byteLength: number };
		expect(payload.path).toBe("/repo/src/x.ts");
		expect(payload.content).toBe("export const x = 1;\n");
		expect(payload.byteLength).toBe(Buffer.byteLength("export const x = 1;\n", "utf-8"));
	});

	it("child publishing through its own bridge is visible to the parent's bridge on a different handle", async () => {
		// Two bridges on the same in-memory store. This is the
		// "two processes pointing at the same store" scenario
		// without the file layer — it covers the cross-handle
		// publish/consume path.
		const store = new InMemorySharedEvidenceStore();
		const childBridge = createSharedEvidenceBridge({ store, source: "child" });
		const parentBridge = createSharedEvidenceBridge({ store, source: "parent" });

		await childBridge.publishRead("/repo/src/shared.ts", "shared body\n", "hash-shared");

		const matches = parentBridge.consumeCachedReads(
			(e) => (e.payload as { path: string }).path === "/repo/src/shared.ts",
		);
		expect(matches).toHaveLength(1);
		expect(matches[0].source).toBe("child");
	});

	it("parent + child sharing a file-backed store: child publishes, parent reads after reload", async () => {
		const root = await mkdtemp(join(tmpdir(), "bridge-multi-file-"));
		fileTemp = {
			dir: root,
			cleanup: async () => {
				await rm(root, { recursive: true, force: true });
			},
		};
		const storePath = join(root, "evidence.json");
		fileStore = new FileSharedEvidenceStore({ path: storePath });

		const childBridge = createSharedEvidenceBridge({ store: fileStore, source: "child" });
		await childBridge.publishRead("/repo/src/persisted.ts", "persisted body\n", "hash-persisted");
		await fileStore.flush();

		// A separate FileSharedEvidenceStore on the same file is
		// the "parent process" in this scenario: it reads the
		// on-disk file on construction.
		const parentStore = new FileSharedEvidenceStore({ path: storePath });
		try {
			const parentBridge = createSharedEvidenceBridge({ store: parentStore, source: "parent" });
			const matches = parentBridge.consumeCachedReads(
				(e) => (e.payload as { path: string }).path === "/repo/src/persisted.ts",
			);
			expect(matches).toHaveLength(1);
			expect(matches[0].source).toBe("child");
			expect(matches[0].contentHash).toBe("hash-persisted");
		} finally {
			await parentStore.destroy();
		}
	});

	it("child does not publish when the read tool errored", async () => {
		const store = new InMemorySharedEvidenceStore();
		child = await createTestSession({ store, source: "child" });
		parent = await createTestSession({ store, source: "parent" });

		const toolCall = {
			type: "toolCall" as const,
			id: "tc-err",
			name: "read",
			arguments: { path: "/repo/missing.ts" },
		};
		const ctx = {
			assistantMessage: {
				role: "assistant" as const,
				content: [],
				api: FAUX_API,
				provider: FAUX_PROVIDER,
				model: FAUX_MODEL_ID,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse" as const,
				timestamp: Date.now(),
			},
			toolCall,
			args: toolCall.arguments,
			result: {
				content: [{ type: "text" as const, text: "Error: file not found" }],
				details: { contentIdentity: "h-err" },
			},
			isError: true,
			context: { systemPrompt: "test", messages: [], tools: [] },
		};

		await child.session.agent.afterToolCall?.(ctx);

		expect(store.size()).toBe(0);
		const matches = parent.session.sharedEvidenceBridge!.consumeCachedReads(() => true);
		expect(matches).toEqual([]);
	});

	it("child does not publish for non-read tool results", async () => {
		const store = new InMemorySharedEvidenceStore();
		child = await createTestSession({ store, source: "child" });
		parent = await createTestSession({ store, source: "parent" });

		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "echoes",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => ({
				content: [{ type: "text" as const, text: "echoed" }],
				details: { contentIdentity: "h-echo" },
			}),
		};

		const toolCall = {
			type: "toolCall" as const,
			id: "tc-echo",
			name: "echo",
			arguments: { text: "hi" },
		};
		const ctx = {
			assistantMessage: {
				role: "assistant" as const,
				content: [],
				api: FAUX_API,
				provider: FAUX_PROVIDER,
				model: FAUX_MODEL_ID,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse" as const,
				timestamp: Date.now(),
			},
			toolCall,
			args: toolCall.arguments,
			result: {
				content: [{ type: "text" as const, text: "echoed" }],
				details: { contentIdentity: "h-echo" },
			},
			isError: false,
			context: { systemPrompt: "test", messages: [], tools: [] },
		};

		await child.session.agent.afterToolCall?.(ctx);

		expect(store.size()).toBe(0);
		// Reference echoTool to keep the import in the file even
		// if the test ever exercises a different code path.
		expect(echoTool.name).toBe("echo");
	});
});

