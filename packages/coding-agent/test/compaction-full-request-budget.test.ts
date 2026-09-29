/**
 * F3 — full-request compaction budgeting.
 *
 * The audit (Section 10, "Budget gap") calls out that message-only
 * estimates are not a preflight of the final serialized request: the
 * system prompt and tool schemas ride along on every request and
 * consume real context window. `estimateRequestPrefixTokens` closes
 * that gap; the compaction check adds it only on the estimate-only
 * path (usage-backed estimates already include the prefix because the
 * provider counted the real request).
 */
import { describe, expect, it } from "vitest";
import { estimateRequestPrefixTokens } from "../src/core/compaction/utils.ts";

describe("estimateRequestPrefixTokens", () => {
	it("returns 0 for an empty request prefix", () => {
		expect(estimateRequestPrefixTokens({})).toBe(0);
		expect(estimateRequestPrefixTokens({ systemPrompt: "", tools: [] })).toBe(0);
	});

	it("estimates the system prompt with the chars/4 heuristic", () => {
		// 400 chars → 100 tokens exactly.
		expect(estimateRequestPrefixTokens({ systemPrompt: "a".repeat(400) })).toBe(100);
	});

	it("estimates serialized tool schemas", () => {
		const tools = [
			{ name: "read", description: "Read a file" },
			{ name: "edit", description: "Edit a file" },
		];
		const expected = Math.ceil(JSON.stringify(tools).length / 4);
		expect(estimateRequestPrefixTokens({ tools })).toBe(expected);
	});

	it("combines system prompt and tool schemas", () => {
		const systemPrompt = "s".repeat(200);
		const tools = [{ name: "bash", description: "Run a command" }];
		const expected = Math.ceil((systemPrompt.length + JSON.stringify(tools).length) / 4);
		expect(estimateRequestPrefixTokens({ systemPrompt, tools })).toBe(expected);
	});

	it("does not throw on unserializable tool shapes", () => {
		const cyclic: Record<string, unknown> = { name: "bad" };
		cyclic.self = cyclic;
		// JSON.stringify throws on cycles; the estimator must skip the
		// tools and fall back to the system-prompt-only estimate.
		expect(estimateRequestPrefixTokens({ systemPrompt: "x".repeat(40), tools: [cyclic] })).toBe(10);
	});
});

