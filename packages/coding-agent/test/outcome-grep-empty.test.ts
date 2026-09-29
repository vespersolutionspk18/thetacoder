/**
 * Tests for synthesized grep tool outcome on empty matches.
 *
 * Grep returning zero matches is still a successful run; the synthesized
 * outcome must be `succeeded` and surface `observations.matches: 0` so the
 * model and downstream tooling can distinguish "no matches" from
 * "search failed".
 *
 * These tests construct AgentToolResult instances directly so they do not
 * depend on the tool implementation import graph (which transitively pulls
 * in the grep renderer chain during the earendil refactor).
 */

import type { AgentToolResult } from "@theta/agent-core";
import { synthesizeOutcome } from "@theta/agent-core";
import { describe, expect, it } from "vitest";

describe("grep tool outcome synthesis (empty matches)", () => {
	it("marks empty matches as succeeded with observations.matches=0", () => {
		const emptyResult: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "" }],
			details: undefined,
		};
		const outcome = synthesizeOutcome("grep", emptyResult, false);

		expect(outcome.status).toBe("succeeded");
		expect(outcome.observations?.matches).toBe(0);
		expect(outcome.parserIdentity).toBe("rg");
		expect(outcome.source?.parser).toBe("rg");
		expect(outcome.confidence).toBeGreaterThanOrEqual(0.5);
	});

	it("counts grep matches when present in content", () => {
		const matchedResult: AgentToolResult<unknown> = {
			content: [
				{
					type: "text",
					text: "src/foo.ts:12:const answer = 42\nsrc/bar.ts:34:const answer = 42",
				},
			],
			details: {},
		};
		const outcome = synthesizeOutcome("grep", matchedResult, false);

		expect(outcome.status).toBe("succeeded");
		expect(outcome.observations?.matches).toBe(2);
	});

	it("marks truncated grep runs as partial with reduced confidence", () => {
		const truncatedResult: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "src/a.ts:1:hit\n[beyond 50KB limit]" }],
			details: {
				matchLimitReached: 100,
				truncation: {
					content: "src/a.ts:1:hit",
					truncated: true,
					truncatedBy: "bytes",
					totalLines: 1,
					totalBytes: 60000,
					outputLines: 1,
					outputBytes: 50000,
					lastLinePartial: false,
					firstLineExceedsLimit: false,
					maxLines: 2000,
					maxBytes: 50000,
				},
			},
		};
		const outcome = synthesizeOutcome("grep", truncatedResult, false);

		expect(outcome.status).toBe("succeeded");
		expect(outcome.observations?.partialResults).toBe(true);
		expect(outcome.observations?.matchLimitReached).toBe(100);
		expect(outcome.confidence).toBe(0.5);
	});

	it("marks error results as failed with zero matches", () => {
		const errorResult: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "rg: fatal error" }],
			details: {},
		};
		const outcome = synthesizeOutcome("grep", errorResult, true);

		expect(outcome.status).toBe("failed");
		expect(outcome.observations?.matches).toBe(0);
	});
});

