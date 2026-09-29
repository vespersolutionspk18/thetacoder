/**
 * Tests for the extension `tool_result` merge contract around synthesized
 * tool outcomes.
 *
 * Layer-2 (agent-loop) attaches a structured outcome to every tool result.
 * Layer-3 (extension `tool_result` handlers) may replace `details` entirely.
 * The merge contract must:
 *   1. Preserve the synthesized outcome when a handler returns new details
 *      that do not carry their own `outcome`.
 *   2. Honor an explicit handler-supplied `outcome` (handler wins).
 *
 * These tests exercise the merge helpers directly so they do not depend on
 * the full ExtensionRunner import graph (which transitively pulls in the
 * shell renderer chain during the earendil refactor).
 */

import type { ToolOutcome } from "@theta/agent-core";
import { extractOutcome, hasOwnOutcome, preserveOutcome, toRecord } from "@theta/agent-core";
import { describe, expect, it } from "vitest";

function makeSynthesizedOutcome(): ToolOutcome {
	return {
		status: "succeeded",
		parserIdentity: "exact-match",
		source: { parser: "shell-spawn" },
		confidence: 1,
	};
}

describe("ToolResult outcome merge helpers", () => {
	it("extractOutcome returns undefined for missing/null/non-object details", () => {
		expect(extractOutcome(undefined)).toBeUndefined();
		expect(extractOutcome(null)).toBeUndefined();
		expect(extractOutcome("string")).toBeUndefined();
		expect(extractOutcome(42)).toBeUndefined();
	});

	it("extractOutcome returns undefined when details lack an outcome", () => {
		expect(extractOutcome({})).toBeUndefined();
		expect(extractOutcome({ truncation: { truncated: false } })).toBeUndefined();
	});

	it("extractOutcome returns the outcome when present and an object", () => {
		const outcome = makeSynthesizedOutcome();
		expect(extractOutcome({ outcome })).toEqual(outcome);
	});

	it("extractOutcome returns undefined for malformed outcome values", () => {
		expect(extractOutcome({ outcome: null })).toBeUndefined();
		expect(extractOutcome({ outcome: "string" })).toBeUndefined();
		expect(extractOutcome({ outcome: 42 })).toBeUndefined();
	});

	it("hasOwnOutcome detects the explicit outcome key", () => {
		expect(hasOwnOutcome({ outcome: makeSynthesizedOutcome() })).toBe(true);
		expect(hasOwnOutcome({ outcome: undefined })).toBe(true);
		expect(hasOwnOutcome({})).toBe(false);
		expect(hasOwnOutcome(null)).toBe(false);
		expect(hasOwnOutcome(undefined)).toBe(false);
	});

	it("toRecord narrows object details and rejects arrays/non-objects", () => {
		expect(toRecord({ a: 1 })).toEqual({ a: 1 });
		expect(toRecord([])).toBeUndefined();
		expect(toRecord(null)).toBeUndefined();
		expect(toRecord("string")).toBeUndefined();
	});

	it("preserveOutcome keeps synthesized outcome when handler details lack one", () => {
		const synthesized = makeSynthesizedOutcome();
		const original = { truncation: undefined, outcome: synthesized };
		const handlerDetails = { custom: "x" };

		const merged = preserveOutcome(original, handlerDetails, synthesized);

		expect((merged as Record<string, unknown>).custom).toBe("x");
		expect((merged as Record<string, unknown>).outcome).toEqual(synthesized);
	});

	it("preserveOutcome lets handler-supplied outcome win over synthesized", () => {
		const synthesized = makeSynthesizedOutcome();
		const handlerOutcome: ToolOutcome = {
			status: "unknown",
			parserIdentity: "handler-override",
			source: { parser: "custom" },
			confidence: 0.1,
		};
		const original = { truncation: undefined, outcome: synthesized };
		const handlerDetails = { outcome: handlerOutcome };

		const merged = preserveOutcome(original, handlerDetails, synthesized);

		expect((merged as Record<string, unknown>).outcome).toEqual(handlerOutcome);
	});

	it("preserveOutcome is a no-op when no synthesized outcome exists", () => {
		const handlerDetails = { custom: "y" };
		const merged = preserveOutcome(undefined, handlerDetails, undefined);
		expect(merged).toBe(handlerDetails);
		expect((merged as Record<string, unknown>).outcome).toBeUndefined();
	});

	it("preserveOutcome chains handler fields alongside the outcome", () => {
		const synthesized = makeSynthesizedOutcome();
		const handlerDetails = { extra: 1, observed: { count: 3 } };

		const merged = preserveOutcome({ outcome: synthesized }, handlerDetails, synthesized);

		const record = merged as Record<string, unknown>;
		expect(record.extra).toBe(1);
		expect(record.observed).toEqual({ count: 3 });
		expect(record.outcome).toEqual(synthesized);
	});
});

