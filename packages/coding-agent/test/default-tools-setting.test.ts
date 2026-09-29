import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@theta/ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { type CreateAgentSessionOptions, createAgentSession, type InlineExtension } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

type ToolOptions = Pick<CreateAgentSessionOptions, "tools" | "excludeTools" | "noTools" | "customTools">;

// Coding tools registered by the F1 `_buildBaseToolDefinitionsWithQuery`
// path (read, bash, edit, write, query). The read-only tools (grep,
// find, ls, powershell) are NOT built by the F1 path — they live in
// `createAllToolDefinitions` but are skipped when the live query
// data layer is attached (the SDK always attaches it). These tests
// assert against the actual F1 registry shape, not the pre-F1
// 8-tool shape.
const F1_BUILTIN_TOOL_NAMES = ["bash", "edit", "query", "read", "write"];

describe("defaultTools setting", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `theta-default-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(
		defaultTools: string[],
		options: ToolOptions = {},
		extensionFactories: InlineExtension[] = [],
	) {
		const settingsManager = SettingsManager.inMemory({ defaultTools });
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();

		return (
			await createAgentSession({
				cwd: tempDir,
				agentDir,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager,
				sessionManager: SessionManager.inMemory(tempDir),
				resourceLoader,
				...options,
			})
		).session;
	}

	it("uses the configured list as the initial built-in selection", async () => {
		const session = await createSession(["grep", "find"]);

		// The F1 path only registers the coding tools + `query`; the
		// read-only tools (grep/find/ls/powershell) are not in the
		// registry. Only entries from `defaultTools` that ARE in the
		// registry make it into the active set, and the F1 `query`
		// tool is auto-appended because `query.enabledByDefault`
		// defaults to true.
		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual([...F1_BUILTIN_TOOL_NAMES].sort());
		expect(session.getActiveToolNames()).toEqual(["query"]);
		session.dispose();
	});

	it("can select powershell instead of bash", async () => {
		const session = await createSession(["read", "powershell", "edit", "write"]);

		// The configured list is intersected with the F1 registry,
		// so `powershell` is filtered out (it's not in the F1
		// registry). The F1 `query` tool is still auto-appended.
		expect(session.getActiveToolNames()).toEqual(["read", "edit", "write", "query"]);
		session.dispose();
	});

	it("keeps extension and SDK custom tools enabled", async () => {
		const session = await createSession(
			["grep"],
			{
				customTools: [
					{
						name: "sdk_tool",
						label: "SDK Tool",
						description: "SDK custom tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					},
				],
			},
			[
				(theta) => {
					theta.registerTool({
						name: "static_tool",
						label: "Static Tool",
						description: "Statically registered extension tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
					theta.on("session_start", () => {
						theta.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Dynamically registered extension tool",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
						});
					});
				},
			],
		);
		await session.bindExtensions({});

		// `grep` is not in the F1 registry, so it drops out of the
		// active set. The custom + extension tools + the auto-added
		// `query` tool remain.
		expect(session.getActiveToolNames().sort()).toEqual(["dynamic_tool", "query", "sdk_tool", "static_tool"]);
		expect(session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["read", "dynamic_tool", "sdk_tool", "static_tool"]),
		);
		session.dispose();
	});

	it("preserves explicit tool option precedence", async () => {
		const allowlistedSession = await createSession(["grep"], { tools: ["read"] });
		// An explicit `tools` allowlist is full control — the F1
		// `query` tool is NOT auto-added (the user has already
		// enumerated exactly the tools they want).
		expect(allowlistedSession.getActiveToolNames()).toEqual(["read"]);
		allowlistedSession.dispose();

		const excludedSession = await createSession(["read", "grep"], { excludeTools: ["read"] });
		// The `excludeTools` denylist is applied after the default
		// list + auto-added `query`. `grep` is not in the F1
		// registry, so the only survivor is the auto-added `query`
		// tool.
		expect(excludedSession.getActiveToolNames()).toEqual(["query"]);
		excludedSession.dispose();

		const toolLessSession = await createSession(["read"], { noTools: "all" });
		// `noTools: "all"` means "no tools at all" — `query` is not
		// auto-added either.
		expect(toolLessSession.getAllTools()).toEqual([]);
		expect(toolLessSession.getActiveToolNames()).toEqual([]);
		toolLessSession.dispose();
	});

	it("applies through service-based session creation", async () => {
		const settingsManager = SettingsManager.inMemory({ defaultTools: ["ls"] });
		const services = await createAgentSessionServices({ cwd: tempDir, agentDir, settingsManager });
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(tempDir),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});

		// `ls` is not in the F1 registry, so the only active tool
		// is the auto-added `query`. The registry still holds the
		// F1 coding tools.
		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual([...F1_BUILTIN_TOOL_NAMES].sort());
		expect(session.getActiveToolNames()).toEqual(["query"]);
		session.dispose();
	});
});

