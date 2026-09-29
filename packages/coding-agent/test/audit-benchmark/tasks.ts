/**
 * Representative tasks for the audit benchmark.
 *
 * Each task is a deterministic scripted conversation that exercises a
 * different shape of agent work. The conversation is encoded as a list
 * of `Turn` records; the runner iterates over them in order, drives the
 * F2 layer between turns, and the mock LLM consumes the scripted
 * responses.
 *
 * The three tasks:
 *   - "known-function fix"  — the model already knows the file from the
 *     system prompt; one read + one edit completes the task.
 *   - "unknown bug"         — the model must read 2-3 files to find the
 *     bug; one edit completes the fix.
 *   - "navigation"          — the model must read several files to locate
 *     a target; no edit, just a final text response.
 *
 * The scripted responses are deliberately not "smart" — they only have
 * to follow the runner's expectations so the F2 layer's metrics can be
 * measured deterministically. Real-world LLM behaviour is captured by
 * the F2 layer's metrics (cache hit rate, prompt token growth), not by
 * the responses themselves.
 */

import type { AgentMessage, AgentTool } from "@theta/agent-core";
import type { AssistantMessage, UserMessage } from "@theta/ai";
import type { TaskState } from "../../src/core/task-state.ts";
import { makeAssistantText, makeAssistantToolCall, makeToolResult, makeUser, TaskClock } from "./shared.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single LLM call from the runner. The mock provider returns the
 *  scripted `assistantMessage` and (when stopReason is toolUse) the
 *  runner immediately executes the tool the assistant named. */
export interface Turn {
	/** The agent message stream snapshot *before* the model is called. */
	streamBeforeCall: AgentMessage[];
	/** The scripted assistant response. */
	assistantMessage: AssistantMessage;
	/** The expected tool execution, if `assistantMessage` had a tool call. */
	expectedToolCall?: {
		name: string;
		arguments: Record<string, unknown>;
		/** What the tool would have returned. */
		result: {
			text: string;
			contentIdentity?: string;
			isError?: boolean;
		};
		/** True if the result has a different `contentIdentity` than the last read of this path. */
		staleAfter?: boolean;
	};
	/** True if the runner should mark this tool call as a wrong-path claim against the task. */
	incorrectRepositoryClaim?: boolean;
	/** True if the run completes after this turn (no follow-up expected). */
	terminal?: boolean;
}

