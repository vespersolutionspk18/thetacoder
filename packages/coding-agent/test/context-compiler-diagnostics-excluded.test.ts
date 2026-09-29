/**
 * F2 context compiler — F1 diagnostics excluded by default.
 *
 * Verifies that when `includeDiagnostics` is `false` (the default) or
 * not supplied, no `customType: "f1-diagnostics"` message appears in
 * the projection even when a `semanticAdapter` is provided. This is
 * the opt-in guarantee called for in the spec: the new feature is off
 * by default and must not regress existing projections.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { compileContext } from "../src/core/context-compiler.ts";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

function findDiagnosticsMessage(messages: AgentMessage[]): AgentMessage | undefined {
	for (const m of messages) {
		if (m.role === "custom" && m.customType === "f1-diagnostics") {
			return m;
		}
	}
	return undefined;
}

describe("compileContext — F1 diagnostics excluded by default", () => {
	it("does not inject a diagnostics message when includeDiagnostics is not provided", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockDiagnostics([
			{
				relation: "diagnostic",
				file: "src/a.ts",
				line: 1,
				severity: "error",
				message: "x",
				timestamp: 0,
				certainty: "exact",
			},
		]);

		// includeDiagnostics omitted → defaults to false.
		const out = await compileContext([makeUser("hi", 1)], undefined, {
			tokenBudget: 1_000_000,
			semanticAdapter: adapter,
		});

		expect(findDiagnosticsMessage(out.messages)).toBeUndefined();
	});

	it("does not inject a diagnostics message when includeDiagnostics is explicitly false", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockDiagnostics([
			{
				relation: "diagnostic",
				file: "src/a.ts",
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
			includeDiagnostics: false,
		});

		expect(findDiagnosticsMessage(out.messages)).toBeUndefined();
	});

	it("does not inject a diagnostics message when semanticAdapter is not provided (even with includeDiagnostics=true)", async () => {
		// Without an adapter there is no way to fetch diagnostics; the
		// function must silently skip the injection (the runtime
		// gate is `options.semanticAdapter && options.includeDiagnostics`).
		const out = await compileContext([makeUser("hi", 1)], undefined, {
			tokenBudget: 1_000_000,
			includeDiagnostics: true,
		});

		expect(findDiagnosticsMessage(out.messages)).toBeUndefined();
	});
});

