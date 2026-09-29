/**
 * Tests for synthesized edit tool outcome on ambiguous matches.
 *
 * When an edit's `oldText` matches more than one region, the tool throws
 * "Found N occurrences...". The synthesized outcome must reflect `failed`
 * status and a confidence strictly below 1 so downstream tooling can tell
 * the model did not actually change any file.
 */

import type { AgentToolResult } from "@theta/agent-core";
import { synthesizeOutcome } from "@theta/agent-core";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";

describe("edit tool outcome synthesis (ambiguous)", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `outcome-edit-amb-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("marks ambiguous edits as failed with reduced confidence", async () => {
		const file = join(testDir, "edit-ambiguous.txt");
		writeFileSync(file, "foo foo foo\n");

		const edit = createEditTool(testDir);

		let thrown: Error | undefined;
		try {
			await edit.execute("outcome-edit-ambiguous-1", {
				path: "edit-ambiguous.txt",
				edits: [{ oldText: "foo", newText: "bar" }],
			});
		} catch (error) {
			thrown = error instanceof Error ? error : new Error(String(error));
		}
		expect(thrown).toBeDefined();
		expect(thrown!.message).toMatch(/Found \d+ occurrences/);

		const errorResult: AgentToolResult<unknown> = {
			content: [{ type: "text", text: thrown!.message }],
			details: {},
		};
		const outcome = synthesizeOutcome("edit", errorResult, true);

		expect(outcome.status).toBe("failed");
		expect(outcome.confidence).toBeLessThan(1);
		expect(outcome.observations?.ambiguousMatch).toBe(true);
	});

	it("marks overlapping multi-edits as failed with reduced confidence", async () => {
		const file = join(testDir, "edit-overlap.txt");
		writeFileSync(file, "alpha\nbeta\nthree\n");

		const edit = createEditTool(testDir);

		let thrown: Error | undefined;
		try {
			await edit.execute("outcome-edit-overlap-1", {
				path: "edit-overlap.txt",
				edits: [
					{ oldText: "alpha\nbeta\n", newText: "ALPHA\nBETA\n" },
					{ oldText: "beta\nthree\n", newText: "BETA\nTHREE\n" },
				],
			});
		} catch (error) {
			thrown = error instanceof Error ? error : new Error(String(error));
		}
		expect(thrown).toBeDefined();

		const errorResult: AgentToolResult<unknown> = {
			content: [{ type: "text", text: thrown!.message }],
			details: {},
		};
		const outcome = synthesizeOutcome("edit", errorResult, true);

		expect(outcome.status).toBe("failed");
		expect(outcome.confidence).toBeLessThan(1);
		expect(outcome.observations?.overlappingEdits).toBe(true);
	});
});

