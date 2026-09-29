/**
 * Shared helpers for the LSP adapter test suite.
 *
 * The tests need to:
 *   - Spawn a real `node` child process that speaks LSP over stdio
 *     so the framing layer is exercised end-to-end.
 *   - Drive the `LspClient` against that fake server.
 *   - Tear down the child and the client in a deterministic way.
 *
 * The fake server is a tiny inline script that:
 *   - Reads `Content-Length` framed JSON from stdin.
 *   - Replies to `initialize` with a minimal `ServerCapabilities`.
 *   - Replies to `textDocument/definition` with a fixture location.
 *   - Replies to `textDocument/references` with a fixture list.
 *   - Replies to `textDocument/implementation` with a fixture list.
 *   - Replies to `textDocument/prepareCallHierarchy` and the matching
 *     `incomingCalls` / `outgoingCalls` with fixture items.
 *   - Pushes `textDocument/publishDiagnostics` after a `didOpen`.
 *   - Replies to `shutdown` + `exit` cleanly.
 *
 * Tests start a fresh server per test so they can pick their own
 * fixtures without races.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface LspDefinitionFixture {
	uri: string;
	line: number;
	character: number;
}

export interface LspReferenceFixture extends LspDefinitionFixture {}

export interface LspCallHierarchyFixture {
	item: {
		name: string;
		kind: number;
		uri: string;
		range: { start: { line: number; character: number }; end: { line: number; character: number } };
		selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } };
	};
	fromRanges: Array<{ start: { line: number; character: number }; end: { line: number; character: number } }>;
}

export interface LspImplementationFixture {
	uri: string;
	line: number;
	character: number;
}

export interface LspFixture {
	definition?: LspDefinitionFixture[];
	references?: LspReferenceFixture[];
	implementations?: LspImplementationFixture[];
	incomingCalls?: LspCallHierarchyFixture[];
	outgoingCalls?: LspCallHierarchyFixture[];
	publishDiagnosticsOnOpen?: {
		uri: string;
		items: Array<{
			line: number;
			character: number;
			message: string;
			severity?: number;
			code?: number | string;
			source?: string;
		}>;
	};
}

export interface FakeLspServerHandle {
	process: ChildProcess;
	kill(): void;
	exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/* -------------------------------------------------------------------------- */
/* Server script builder                                                      */
/* -------------------------------------------------------------------------- */

