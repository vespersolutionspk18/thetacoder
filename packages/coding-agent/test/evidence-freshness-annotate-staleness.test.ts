/**
 * F2 evidence freshness — `annotateStaleness` prepends a
 * `customType: "freshness-warning"` custom message to the projection
 * when the report has at least one stale or missing row.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { compileContext } from "../src/core/context-compiler.ts";
import { annotateStaleness, checkEvidenceFreshness, type FreshnessReport } from "../src/core/evidence-freshness.ts";
import { createInitialTaskState, recordChange, type TaskState } from "../src/core/task-state.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

describe("F2 evidence freshness — annotateStaleness", () => {
	it("prepends a freshness-warning custom message at the head of the projection", () => {
		const now = 1_700_000_000_000;
		let state: TaskState = createInitialTaskState("s");
		state = recordChange(state, { path: "src/a.ts", contentHash: "h-old" });

		// Build a small CompiledContext to annotate.
		const messages: AgentMessage[] = [makeUser("hi", 1)];
		const compiled = compileContext(messages, state, { tokenBudget: 1_000_000 });

		// Build a report with one stale row.
		const latestHashes = new Map<string, string>([["src/a.ts", "h-new"]]);
		const report: FreshnessReport = checkEvidenceFreshness({ taskState: state, latestHashes, now });

		const annotated = annotateStaleness(report, compiled);

		// The new head is the freshness-warning custom message.
		const head = annotated.messages[0];
		expect(head).toBeDefined();
		expect(head?.role).toBe("custom");
		if (head?.role === "custom") {
			expect(head.customType).toBe("freshness-warning");
			expect(head.display).toBe(false);
			expect(head.content).toMatch(/^\[FRESHNESS\]/);
			expect(head.content).toContain("1 stale");
			expect(head.content).toContain("0 missing");
			expect(head.content).toContain("src/a.ts");
		}

		// The original projection messages follow after the new head.
		expect(annotated.messages.length).toBe(compiled.messages.length + 1);

		// The freshness report is attached to the context.
		expect(annotated.freshness).toBe(report);
		expect(annotated.freshness?.staleCount).toBe(1);
	});
});

