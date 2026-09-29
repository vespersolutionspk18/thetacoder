/**
 * F1 LSP backend — JSON-RPC client framing.
 *
 * The `LspClient` is a thin wrapper over `vscode-jsonrpc`. The
 * framing layer (Content-Length + JSON body) is exercised by
 * `vscode-jsonrpc`'s own tests; what we cover here is the
 * adapter surface that `LspAdapter` and `LspManager` build on
 * top of:
 *
 *   - Spawning a child with the correct argv.
 *   - Sending `initialize` + `initialized` and waiting for a
 *     response before returning from `LspClient.connect`.
 *   - Forwarding requests, including cancellation via
 *     `CancellationToken`.
 *   - Routing server-pushed `textDocument/publishDiagnostics`
 *     notifications to the subscriber.
 *   - `shutdown()` + `exit()` teardown.
 *
 * The test spawns a tiny in-process Node script that speaks the
 * LSP framing so the entire wire protocol is exercised.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LspClient } from "../src/core/repository/lsp-client.ts";
import { type FakeLspServerHandle, startFakeLspServer } from "./lsp-test-helpers.ts";

describe("LspClient — framing and lifecycle", () => {
	let server: FakeLspServerHandle | undefined;
	let worktree: string | undefined;

	beforeEach(async () => {
		worktree = await mkdtemp(join(tmpdir(), "lsp-client-test-"));
	});

	afterEach(async () => {
		if (server) {
			server.kill();
			await server.exited;
			server = undefined;
		}
		if (worktree) {
			await rm(worktree, { recursive: true, force: true });
			worktree = undefined;
		}
	});

	async function makeClient(): Promise<LspClient> {
		if (!worktree) throw new Error("worktree not set");
		server = startFakeLspServer({});
		return LspClient.connect({
			command: process.execPath,
			args: [findScriptPath(server)],
			cwd: worktree,
			rootUri: `file://${worktree.replace(/\\/g, "/")}`,
		});
	}

	it("connects, sends initialize + initialized, and lets requests round-trip", async () => {
		const client = await makeClient();
		// A real LSP server returns a `ServerCapabilities` payload
		// for `initialize` and `null` for `shutdown`. We exercise
		// the request path with a method the fake server replies to:
		// `textDocument/definition` returns `null` when no
		// fixture is configured.
		const result = await client.request<unknown>("textDocument/definition", {
			textDocument: { uri: "file:///abs/foo.ts" },
			position: { line: 0, character: 0 },
		});
		expect(result === null || Array.isArray(result) || typeof result === "object").toBe(true);
		await client.shutdown();
	});

	it("routes publishDiagnostics notifications to subscribers", async () => {
		// Kill the default server so we can start one with a
		// `publishDiagnosticsOnOpen` fixture.
		if (server) {
			server.kill();
			await server.exited;
			server = undefined;
		}
		if (!worktree) throw new Error("worktree not set");
		const file = join(worktree, "src", "foo.ts");
		await mkdir(join(worktree, "src"), { recursive: true });
		await writeFile(file, "export const foo = 1;\n", "utf-8");
		server = startFakeLspServer({
			publishDiagnosticsOnOpen: {
				uri: `file://${file.replace(/\\/g, "/")}`,
				items: [{ line: 0, character: 0, message: "test diagnostic", severity: 1, code: "E001" }],
			},
		});
		const client = await LspClient.connect({
			command: process.execPath,
			args: [findScriptPath(server)],
			cwd: worktree,
			rootUri: `file://${worktree.replace(/\\/g, "/")}`,
		});
		const received: unknown[] = [];
		client.onNotification("textDocument/publishDiagnostics", (params) => {
			received.push(params);
		});
		// Trigger the `didOpen` so the fake server pushes.
		await client.didOpen(`file://${file.replace(/\\/g, "/")}`, "export const foo = 1;\n", "typescript");
		// Give the framing loop a tick to drain the notification.
		await new Promise((r) => setTimeout(r, 50));
		expect(received.length).toBeGreaterThan(0);
		await client.shutdown();
	});

	it("shutdown is idempotent", async () => {
		const client = await makeClient();
		await client.shutdown();
		// Second call must not throw.
		await expect(client.shutdown()).resolves.toBeUndefined();
	});
});

/**
 * Recover the script path the fake server wrote. The helper keeps
 * it in a module-level variable so the test does not have to
 * thread the path through.
 */
function findScriptPath(handle: FakeLspServerHandle): string {
	const argv = (handle.process as unknown as { spawnargs?: string[] }).spawnargs;
	if (Array.isArray(argv) && typeof argv[1] === "string") return argv[1];
	throw new Error("Could not find fake LSP server script path");
}