function buildServerScript(fixture: LspFixture): string {
	const fixtureJson = JSON.stringify(fixture);
	// Use a template literal that is *not* interpolated; we want
	// the literal `${` and backslashes to flow through to the
	// generated script. We do this by constructing the script as
	// a list of source lines and joining them — avoids the
	// double-escape gymnastics of a single template string.
	const lines: string[] = [
		`const fixture = ${fixtureJson};`,
		"let buffer = Buffer.alloc(0);",
		"function send(obj) {",
		"  const body = JSON.stringify(obj);",
		"  const header = 'Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\\r\\n\\r\\n';",
		"  process.stdout.write(header);",
		"  process.stdout.write(body);",
		"}",
		"function readFrame() {",
		"  while (true) {",
		"    const idx = buffer.indexOf('\\r\\n\\r\\n');",
		"    if (idx < 0) return;",
		"    const header = buffer.slice(0, idx).toString('ascii');",
		"    const m = /Content-Length:\\s*(\\d+)/i.exec(header);",
		"    if (!m) { buffer = buffer.slice(idx + 4); continue; }",
		"    const len = parseInt(m[1], 10);",
		"    const total = idx + 4 + len;",
		"    if (buffer.length < total) return;",
		"    const body = buffer.slice(idx + 4, total).toString('utf8');",
		"    buffer = buffer.slice(total);",
		"    try { handle(JSON.parse(body)); }",
		"    catch (err) {",
		"      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: String(err) } });",
		"    }",
		"  }",
		"}",
		"function sendResult(id, result) {",
		"  send({ jsonrpc: '2.0', id, result });",
		"}",
		"function sendError(id, code, message) {",
		"  send({ jsonrpc: '2.0', id, error: { code, message } });",
		"}",
		"function handle(msg) {",
		"  if (!msg || typeof msg !== 'object') return;",
		"  if (msg.id !== undefined && msg.method !== undefined) {",
		"    switch (msg.method) {",
		"      case 'initialize':",
		"        sendResult(msg.id, { capabilities: {",
		"          definitionProvider: true,",
		"          referencesProvider: true,",
		"          implementationProvider: true,",
		"          callHierarchyProvider: true,",
		"        } });",
		"        return;",
		"      case 'textDocument/definition': {",
		"        const arr = (fixture.definition ?? []).map((d) => ({",
		"          uri: d.uri,",
		"          range: { start: { line: d.line, character: d.character }, end: { line: d.line, character: d.character + 5 } },",
		"        }));",
		"        sendResult(msg.id, arr[0] ?? null);",
		"        return;",
		"      }",
		"      case 'textDocument/references': {",
		"        const arr = (fixture.references ?? []).map((d) => ({",
		"          uri: d.uri,",
		"          range: { start: { line: d.line, character: d.character }, end: { line: d.line, character: d.character + 3 } },",
		"        }));",
		"        sendResult(msg.id, arr);",
		"        return;",
		"      }",
		"      case 'textDocument/implementation': {",
		"        const arr = (fixture.implementations ?? []).map((d) => ({",
		"          uri: d.uri,",
		"          range: { start: { line: d.line, character: d.character }, end: { line: d.line, character: d.character + 3 } },",
		"        }));",
		"        sendResult(msg.id, arr[0] ?? null);",
		"        return;",
		"      }",
		"      case 'textDocument/prepareCallHierarchy': {",
		"        const arr = (fixture.incomingCalls ?? fixture.outgoingCalls ?? []).map((c) => c.item);",
		"        sendResult(msg.id, arr);",
		"        return;",
		"      }",
		"      case 'callHierarchy/incomingCalls': {",
		"        const arr = (fixture.incomingCalls ?? []).map((c) => ({ from: c.item, fromRanges: c.fromRanges }));",
		"        sendResult(msg.id, arr);",
		"        return;",
		"      }",
		"      case 'callHierarchy/outgoingCalls': {",
		"        const arr = (fixture.outgoingCalls ?? []).map((c) => ({ to: c.item, fromRanges: c.fromRanges }));",
		"        sendResult(msg.id, arr);",
		"        return;",
		"      }",
		"      case 'textDocument/diagnostic': {",
		"        sendError(msg.id, -32601, 'Method not found');",
		"        return;",
		"      }",
		"      case 'shutdown':",
		"        sendResult(msg.id, null);",
		"        return;",
		"      default:",
		"        sendError(msg.id, -32601, 'Method not found: ' + msg.method);",
		"        return;",
		"    }",
		"  }",
		"  if (msg.method !== undefined) {",
		"    if (msg.method === 'initialized') { return; }",
		"    if (msg.method === 'textDocument/didOpen') {",
		"      if (fixture.publishDiagnosticsOnOpen) {",
		"        const { uri, items } = fixture.publishDiagnosticsOnOpen;",
		"        const actualUri = (msg.params && msg.params.textDocument) ? msg.params.textDocument.uri : uri;",
		"        const diagnostics = items.map((i) => ({",
		"          range: { start: { line: i.line, character: i.character }, end: { line: i.line, character: i.character + 1 } },",
		"          severity: i.severity ?? 1,",
		"          code: i.code,",
		"          source: i.source ?? 'fake-lsp',",
		"          message: i.message,",
		"        }));",
		"        send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: actualUri, diagnostics } });",
		"      }",
		"      return;",
		"    }",
		"    if (msg.method === 'exit') { process.exit(0); return; }",
		"  }",
		"}",
		// In a spawned child the stdin stream is paused by default. Resume
		// it so the data event fires. Without this the framing layer is
		// silently broken.
		"process.stdin.resume();",
		"process.stdin.on('data', (chunk) => {",
		"  buffer = Buffer.concat([buffer, chunk]);",
		"  readFrame();",
		"});",
		"process.stdin.on('end', () => process.exit(0));",
	];
	return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Public helpers                                                             */
/* -------------------------------------------------------------------------- */

let tempDir: string | undefined;

/**
 * Spawn a fake LSP server. The returned handle exposes a `kill()`
 * that terminates the child deterministically.
 */
export function startFakeLspServer(fixture: LspFixture): FakeLspServerHandle {
	if (!tempDir) {
		tempDir = mkdtempSync(join(tmpdir(), "lsp-fake-"));
	}
	// Write a unique script per spawn so a test that runs after
	// the previous one with a different fixture does not inherit
	// the older script.
	const scriptPath = join(tempDir, `server-${randomUUID()}.cjs`);
	writeFileSync(scriptPath, buildServerScript(fixture), "utf-8");

	const child = spawn(process.execPath, [scriptPath], {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});

	let resolveExited: (value: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		resolveExited = resolve;
	});
	child.once("exit", (code, signal) => {
		resolveExited({ code, signal });
	});

	return {
		process: child,
		kill: () => {
			try {
				child.kill();
			} catch {
				// ignore
			}
		},
		exited,
	};
}

