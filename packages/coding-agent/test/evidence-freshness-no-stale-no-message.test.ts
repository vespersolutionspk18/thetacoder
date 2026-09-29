/**
 * F2 evidence freshness — `annotateStaleness` does NOT prepend a
 * message when every file in the report is `fresh`.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { compileContext } from "../src/core/context-compiler.ts";
import { annotateStaleness, checkEvidenceFreshness } from "../src/core/evidence-freshness.ts";
import { createInitialTaskState, recordChange, type TaskState } from "../src/core/task-state.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

describe("F2 evidence freshness — annotateStaleness, all fresh", () => {
	it("does not prepend a freshness-warning message when everything is fresh", () => {
		const now = 1_700_000_000_000;
		let state: TaskState = createInitialTaskState("s");
		state = recordChange(state, { path: "src/a.ts", contentHash: "h-fresh" });
		state = recordChange(state, { path: "src/b.ts", contentHash: "h-fresh-b" });

		const messages: AgentMessage[] = [makeUser("hi", 1)];
		const compiled = compileContext(messages, state, { tokenBudget: 1_000_000 });

		const latestHashes = new Map<string, string>([
			["src/a.ts", "h-fresh"],
			["src/b.ts", "h-fresh-b"],
		]);
		const report = checkEvidenceFreshness({ taskState: state, latestHashes, now });

		expect(report.freshCount).toBe(2);
		expect(report.staleCount).toBe(0);
		expect(report.missingCount).toBe(0);

		const annotated = annotateStaleness(report, compiled);

		// No message is prepended — the projection is unchanged in length.
		expect(annotated.messages.length).toBe(compiled.messages.length);
		// The original first message is still at index 0.
		expect(annotated.messages[0]).toBe(compiled.messages[0]);

		// The freshness report is attached to the context regardless.
		expect(annotated.freshness).toBe(report);
	});
});

