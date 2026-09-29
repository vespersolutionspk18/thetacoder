/**
 * F2 context compiler — F1 diagnostics with a `diagnosticsPath` filter.
 *
 * Verifies that when `options.diagnosticsPath` is supplied, the compiler
 * forwards it to the adapter so only diagnostics on that path are
 * surfaced in the projection. The audit's Section 20 calls for the
 * compiler to perform identifier-scoped lookups; the path filter is the
 * first level of that scoping.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { compileContext } from "../src/core/context-compiler.ts";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

function findDiagnosticsMessage(messages: AgentMessage[]): string | undefined {
	for (const m of messages) {
		if (m.role === "custom" && m.customType === "f1-diagnostics") {
			return typeof m.content === "string" ? m.content : undefined;
		}
	}
	return undefined;
}

describe("compileContext — F1 diagnostics with diagnosticsPath filter", () => {
	it("forwards diagnosticsPath to the adapter and only includes matching diagnostics", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockDiagnostics([
			{
				relation: "diagnostic",
				file: "src/target.ts",
				line: 1,
				severity: "error",
				message: "wanted",
				timestamp: 0,
				certainty: "exact",
			},
			{
				relation: "diagnostic",
				file: "src/other.ts",
				line: 2,
				severity: "error",
				message: "unwanted",
				timestamp: 0,
				certainty: "exact",
			},
		]);

		const out = await compileContext([makeUser("hi", 1)], undefined, {
			tokenBudget: 1_000_000,
			semanticAdapter: adapter,
			includeDiagnostics: true,
			diagnosticsPath: "src/target.ts",
		});

		const diag = findDiagnosticsMessage(out.messages);
		expect(diag).toBeDefined();
		expect(diag).toContain("src/target.ts");
		expect(diag).toContain("wanted");
		expect(diag).not.toContain("src/other.ts");
		expect(diag).not.toContain("unwanted");
	});

	it("emits no diagnostics message when the path filter matches nothing", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockDiagnostics([
			{
				relation: "diagnostic",
				file: "src/other.ts",
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
			diagnosticsPath: "src/nonexistent.ts",
		});

		expect(findDiagnosticsMessage(out.messages)).toBeUndefined();
	});

	it("without a diagnosticsPath, the compiler asks the adapter for diagnostics on all files", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockDiagnostics([
			{
				relation: "diagnostic",
				file: "src/a.ts",
				line: 1,
				severity: "error",
				message: "a",
				timestamp: 0,
				certainty: "exact",
			},
			{
				relation: "diagnostic",
				file: "src/b.ts",
				line: 2,
				severity: "error",
				message: "b",
				timestamp: 0,
				certainty: "exact",
			},
		]);

		const out = await compileContext([makeUser("hi", 1)], undefined, {
			tokenBudget: 1_000_000,
			semanticAdapter: adapter,
			includeDiagnostics: true,
		});

		const diag = findDiagnosticsMessage(out.messages);
		expect(diag).toBeDefined();
		expect(diag).toContain("src/a.ts");
		expect(diag).toContain("src/b.ts");
	});
});

