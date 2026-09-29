/**
 * F2 context compiler — F1 diagnostics injection.
 *
 * Verifies that when `includeDiagnostics: true` is supplied along
 * with a `semanticAdapter`, the compiler fetches diagnostics from
 * the adapter and injects them as a `customType: "f1-diagnostics"`
 * custom message at the head of the projection.
 *
 * The audit's Section 20 "Target Architecture" (item 4 of the 10
 * compiler responsibilities) calls for "exact identifier/diagnostic
 * lookup". This is the wiring of that responsibility.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { compileContext } from "../src/core/context-compiler.ts";
import { type DiagnosticResult, MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

function findDiagnosticsMessage(messages: AgentMessage[]):
	| {
			content: string;
			details: unknown;
	  }
	| undefined {
	for (const m of messages) {
		if (m.role === "custom" && m.customType === "f1-diagnostics") {
			return {
				content: typeof m.content === "string" ? m.content : "",
				details: m.details,
			};
		}
	}
	return undefined;
}

describe("compileContext — F1 diagnostics included", () => {
	it("injects a f1-diagnostics custom message at the head when includeDiagnostics=true", async () => {
		const adapter = new MockSemanticQueryAdapter();
		const injected: DiagnosticResult[] = [
			{
				relation: "diagnostic",
				file: "src/foo.ts",
				line: 10,
				column: 4,
				code: 2304,
				severity: "error",
				message: "Cannot find name 'foo'.",
				source: "typescript",
				snapshotId: "abc",
				timestamp: 1,
				certainty: "exact",
			},
		];
		adapter.setMockDiagnostics(injected);

		const out = await compileContext([makeUser("hi", 1)], undefined, {
			tokenBudget: 1_000_000,
			semanticAdapter: adapter,
			includeDiagnostics: true,
		});

		const diag = findDiagnosticsMessage(out.messages);
		expect(diag).toBeDefined();
		expect(diag?.content).toContain("[F1 DIAGNOSTICS]");
		expect(diag?.content).toContain("src/foo.ts");
		expect(diag?.content).toContain("Cannot find name 'foo'");
	});

	it("the diagnostics message is the very first message in the projection", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockDiagnostics([
			{
				relation: "diagnostic",
				file: "src/x.ts",
				line: 1,
				severity: "error",
				message: "x",
				timestamp: 0,
				certainty: "exact",
			},
		]);

		const out = await compileContext([makeUser("hi", 1)], undefined, {
			tokenBudget: 1_000_000,
			semanticAdapter: adapter,
			includeDiagnostics: true,
		});

		expect(out.messages[0]?.role).toBe("custom");
		if (out.messages[0]?.role === "custom") {
			expect(out.messages[0].customType).toBe("f1-diagnostics");
		}
	});

	it("the diagnostics message is marked display=false and includes diagnostic details", async () => {
		const adapter = new MockSemanticQueryAdapter();
		const injected: DiagnosticResult[] = [
			{
				relation: "diagnostic",
				file: "src/bar.ts",
				line: 5,
				severity: "error",
				message: "boom",
				timestamp: 42,
				certainty: "exact",
			},
		];
		adapter.setMockDiagnostics(injected);

		const out = await compileContext([makeUser("hi", 1)], undefined, {
			tokenBudget: 1_000_000,
			semanticAdapter: adapter,
			includeDiagnostics: true,
		});

		const diag = findDiagnosticsMessage(out.messages);
		expect(diag).toBeDefined();
		// `details` carries the raw diagnostics so observability tools
		// can inspect them without re-parsing the rendered text.
		const details = diag?.details as { diagnostics: DiagnosticResult[] } | undefined;
		expect(details?.diagnostics).toHaveLength(1);
		expect(details?.diagnostics[0]?.file).toBe("src/bar.ts");

		// display flag is hidden — same convention as the
		// task-state-context messages.
		const firstCustom = out.messages.find((m) => m.role === "custom" && m.customType === "f1-diagnostics");
		if (firstCustom?.role === "custom") {
			expect(firstCustom.display).toBe(false);
		} else {
			throw new Error("expected a custom f1-diagnostics message");
		}
	});

	it("renders multiple diagnostics with severity, code, file, line, and message", async () => {
		const adapter = new MockSemanticQueryAdapter();
		// Note: the mock's default is to filter out warnings; the
		// compiler does not yet pass `includeWarnings: true` to the
		// adapter, so use only error-severity entries here.
		adapter.setMockDiagnostics([
			{
				relation: "diagnostic",
				file: "src/a.ts",
				line: 3,
				code: "TS2304",
				severity: "error",
				message: "first",
				timestamp: 0,
				certainty: "exact",
			},
			{
				relation: "diagnostic",
				file: "src/b.ts",
				line: 7,
				column: 12,
				code: 7006,
				severity: "error",
				message: "second",
				timestamp: 0,
				certainty: "candidate",
			},
		]);

		const out = await compileContext([makeUser("hi", 1)], undefined, {
			tokenBudget: 1_000_000,
			semanticAdapter: adapter,
			includeDiagnostics: true,
		});

		const diag = findDiagnosticsMessage(out.messages);
		expect(diag).toBeDefined();
		// Header
		expect(diag?.content).toContain("[F1 DIAGNOSTICS]");
		// Both diagnostics present
		expect(diag?.content).toContain("src/a.ts:3");
		expect(diag?.content).toContain("TS2304");
		expect(diag?.content).toContain("first");
		expect(diag?.content).toContain("src/b.ts:7:12");
		expect(diag?.content).toContain("7006");
		expect(diag?.content).toContain("second");
	});

	it("diagnostics appear before the user message in the output order", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockDiagnostics([
			{
				relation: "diagnostic",
				file: "src/q.ts",
				line: 1,
				severity: "error",
				message: "x",
				timestamp: 0,
				certainty: "exact",
			},
		]);

		const out = await compileContext([makeUser("user-text", 1)], undefined, {
			tokenBudget: 1_000_000,
			semanticAdapter: adapter,
			includeDiagnostics: true,
		});

		const diagIndex = out.messages.findIndex((m) => m.role === "custom" && m.customType === "f1-diagnostics");
		const userIndex = out.messages.findIndex((m) => m.role === "user");
		expect(diagIndex).toBeGreaterThanOrEqual(0);
		expect(userIndex).toBeGreaterThanOrEqual(0);
		expect(diagIndex).toBeLessThan(userIndex);
	});

	it("no diagnostics message is injected when the adapter returns an empty list", async () => {
		const adapter = new MockSemanticQueryAdapter();
		// No setMockDiagnostics call — the mock returns [].

		const out = await compileContext([makeUser("hi", 1)], undefined, {
			tokenBudget: 1_000_000,
			semanticAdapter: adapter,
			includeDiagnostics: true,
		});

		expect(findDiagnosticsMessage(out.messages)).toBeUndefined();
	});
});