/** One task definition. */
export interface TaskDefinition {
	id: string;
	label: string;
	/** Human-readable description of the task. */
	description: string;
	/** The expected target path(s) the model is supposed to call. Used to detect incorrect repo claims. */
	expectedPaths: string[];
	/** Build the scripted turns. The function is called once per repetition. */
	buildTurns(): Turn[];
	/** Initial TaskState for this task (per-run; the runner re-applies freshness on each call). */
	buildInitialTaskState(): TaskState;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull the first tool call from an assistant message (or throw if there is none). */
function firstToolCall(message: AssistantMessage): {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
} {
	const block = message.content.find((b) => b.type === "toolCall");
	if (!block || block.type !== "toolCall") {
		throw new Error("expected assistant tool call");
	}
	return {
		id: block.id,
		name: block.name,
		arguments: (block.arguments ?? {}) as Record<string, unknown>,
	};
}

/** Append a user turn to a stream, with a synthetic user message. */
function appendUser(stream: AgentMessage[], text: string, clock: TaskClock): UserMessage {
	const u = makeUser(text, clock);
	stream.push(u);
	return u;
}

/** Append an assistant text turn. */
function appendAssistantText(stream: AgentMessage[], text: string, clock: TaskClock): AssistantMessage {
	const a = makeAssistantText(text, clock);
	stream.push(a);
	return a;
}

/** Append an assistant tool-call turn. */
function appendAssistantToolCall(
	stream: AgentMessage[],
	toolName: string,
	args: Record<string, unknown>,
	clock: TaskClock,
): AssistantMessage {
	const a = makeAssistantToolCall(toolName, args, clock);
	stream.push(a);
	return a;
}

/** Append a tool result turn. */
function appendToolResult(
	stream: AgentMessage[],
	toolCallId: string,
	toolName: string,
	text: string,
	clock: TaskClock,
	options: { isError?: boolean; contentIdentity?: string } = {},
): AgentMessage {
	const tr = makeToolResult(toolCallId, toolName, text, clock, { isError: options.isError });
	stream.push(tr);
	return tr;
}

// ---------------------------------------------------------------------------
// Task 1: known-function fix
// ---------------------------------------------------------------------------

/**
 * The system prompt tells the model the function `greet` lives in
 * `src/index.ts` and the audit's report claims the comma is in the
 * wrong place. The model: read → edit → done. Two LLM calls.
 */
function buildKnownFunctionFixTurns(): Turn[] {
	const clock = new TaskClock();
	const turns: Turn[] = [];
	const stream: AgentMessage[] = [];

	// --- Turn 1: user asks to fix the bug. Model decides to read the file first. ---
	appendUser(stream, "Fix the comma bug in greet() in src/index.ts.", clock);
	const callRead = appendAssistantToolCall(stream, "read", { path: "src/index.ts" }, clock);
	turns.push({
		streamBeforeCall: stream.slice(0, stream.length - 1),
		assistantMessage: callRead,
		expectedToolCall: {
			name: "read",
			arguments: { path: "src/index.ts" },
			result: {
				text:
					"// entry point\nexport function greet(name: string): string {\n" +
					"  return 'hello, ' + name;\n" +
					"}\n",
				contentIdentity: "idx-hash-1",
			},
		},
	});

	// --- Turn 2: read result delivered; model writes the edit. ---
	appendToolResult(
		stream,
		firstToolCall(callRead).id,
		"read",
		"// entry point\nexport function greet(name: string): string {\n  return 'hello, ' + name;\n}\n",
		clock,
	);
	const callEdit = appendAssistantToolCall(
		stream,
		"edit",
		{
			path: "src/index.ts",
			oldText: "  return 'hello, ' + name;",
			newText: "  return 'hello, ' + name + '.';",
		},
		clock,
	);
	turns.push({
		streamBeforeCall: stream.slice(0, stream.length - 1),
		assistantMessage: callEdit,
		expectedToolCall: {
			name: "edit",
			arguments: {
				path: "src/index.ts",
				oldText: "  return 'hello, ' + name;",
				newText: "  return 'hello, ' + name + '.';",
			},
			result: { text: "edit applied", contentIdentity: "idx-hash-2" },
		},
	});

	// --- Turn 3: edit result delivered; model finalises. ---
	appendToolResult(stream, firstToolCall(callEdit).id, "edit", "edit applied", clock);
	const finalText = appendAssistantText(stream, "Fixed greet(): added the missing period.", clock);
	turns.push({
		streamBeforeCall: stream.slice(0, stream.length - 1),
		assistantMessage: finalText,
		terminal: true,
	});

	return turns;
}

function buildKnownFunctionFixState(): TaskState {
	const now = Date.now();
	return {
		id: "task-known-function-fix",
		objective: { text: "Fix the comma bug in greet() in src/index.ts.", createdAt: now },
		constraints: [],
		decisions: [],
		hypotheses: [],
		changedFiles: [
			{
				path: "src/index.ts",
				contentHash: "idx-hash-0",
				changedAt: now,
			},
		],
		verifications: [],
		evidence: [],
		createdAt: now,
		updatedAt: now,
	};
}

const knownFunctionFix: TaskDefinition = {
	id: "known-function-fix",
	label: "known-function fix",
	description: "Single-file edit at a known path. Read + edit + confirm.",
	expectedPaths: ["src/index.ts"],
	buildTurns: buildKnownFunctionFixTurns,
	buildInitialTaskState: buildKnownFunctionFixState,
};

// ---------------------------------------------------------------------------
// Task 2: unknown bug
// ---------------------------------------------------------------------------

/**
 * The user does not know which file contains the bug. The model must
 * read 2-3 files (one redundant, one wrong) before finding the bug in
 * `src/math.ts` and editing it. The script intentionally:
 *  - reads `src/util.ts` (wrong file, redundant visit later)
 *  - reads `src/format.ts` (wrong file, never re-read)
 *  - reads `src/math.ts` (correct file)
 *  - edits `src/math.ts` (correct path)
 *
 * The first read uses a stale contentIdentity to exercise the freshness
 * check. The redundant re-read of `src/util.ts` is counted as a
 * redundant source delivery if F2 dedup doesn't kick in.
 */
function buildUnknownBugTurns(): Turn[] {
	const clock = new TaskClock();
	const turns: Turn[] = [];
	const stream: AgentMessage[] = [];

	appendUser(stream, "A test is failing. Find and fix the bug.", clock);

	// Turn 1: model reads util.ts (wrong, but plausible first guess).
	const callReadUtil = appendAssistantToolCall(stream, "read", { path: "src/util.ts" }, clock);
	turns.push({
		streamBeforeCall: stream.slice(0, stream.length - 1),
		assistantMessage: callReadUtil,
		expectedToolCall: {
			name: "read",
			arguments: { path: "src/util.ts" },
			result: {
				text: "// misc utilities\nexport function clamp(...)\n",
				contentIdentity: "util-hash-1",
			},
		},
	});

	// Turn 2: model reads math.ts (correct file).
	appendToolResult(stream, firstToolCall(callReadUtil).id, "read", "// misc utilities\n", clock);
	const callReadMath = appendAssistantToolCall(stream, "read", { path: "src/math.ts" }, clock);
	turns.push({
		streamBeforeCall: stream.slice(0, stream.length - 1),
		assistantMessage: callReadMath,
		expectedToolCall: {
			name: "read",
			arguments: { path: "src/math.ts" },
			// Note: stale hash to exercise freshness.
			result: {
				text: "// math helpers\nexport function add(...)\n  return a - b;\n",
				contentIdentity: "math-hash-STALE",
			},
			staleAfter: true,
		},
	});

	// Turn 3: model re-reads util.ts (redundant). The runner counts the
	// repeated text as a redundant source delivery if F2 dedup doesn't
	// collapse it before the LLM sees it.
	appendToolResult(stream, firstToolCall(callReadMath).id, "read", "// math helpers\n", clock);
	const callReadUtilAgain = appendAssistantToolCall(stream, "read", { path: "src/util.ts" }, clock);
	turns.push({
		streamBeforeCall: stream.slice(0, stream.length - 1),
		assistantMessage: callReadUtilAgain,
		expectedToolCall: {
			name: "read",
			arguments: { path: "src/util.ts" },
			result: { text: "// misc utilities\n", contentIdentity: "util-hash-1" },
		},
	});

	// Turn 4: model edits math.ts (correct fix).
	appendToolResult(stream, firstToolCall(callReadUtilAgain).id, "read", "// misc utilities\n", clock);
	const callEdit = appendAssistantToolCall(
		stream,
		"edit",
		{
			path: "src/math.ts",
			oldText: "  return a - b;",
			newText: "  return a + b;",
		},
		clock,
	);
	turns.push({
		streamBeforeCall: stream.slice(0, stream.length - 1),
		assistantMessage: callEdit,
		expectedToolCall: {
			name: "edit",
			arguments: {
				path: "src/math.ts",
				oldText: "  return a - b;",
				newText: "  return a + b;",
			},
			result: { text: "edit applied", contentIdentity: "math-hash-2" },
		},
	});

	// Turn 5: model finalises.
	appendToolResult(stream, firstToolCall(callEdit).id, "edit", "edit applied", clock);
	const finalText = appendAssistantText(stream, "Bug fixed in src/math.ts: add() now returns a + b.", clock);
	turns.push({
		streamBeforeCall: stream.slice(0, stream.length - 1),
		assistantMessage: finalText,
		terminal: true,
	});

	return turns;
}

function buildUnknownBugState(): TaskState {
	const now = Date.now();
	return {
		id: "task-unknown-bug",
		objective: { text: "Find and fix the bug in the synthetic project.", createdAt: now },
		constraints: [],
		decisions: [],
		hypotheses: [
			{
				id: "h1",
				text: "Bug is in src/math.ts (suspected from failing test name).",
				status: "open",
				madeAt: now,
			},
		],
		changedFiles: [],
		verifications: [],
		evidence: [],
		createdAt: now,
		updatedAt: now,
	};
}

const unknownBug: TaskDefinition = {
	id: "unknown-bug",
	label: "unknown bug",
	description: "Multi-file read including a redundant visit; one edit; freshness check.",
	expectedPaths: ["src/math.ts", "src/util.ts"],
	buildTurns: buildUnknownBugTurns,
	buildInitialTaskState: buildUnknownBugState,
};

// ---------------------------------------------------------------------------
// Task 3: navigation
// ---------------------------------------------------------------------------

/**
 * Pure navigation: the model must read 4 files (one of which does not
 * exist — that is the "incorrect repository claim" we want to count),
 * then return the answer in plain text. No edits.
 */
function buildNavigationTurns(): Turn[] {
	const clock = new TaskClock();
	const turns: Turn[] = [];
	const stream: AgentMessage[] = [];

	appendUser(stream, "Where is the clamp() helper defined? Reply with the path.", clock);

	// Turn 1: model reads index.ts (wrong).
	const call1 = appendAssistantToolCall(stream, "read", { path: "src/index.ts" }, clock);
	turns.push({
		streamBeforeCall: stream.slice(0, stream.length - 1),
		assistantMessage: call1,
		expectedToolCall: {
			name: "read",
			arguments: { path: "src/index.ts" },
			result: { text: "// entry point\n", contentIdentity: "idx-hash-1" },
		},
	});

	// Turn 2: model reads format.ts (wrong).
	appendToolResult(stream, firstToolCall(call1).id, "read", "// entry point\n", clock);
	const call2 = appendAssistantToolCall(stream, "read", { path: "src/format.ts" }, clock);
	turns.push({
		streamBeforeCall: stream.slice(0, stream.length - 1),
		assistantMessage: call2,
		expectedToolCall: {
			name: "read",
			arguments: { path: "src/format.ts" },
			result: { text: "// string formatting\n", contentIdentity: "fmt-hash-1" },
		},
	});

	// Turn 3: model reads a path that doesn't exist (incorrect repo claim).
	appendToolResult(stream, firstToolCall(call2).id, "read", "// string formatting\n", clock);
	const call3 = appendAssistantToolCall(stream, "read", { path: "src/helpers/clamp.ts" }, clock);
	turns.push({
		streamBeforeCall: stream.slice(0, stream.length - 1),
		assistantMessage: call3,
		incorrectRepositoryClaim: true,
		expectedToolCall: {
			name: "read",
			arguments: { path: "src/helpers/clamp.ts" },
			result: { text: "ENOENT: no such file", isError: true },
		},
	});

	// Turn 4: model reads util.ts (correct).
	appendToolResult(stream, firstToolCall(call3).id, "read", "ENOENT: no such file", clock, { isError: true });
	const call4 = appendAssistantToolCall(stream, "read", { path: "src/util.ts" }, clock);
	turns.push({
		streamBeforeCall: stream.slice(0, stream.length - 1),
		assistantMessage: call4,
		expectedToolCall: {
			name: "read",
			arguments: { path: "src/util.ts" },
			result: { text: "// misc utilities\n", contentIdentity: "util-hash-1" },
		},
	});

	// Turn 5: model finalises.
	appendToolResult(stream, firstToolCall(call4).id, "read", "// misc utilities\n", clock);
	const finalText = appendAssistantText(stream, "src/util.ts", clock);
	turns.push({
		streamBeforeCall: stream.slice(0, stream.length - 1),
		assistantMessage: finalText,
		terminal: true,
	});

	return turns;
}

function buildNavigationState(): TaskState {
	const now = Date.now();
	return {
		id: "task-navigation",
		objective: { text: "Locate the clamp() helper and return its path.", createdAt: now },
		constraints: [],
		decisions: [],
		hypotheses: [],
		changedFiles: [],
		verifications: [],
		evidence: [],
		createdAt: now,
		updatedAt: now,
	};
}

const navigation: TaskDefinition = {
	id: "navigation",
	label: "navigation",
	description: "Multi-file read with an incorrect path claim; no edit.",
	expectedPaths: ["src/util.ts"],
	buildTurns: buildNavigationTurns,
	buildInitialTaskState: buildNavigationState,
};

// ---------------------------------------------------------------------------
// Public registry
// ---------------------------------------------------------------------------

export const TASKS: TaskDefinition[] = [knownFunctionFix, unknownBug, navigation];

/**
 * Convenience: look up a task by id. Returns `undefined` if not found.
 * Used by tests that want to exercise a single task.
 */
export function getTaskById(id: string): TaskDefinition | undefined {
	return TASKS.find((t) => t.id === id);
}

// `AgentTool` is re-exported for test files that need a typed reference.
export type { AgentTool };

