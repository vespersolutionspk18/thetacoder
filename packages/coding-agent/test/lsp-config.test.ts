/**
 * F1 LSP backend — auto-detection logic.
 *
 * Verifies the resolution order in `resolveLspServer`:
 *
 *   1. `.theta/lsp.json` override wins when present.
 *   2. Built-in command in `<worktree>/node_modules/.bin`.
 *   3. Built-in command on `PATH`.
 *
 * The tests build a fake worktree, drop a fake `typescript-language-server`
 * script into the local `node_modules/.bin`, and assert the right
 * path is picked. A second test exercises the `.theta/lsp.json`
 * override path.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLspOverrideFile, resolveLspServer, validateOverrideEntry } from "../src/core/repository/lsp-config.ts";

describe("resolveLspServer", () => {
	let worktree: string;

	beforeEach(async () => {
		worktree = await mkdtemp(join(tmpdir(), "lsp-config-test-"));
		await mkdir(join(worktree, "node_modules", ".bin"), { recursive: true });
	});

	afterEach(async () => {
		await rm(worktree, { recursive: true, force: true });
	});

	it("picks the local `node_modules/.bin` command when present", async () => {
		const binDir = join(worktree, "node_modules", ".bin");
		const ext = process.platform === "win32" ? ".cmd" : "";
		const fake = join(binDir, `typescript-language-server${ext}`);
		await writeFile(fake, "#!/bin/sh\n", "utf-8");
		const result = resolveLspServer({ worktree, language: "typescript" });
		expect(result).toBeDefined();
		expect(result?.command).toBe(fake);
		expect(result?.args).toEqual(["--stdio"]);
	});

	it("falls back to PATH when the local bin is missing", async () => {
		// Drop a fake `typescript-language-server` somewhere on
		// PATH (we point the test at a temp dir that holds it).
		const fakeBinDir = await mkdtemp(join(tmpdir(), "lsp-config-fake-bin-"));
		const ext = process.platform === "win32" ? ".cmd" : "";
		const fake = join(fakeBinDir, `typescript-language-server${ext}`);
		await writeFile(fake, "#!/bin/sh\n", "utf-8");
		try {
			const result = resolveLspServer({
				worktree,
				language: "typescript",
				pathEnv: fakeBinDir,
			});
			expect(result?.command).toBe(fake);
		} finally {
			await rm(fakeBinDir, { recursive: true, force: true });
		}
	});

	it("returns undefined when no server is on PATH and no override is present", () => {
		// Empty worktree, empty PATH.
		const result = resolveLspServer({
			worktree,
			language: "typescript",
			pathEnv: "",
		});
		expect(result).toBeUndefined();
	});

	it("wins on a `.theta/lsp.json` override", async () => {
		await mkdir(join(worktree, ".theta"), { recursive: true });
		await writeFile(
			join(worktree, ".theta", "lsp.json"),
			JSON.stringify({
				typescript: {
					command: "/abs/path/to/custom-server",
					args: ["--stdio", "--log", "/tmp/log"],
				},
			}),
			"utf-8",
		);
		const result = resolveLspServer({ worktree, language: "typescript" });
		expect(result?.command).toBe("/abs/path/to/custom-server");
		expect(result?.args).toEqual(["--stdio", "--log", "/tmp/log"]);
	});

	it("ignores a malformed `.theta/lsp.json` entry", async () => {
		await mkdir(join(worktree, ".theta"), { recursive: true });
		await writeFile(join(worktree, ".theta", "lsp.json"), JSON.stringify({ typescript: { command: 42 } }), "utf-8");
		// With no usable command, the resolver falls through to the
		// built-in. There is no `node_modules/.bin` in this test,
		// so it returns `undefined`.
		const result = resolveLspServer({ worktree, language: "typescript" });
		expect(result).toBeUndefined();
	});

	it("falls through to a Python fallback server", async () => {
		const fakeBinDir = await mkdtemp(join(tmpdir(), "lsp-config-py-"));
		const ext = process.platform === "win32" ? ".cmd" : "";
		const pylsp = join(fakeBinDir, `pylsp${ext}`);
		await writeFile(pylsp, "#!/bin/sh\n", "utf-8");
		try {
			const result = resolveLspServer({ worktree, language: "python", pathEnv: fakeBinDir });
			expect(result?.command).toBe(pylsp);
		} finally {
			await rm(fakeBinDir, { recursive: true, force: true });
		}
	});
});

describe("readLspOverrideFile", () => {
	let worktree: string;

	beforeEach(async () => {
		worktree = await mkdtemp(join(tmpdir(), "lsp-override-test-"));
	});

	afterEach(async () => {
		await rm(worktree, { recursive: true, force: true });
	});

	it("returns undefined when the file is missing", () => {
		expect(readLspOverrideFile(worktree)).toBeUndefined();
	});

	it("parses a well-formed file", async () => {
		await mkdir(join(worktree, ".theta"), { recursive: true });
		await writeFile(
			join(worktree, ".theta", "lsp.json"),
			JSON.stringify({ rust: { command: "rust-analyzer", args: [] } }),
			"utf-8",
		);
		const result = readLspOverrideFile(worktree);
		expect(result).toEqual({ rust: { command: "rust-analyzer", args: [] } });
	});

	it("returns undefined for malformed JSON", async () => {
		await mkdir(join(worktree, ".theta"), { recursive: true });
		await writeFile(join(worktree, ".theta", "lsp.json"), "{ not json", "utf-8");
		expect(readLspOverrideFile(worktree)).toBeUndefined();
	});
});

describe("validateOverrideEntry", () => {
	it("accepts a complete entry", () => {
		const result = validateOverrideEntry({
			command: "x",
			args: ["--stdio"],
			initializationOptions: { foo: 1 },
			env: { KEY: "value" },
		});
		expect(result).toEqual({
			command: "x",
			args: ["--stdio"],
			initializationOptions: { foo: 1 },
			env: { KEY: "value" },
		});
	});

	it("rejects non-string command", () => {
		expect(validateOverrideEntry({ command: 42 })).toBeUndefined();
	});

	it("rejects non-array args", () => {
		expect(validateOverrideEntry({ command: "x", args: "not array" })).toBeUndefined();
	});

	it("rejects non-object initializationOptions", () => {
		expect(validateOverrideEntry({ command: "x", initializationOptions: "nope" })).toBeUndefined();
	});

	it("rejects non-string env values", () => {
		expect(validateOverrideEntry({ command: "x", env: { K: 1 } })).toBeUndefined();
	});
});

