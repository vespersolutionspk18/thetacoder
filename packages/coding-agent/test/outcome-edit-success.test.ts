/**
 * Tests for synthesized edit tool outcome on success.
 *
 * A successful edit must surface `status: succeeded` and the
 * `parser: exact-match` identity so downstream consumers can reason about
 * the diff-derived content without parsing raw text.
 */

import type { AgentToolResult } from "@theta/agent-core";
import { synthesizeOutcome } from "@theta/agent-core";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";

describe("edit tool outcome synthesis (success)", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `outcome-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("marks successful edits as succeeded with parser=exact-match", async () => {
		const file = join(testDir, "edit-success.txt");
		writeFileSync(file, "Hello, world!\n");

		const edit = createEditTool(testDir);
		const result = await edit.execute("outcome-edit-success-1", {
			path: "edit-success.txt",
			edits: [{ oldText: "world", newText: "team" }],
		});

		expect(result.details).toBeDefined();
		const outcome = synthesizeOutcome("edit", result as AgentToolResult<unknown>, false);

		expect(outcome.status).toBe("succeeded");
		expect(outcome.parserIdentity).toBe("exact-match");
		expect(outcome.source?.parser).toBe("exact-match");
		expect(outcome.confidence).toBe(1);
		expect(outcome.observations?.patch).toBeDefined();
	});
});

