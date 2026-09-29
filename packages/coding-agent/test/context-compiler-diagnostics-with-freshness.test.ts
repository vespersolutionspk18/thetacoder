/**
 * F2 context compiler — F1 diagnostics with freshness cross-reference.
 *
 * Verifies that when a diagnostic's file appears in
 * `taskState.changedFiles`, the rendered diagnostic line is suffixed
 * with `[confirmed unresolved]`. The audit's Section 20 treats
 * "exact identifier/diagnostic lookup" (item 4) and "evidence
 * freshness checks" (item 3) as separate compiler responsibilities
 * — this test confirms the cross-reference wiring: the freshness
 * track (`changedFiles`) feeds into the diagnostic surface so the
 * model sees the diagnostic is still live and the model has been
 * editing the file.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { compileContext } from "../src/core/context-compiler.ts";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";
import { createInitialTaskState, recordChange, type TaskState } from "../src/core/task-state.ts";

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

describe("compileContext — F1 diagnostics with freshness cross-reference", () => {
	it("marks a diagnostic as [confirmed unresolved] when its file is in taskState.changedFiles", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockDiagnostics([
			{
				relation: "diagnostic",
				file: "src/changed.ts",
				line: 1,
				severity: "error",
				message: "stale error",
				timestamp: 0,
				certainty: "exact",
			},
		]);

		let state: TaskState = createInitialTaskState("s");
		state = recordChange(state, { path: "src/changed.ts", contentHash: "h" });

		const out = await compileContext([makeUser("hi", 1)], state, {
			tokenBudget: 1_000_000,
			semanticAdapter: adapter,
			includeDiagnostics: true,
		});

		const diag = findDiagnosticsMessage(out.messages);
		expect(diag).toBeDefined();
		expect(diag).toContain("src/changed.ts");
		expect(diag).toContain("[confirmed unresolved]");
	});

	it("does NOT mark a diagnostic as confirmed when its file is NOT in taskState.changedFiles", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockDiagnostics([
			{
				relation: "diagnostic",
				file: "src/untouched.ts",
				line: 1,
				severity: "error",
				message: "untouched error",
				timestamp: 0,
				certainty: "exact",
			},
		]);

		// changedFiles references a different file.
		let state: TaskState = createInitialTaskState("s");
		state = recordChange(state, { path: "src/other.ts", contentHash: "h" });

		const out = await compileContext([makeUser("hi", 1)], state, {
			tokenBudget: 1_000_000,
			semanticAdapter: adapter,
			includeDiagnostics: true,
		});

		const diag = findDiagnosticsMessage(out.messages);
		expect(diag).toBeDefined();
		expect(diag).toContain("src/untouched.ts");
		expect(diag).not.toContain("[confirmed unresolved]");
	});

	it("only marks diagnostics whose file is in changedFiles — mixed batch", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockDiagnostics([
			{
				relation: "diagnostic",
				file: "src/touched.ts",
				line: 1,
				severity: "error",
				message: "live error",
				timestamp: 0,
				certainty: "exact",
			},
			{
				relation: "diagnostic",
				file: "src/untouched.ts",
				line: 2,
				severity: "error",
				message: "ambient error",
				timestamp: 0,
				certainty: "exact",
			},
		]);

		let state: TaskState = createInitialTaskState("s");
		state = recordChange(state, { path: "src/touched.ts", contentHash: "h" });

		const out = await compileContext([makeUser("hi", 1)], state, {
			tokenBudget: 1_000_000,
			semanticAdapter: adapter,
			includeDiagnostics: true,
		});

		const diag = findDiagnosticsMessage(out.messages);
		expect(diag).toBeDefined();
		const lines = (diag ?? "").split("\n");
		const touchedLine = lines.find((l) => l.includes("src/touched.ts"));
		const untouchedLine = lines.find((l) => l.includes("src/untouched.ts"));
		expect(touchedLine).toBeDefined();
		expect(untouchedLine).toBeDefined();
		expect(touchedLine).toContain("[confirmed unresolved]");
		expect(untouchedLine).not.toContain("[confirmed unresolved]");
	});

	it("an empty taskState.changedFiles leaves no diagnostic marked confirmed", async () => {
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

		const state = createInitialTaskState("s");
		// No recordChange call → empty changedFiles.

		const out = await compileContext([makeUser("hi", 1)], state, {
			tokenBudget: 1_000_000,
			semanticAdapter: adapter,
			includeDiagnostics: true,
		});

		const diag = findDiagnosticsMessage(out.messages);
		expect(diag).toBeDefined();
		expect(diag).not.toContain("[confirmed unresolved]");
	});

	it("undefined taskState still works — no diagnostic is marked confirmed (the changedFiles set is empty)", async () => {
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
			includeDiagnostics: true,
		});

		const diag = findDiagnosticsMessage(out.messages);
		expect(diag).toBeDefined();
		expect(diag).not.toContain("[confirmed unresolved]");
	});
});

