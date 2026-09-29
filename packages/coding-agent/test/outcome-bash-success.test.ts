/**
 * Tests for synthesized bash tool outcome.
 *
 * The bash tool throws on non-zero exit; the agent loop catches the
 * rejection and synthesizes a structured outcome from the resulting error
 * result. The synthesized status must be `failed` and the parsed exit code
 * must flow through.
 *
 * These tests construct error `AgentToolResult` instances directly so they
 * do not depend on the tool implementation import graph (which transitively
 * pulls in the shell renderer chain during the earendil refactor).
 */

import type { AgentToolResult } from "@theta/agent-core";
import { synthesizeOutcome } from "@theta/agent-core";
import { describe, expect, it } from "vitest";

describe("bash tool outcome synthesis", () => {
	it("marks non-zero exit as failed and captures exitStatus from the error text", () => {
		// Mirrors createErrorToolResult output from packages/agent/src/agent-loop.ts:
		// { content: [{ text: error.message }], details: {} }.
		const errorResult: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "some output\n\nCommand exited with code 2" }],
			details: {},
		};
		const outcome = synthesizeOutcome("bash", errorResult, true);

		expect(outcome.status).toBe("failed");
		expect(outcome.exitStatus).toBe(2);
		expect(outcome.parserIdentity).toBe("exact-match");
		expect(outcome.source?.parser).toBe("shell-spawn");
		expect(outcome.confidence).toBeGreaterThanOrEqual(0.5);
	});

	it("marks aborted bash runs as cancelled", () => {
		const errorResult: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "Command aborted" }],
			details: {},
		};
		const outcome = synthesizeOutcome("bash", errorResult, true);

		expect(outcome.status).toBe("cancelled");
	});

	it("marks timed-out bash runs as failed with a timeout warning", () => {
		const errorResult: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "Command timed out after 5 seconds" }],
			details: {},
		};
		const outcome = synthesizeOutcome("bash", errorResult, true);

		expect(outcome.status).toBe("failed");
		expect(outcome.warnings).toContain("timeout");
	});

	it("marks successful untruncated bash runs as succeeded with confidence 1", () => {
		const successResult: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "hello\n" }],
			details: {},
		};
		const outcome = synthesizeOutcome("bash", successResult, false);

		expect(outcome.status).toBe("succeeded");
		expect(outcome.confidence).toBe(1);
		expect(outcome.source?.parser).toBe("shell-spawn");
	});

	it("marks truncated bash runs as incomplete with reduced confidence", () => {
		const truncatedResult: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "...truncated...\n\n[Full output: /tmp/x]" }],
			details: {
				truncation: {
					content: "...truncated...",
					truncated: true,
					truncatedBy: "lines",
					totalLines: 4000,
					totalBytes: 100000,
					outputLines: 2000,
					outputBytes: 50000,
					lastLinePartial: false,
					firstLineExceedsLimit: false,
					maxLines: 2000,
					maxBytes: 50000,
				},
				fullOutputPath: "/tmp/x",
			},
		};
		const outcome = synthesizeOutcome("bash", truncatedResult, false);

		expect(outcome.status).toBe("incomplete");
		expect(outcome.confidence).toBe(0.5);
		expect(outcome.source?.snapshot).toBe("/tmp/x");
	});

	it("treats powershell failures the same way with powershell-spawn parser identity", () => {
		const errorResult: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "PS> Command exited with code 1" }],
			details: {},
		};
		const outcome = synthesizeOutcome("powershell", errorResult, true);

		expect(outcome.status).toBe("failed");
		expect(outcome.exitStatus).toBe(1);
		expect(outcome.source?.parser).toBe("powershell-spawn");
	});
});

