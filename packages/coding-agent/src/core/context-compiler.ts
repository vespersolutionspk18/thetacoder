/**
 * F2 minimum-viable context compiler.
 *
 * Consumes an `AgentMessage[]` (the agent's message stream), a `TaskState`
 * (durable task state from task-state.ts), and a token budget. Produces a
 * budgeted `AgentMessage[]` suitable for the next inference call.
 *
 * MVP scope: selection + dedup + budgeting. Other context compiler steps
 * from the audit (instruction/capability resolution, evidence freshness
 * checks, exact identifier/diagnostic lookup, bounded dependency expansion,
 * provider-protocol validation, stable rendering, delivery accounting) are
 * out of scope here.
 *
 * No agent-loop integration yet. This is a pure function module.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, Message, TextContent, UserMessage } from "@theta/ai";
import { COMPACTION_SUMMARY_PREFIX, type CustomMessage as CodingAgentCustomMessage } from "./messages.ts";
import type { DiagnosticResult, SemanticQueryAdapter } from "./repository/semantic-queries.ts";
import { getActiveConstraints, getFailedVerifications, getOpenHypotheses, type TaskState } from "./task-state.ts";

// =========================================================================
// Public types
// =========================================================================

/** Options that govern a single `compileContext` invocation. */
export interface ContextCompilerOptions {
	/** Soft cap on the projected token count of the output messages. */
	tokenBudget: number;
	/**
	 * Maximum number of recent turns to keep. A turn is a group of messages
	 * starting from a user, compaction summary, or branch summary, ending just
	 * before the next such message. Messages outside the recent N turns are
	 * trimmed (counted as `droppedByBudget`).
	 * Default: 20.
	 */
	keepRecentTurns?: number;
	/**
	 * Whether to include failed verifications from TaskState as an injected
	 * message. The audit considers verification state always visible, so the
	 * default is true.
	 */
	includeVerifications?: boolean;
	/**
	 * Whether to include active constraints from TaskState as an injected
	 * message. Default: true.
	 */
	includeConstraints?: boolean;
	/**
	 * Whether to dedupe consecutive identical tool-result content. Default:
	 * true.
	 */
	dedupeIdenticalToolResults?: boolean;
	/**
	 * Token estimator. Input is the concatenated text of a message; output is
	 * the estimated token count. Default: chars/4 (rounded up).
	 */
	estimator?: (text: string) => number;
	/**
	 * Optional F1 semantic query adapter. When supplied along with
	 * `includeDiagnostics: true`, the compiler calls
	 * `semanticAdapter.getDiagnostics({ path: options.diagnosticsPath })`
	 * and injects the result as a `customType: "f1-diagnostics"`
	 * custom message at the head of the projection, before the
	 * TaskState-derived messages. Default: undefined (no injection).
	 */
	semanticAdapter?: SemanticQueryAdapter;
	/**
	 * When true (and `semanticAdapter` is set), inject F1 diagnostics
	 * as a custom message at the head of the projection. Default:
	 * false. When this is `true` the return type of `compileContext`
	 * widens to `Promise<CompiledContext>` because the F1 adapter is
	 * async.
	 */
	includeDiagnostics?: boolean;
	/**
	 * Optional path filter passed to `semanticAdapter.getDiagnostics`
	 * as `{ path }`. When omitted, diagnostics for all files in the
	 * adapter's scope are requested.
	 */
	diagnosticsPath?: string;
}

/** Per-category counts of kept/dropped messages, surfaced for observability. */
export interface ContextCompilerAccounting {
	keptUserMessages: number;
	keptAssistantMessages: number;
	keptToolResults: number;
	keptCompactionSummaries: number;
	keptCustomMessages: number;
	droppedByBudget: number;
	droppedByDedup: number;
	droppedByCompactionBoundary: number;
	/** Count of TaskState-derived injected messages (objective, constraints, decisions/hypotheses, verifications). */
	taskStateInjectedMessages: number;
}

/** Result of a `compileContext` invocation. */
export interface CompiledContext {
	messages: AgentMessage[];
	droppedCount: number;
	keptTokens: number;
	/** `keptTokens / tokenBudget` — may exceed 1.0 when essentials overflow the cap. */
	budgetUsed: number;
	accounting: ContextCompilerAccounting;
	/**
	 * F2 stable-rendering plan. Populated by `annotateCacheMarkers`
	 * (see `cache-rendering.ts`); absent on a raw `compileContext` result.
	 * The provider adapter will consume this in a follow-up change.
	 */
	cachePlan?: import("./cache-rendering.ts").CachePlan;
	/**
	 * F2 evidence freshness report. Populated by
	 * `checkEvidenceFreshness` + `annotateStaleness` (see
	 * `evidence-freshness.ts`); absent on a raw `compileContext` result.
	 * When populated, the projection carries a `customType:
	 * "freshness-warning"` message at the head listing the affected
	 * paths.
	 */
	freshness?: import("./evidence-freshness.ts").FreshnessReport;
}

// =========================================================================
// Internal helpers
// =========================================================================

/** Default estimator: ~4 characters per token, rounded up to keep an integer. */
function defaultEstimator(text: string): number {
	if (text.length === 0) return 0;
	return Math.ceil(text.length / 4);
}

/** Extract a plain-text representation of an `AgentMessage` for token estimation. */
function messageToText(message: AgentMessage): string {
	switch (message.role) {
		case "user":
			return userMessageText(message);
		case "assistant":
			return assistantMessageText(message);
		case "toolResult":
			return contentArrayText(message.content);
		case "compactionSummary":
			return message.summary;
		case "branchSummary":
			return message.summary;
		case "bashExecution":
			return `${message.command}\n${message.output}`;
		case "custom":
			return typeof message.content === "string" ? message.content : contentArrayText(message.content);
		default: {
			// Exhaustiveness check via never; never reached at runtime.
			const _exhaustive: never = message;
			return "";
		}
	}
}

function userMessageText(message: UserMessage): string {
	return typeof message.content === "string" ? message.content : contentArrayText(message.content);
}

function assistantMessageText(message: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "thinking") parts.push(block.thinking);
		else if (block.type === "toolCall") {
			parts.push(block.name);
			try {
				parts.push(JSON.stringify(block.arguments));
			} catch {
				parts.push("[unserializable tool args]");
			}
		}
	}
	return parts.join("\n");
}

function contentArrayText(content: (TextContent | { type: "image"; data: string; mimeType: string })[]): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
		// Images contribute only a small constant for estimator purposes.
	}
	return parts.join("\n");
}

/**
 * Returns true if the message looks like a compaction summary — either the
 * dedicated role or a user message whose text begins with the recognized
 * compaction prefix.
 */
function isCompactionSummaryMessage(message: AgentMessage): boolean {
	if (message.role === "compactionSummary") return true;
	if (message.role === "user") {
		const content = message.content;
		if (typeof content === "string") {
			return content.startsWith(COMPACTION_SUMMARY_PREFIX);
		}
		for (const block of content) {
			if (block.type === "text" && block.text.startsWith(COMPACTION_SUMMARY_PREFIX)) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Returns the index of the first message after the most recent compaction
 * summary marker, or 0 if none. Pre-boundary tool results may be safely
 * dropped; the boundary itself is the start of the post-compaction section.
 */
export function findLatestCompactionBoundary(messages: AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isCompactionSummaryMessage(messages[i]!)) {
			return i + 1;
		}
	}
	return 0;
}

/** A "turn" is a group of messages starting from a user/compactionSummary/branchSummary,
 *  ending just before the next such message. Trailing non-turn-starting messages form a final turn. */
function groupIntoTurns(messages: AgentMessage[]): AgentMessage[][] {
	const turns: AgentMessage[][] = [];
	let current: AgentMessage[] = [];
	for (const message of messages) {
		if (isTurnStart(message)) {
			if (current.length > 0) turns.push(current);
			current = [message];
		} else {
			current.push(message);
		}
	}
	if (current.length > 0) turns.push(current);
	return turns;
}

function isTurnStart(message: AgentMessage): boolean {
	return message.role === "user" || message.role === "compactionSummary" || message.role === "branchSummary";
}

/** Returns true if the assistant message is terminal (no tool calls pending). */
function isTerminalAssistant(message: AssistantMessage): boolean {
	return message.stopReason !== "toolUse";
}

/** Find the latest user message in a sequence, or undefined if none. */
function findLatestUserMessage(messages: AgentMessage[]): AgentMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]!.role === "user") return messages[i];
	}
	return undefined;
}

/** Find the latest terminal assistant message, or undefined if none. */
function findLatestTerminalAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "assistant" && isTerminalAssistant(m)) return m;
	}
	return undefined;
}

/** Find the latest compaction summary message, or undefined if none. */
function findLatestCompactionSummary(messages: AgentMessage[]): AgentMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isCompactionSummaryMessage(messages[i]!)) return messages[i];
	}
	return undefined;
}

/** Plain text content of a tool-result message, suitable for equality comparison. */
function toolResultText(message: AgentMessage): string {
	if (message.role !== "toolResult") return "";
	return contentArrayText(message.content);
}

/** Build a TaskState-context custom message. */
function makeTaskStateContextMessage(body: string, timestamp: number, marker: string): CodingAgentCustomMessage {
	return {
		role: "custom",
		customType: "task-state-context",
		content: body,
		display: false,
		details: { marker },
		timestamp,
	};
}

/**
 * Render a single diagnostic as a one-line text entry. The freshness
 * cross-reference is appended as a `[confirmed unresolved]` suffix
 * when the diagnostic's file appears in `changedFilePaths` (i.e. the
 * model has been editing that file and the diagnostic has not been
 * cleared).
 */
function formatDiagnosticLine(d: DiagnosticResult, changedFilePaths: Set<string>): string {
	const codePart = d.code !== undefined ? ` (${d.code})` : "";
	const colPart = d.column !== undefined ? `:${d.column}` : "";
	const confirmedTag = changedFilePaths.has(d.file) ? " [confirmed unresolved]" : "";
	return `${d.severity}${codePart} ${d.file}:${d.line}${colPart} — ${d.message}${confirmedTag}`;
}

/**
 * Build the `customType: "f1-diagnostics"` custom message that the
 * compiler prepends when F1 diagnostics are requested. Returns
 * `null` when the adapter returned an empty list (no surface area,
 * no message — keeps the projection free of empty context blocks).
 *
 * The cross-reference against `taskState.changedFiles` is computed
 * by the caller (so this helper stays pure).
 */
export function buildDiagnosticsContextMessage(
	diagnostics: DiagnosticResult[],
	changedFilePaths: Set<string>,
	timestamp: number,
): CodingAgentCustomMessage | null {
	if (diagnostics.length === 0) return null;

	const lines: string[] = ["[F1 DIAGNOSTICS] recent compilation errors:"];
	for (const d of diagnostics) {
		lines.push(formatDiagnosticLine(d, changedFilePaths));
	}

	return {
		role: "custom",
		customType: "f1-diagnostics",
		content: lines.join("\n"),
		display: false,
		details: { diagnostics },
		timestamp,
	};
}

/** Build the three (or four) TaskState-derived messages, in order. */
function buildTaskStateContextMessages(
	taskState: TaskState,
	includeConstraints: boolean,
	includeVerifications: boolean,
): CodingAgentCustomMessage[] {
	const messages: CodingAgentCustomMessage[] = [];
	const now = taskState.updatedAt;

	if (taskState.objective) {
		const body = `## Objective\n${taskState.objective.text}`;
		messages.push(makeTaskStateContextMessage(body, now, "objective"));
	}

	if (includeConstraints) {
		const active = getActiveConstraints(taskState);
		if (active.length > 0) {
			const lines = active.map((c, i) => `${i + 1}. (${c.source}) ${c.text}`);
			const body = `## Active constraints\n${lines.join("\n")}`;
			messages.push(makeTaskStateContextMessage(body, now, "constraints"));
		}
	}

	const openHypotheses = getOpenHypotheses(taskState);
	const unresolvedDecisions = taskState.decisions.filter((d) => !d.supersededBy);
	if (openHypotheses.length > 0 || unresolvedDecisions.length > 0) {
		const sections: string[] = [];
		if (unresolvedDecisions.length > 0) {
			sections.push("### Decisions");
			for (const d of unresolvedDecisions) {
				sections.push(`- ${d.text}${d.rationale ? ` — ${d.rationale}` : ""}`);
			}
		}
		if (openHypotheses.length > 0) {
			sections.push("### Open hypotheses");
			for (const h of openHypotheses) {
				sections.push(`- ${h.text}`);
			}
		}
		const body = `## Decisions and hypotheses\n${sections.join("\n")}`;
		messages.push(makeTaskStateContextMessage(body, now, "decisions-hypotheses"));
	}

	if (includeVerifications) {
		const failed = getFailedVerifications(taskState);
		if (failed.length > 0) {
			const lines = failed.map(
				(v) =>
					`- [${v.kind}${v.command ? `: ${v.command}` : ""}] passed=false observedAt=${v.observedAt}` +
					(v.falseSuccess ? " (suspected false success)" : ""),
			);
			const body = `## Failed verifications\n${lines.join("\n")}`;
			messages.push(makeTaskStateContextMessage(body, now, "failed-verifications"));
		}
	}

	return messages;
}

// =========================================================================
// Public entry point
// =========================================================================

/**
 * Produce a budgeted `AgentMessage[]` for the next inference call.
 *
 * Algorithm (MVP):
 *  1. Find the latest compaction boundary. Drop all pre-boundary tool results.
 *  2. Group remaining messages into turns. Drop turns outside the recent-N window.
 *  3. Mark essential messages (latest user, latest terminal assistant, latest compaction summary).
 *  4. Dedupe consecutive identical tool-result content.
 *  5. Inject TaskState-derived messages at the head of the output.
 *  6. Walk oldest-to-newest and drop non-essential messages until the projection fits.
 *
 * Two overloads narrow the return type:
 *  - When `includeDiagnostics` is not `true`, the function is fully
 *    synchronous and returns `CompiledContext` directly.
 *  - When `includeDiagnostics: true` AND `semanticAdapter` is set,
 *    the function awaits the adapter and returns `Promise<CompiledContext>`.
 *
 * This lets existing sync call sites (and their tests) keep the
 * `CompiledContext` return type while the F1-diagnostics feature
 * is opt-in via the new options.
 */
// Overload: diagnostics not enabled — fully synchronous. Accepts a
// `semanticAdapter` (which will be ignored) so callers that always
// pass the adapter do not have to branch on `includeDiagnostics`.
export function compileContext(
	messages: AgentMessage[],
	taskState: TaskState | undefined,
	options: Omit<ContextCompilerOptions, "includeDiagnostics"> & {
		includeDiagnostics?: false;
	},
): CompiledContext;
// Overload: diagnostics enabled but no adapter — synchronous. The
// runtime gate (`options.semanticAdapter && options.includeDiagnostics`)
// is false, so no F1 lookup happens; the function still returns
// `CompiledContext` directly.
export function compileContext(
	messages: AgentMessage[],
	taskState: TaskState | undefined,
	options: ContextCompilerOptions & {
		includeDiagnostics: true;
		semanticAdapter?: undefined;
	},
): CompiledContext;
// Overload: diagnostics enabled AND adapter set — async, awaits the F1 adapter.
export function compileContext(
	messages: AgentMessage[],
	taskState: TaskState | undefined,
	options: ContextCompilerOptions & {
		includeDiagnostics: true;
		semanticAdapter: SemanticQueryAdapter;
	},
): Promise<CompiledContext>;
// Implementation signature (not directly callable; reachable only through the overloads).
export function compileContext(
	messages: AgentMessage[],
	taskState: TaskState | undefined,
	options: ContextCompilerOptions,
): CompiledContext | Promise<CompiledContext> {
	const estimator = options.estimator ?? defaultEstimator;
	const keepRecentTurns = options.keepRecentTurns ?? 20;
	const includeConstraints = options.includeConstraints ?? true;
	const includeVerifications = options.includeVerifications ?? true;
	const dedupeIdenticalToolResults = options.dedupeIdenticalToolResults ?? true;

	const accounting: ContextCompilerAccounting = {
		keptUserMessages: 0,
		keptAssistantMessages: 0,
		keptToolResults: 0,
		keptCompactionSummaries: 0,
		keptCustomMessages: 0,
		droppedByBudget: 0,
		droppedByDedup: 0,
		droppedByCompactionBoundary: 0,
		taskStateInjectedMessages: 0,
	};

	// ---- Step 1+2: Compaction boundary + drop pre-boundary tool results ----
	const boundary = findLatestCompactionBoundary(messages);
	const postBoundary: AgentMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i]!;
		if (i < boundary && m.role === "toolResult") {
			accounting.droppedByCompactionBoundary++;
			continue;
		}
		postBoundary.push(m);
	}

	// ---- Step 2b: Keep only the most recent N turns ----
	const turns = groupIntoTurns(postBoundary);
	const keptTurns = turns.slice(Math.max(0, turns.length - keepRecentTurns));
	const droppedTurnCount = turns.length - keptTurns.length;
	for (const turn of turns.slice(0, droppedTurnCount)) {
		accounting.droppedByBudget += turn.length;
	}
	const inScope: AgentMessage[] = keptTurns.flat();

	// ---- Step 3: Identify essential messages ----
	// Essentials are always kept even if they'd otherwise be trimmed. The
	// latest compaction summary is a selection rule independent of recency;
	// if the recent-N trim dropped the turn containing it, we re-insert it
	// at the head so the boundary context is still visible to the model.
	// The latest user message and latest terminal assistant message are
	// almost always inside the recent-N window, so the recency rule keeps
	// them naturally; no special re-insertion is required for those.
	const latestCompaction = findLatestCompactionSummary(inScope);
	const keptCompactionStillPresent = latestCompaction !== undefined && inScope.includes(latestCompaction);
	if (latestCompaction !== undefined && !keptCompactionStillPresent) {
		inScope.unshift(latestCompaction);
	}

	// ---- Step 4: Dedupe consecutive identical tool-result content ----
	let deduped: AgentMessage[] = inScope;
	if (dedupeIdenticalToolResults) {
		const result: AgentMessage[] = [];
		let prevToolResultText: string | null = null;
		for (const m of inScope) {
			if (m.role === "toolResult") {
				const text = toolResultText(m);
				if (text !== "" && text === prevToolResultText) {
					accounting.droppedByDedup++;
					continue;
				}
				prevToolResultText = text;
			} else {
				prevToolResultText = null;
			}
			result.push(m);
		}
		deduped = result;
	}

	// Re-find essentials against the deduped list. The latest user, latest
	// terminal assistant, and latest compaction summary are preserved by
	// dedup (which only collapses identical tool results), so we can re-find
	// them rather than carrying indices across the transformation.
	const essentialAfterDedup = new Set<number>();
	const newLatestUser = findLatestUserMessage(deduped);
	const newLatestTerminal = findLatestTerminalAssistant(deduped);
	const newLatestCompaction = findLatestCompactionSummary(deduped);
	for (let i = 0; i < deduped.length; i++) {
		const m = deduped[i]!;
		if (m === newLatestUser) essentialAfterDedup.add(i);
		if (m === newLatestTerminal) essentialAfterDedup.add(i);
		if (m === newLatestCompaction) essentialAfterDedup.add(i);
	}

	// ---- Step 5: Build TaskState-derived messages ----
	const taskStateMessages: CodingAgentCustomMessage[] = taskState
		? buildTaskStateContextMessages(taskState, includeConstraints, includeVerifications)
		: [];
	accounting.taskStateInjectedMessages = taskStateMessages.length;

	// ---- Step 6: Apply token budget ----
	// TaskState messages are always essential. They are prepended to the
	// output but accounted for in the budget.
	const totalCandidate: AgentMessage[] = [...taskStateMessages, ...deduped];
	const totalEssential = new Set<number>();
	for (let i = 0; i < taskStateMessages.length; i++) totalEssential.add(i);
	for (const idx of essentialAfterDedup) totalEssential.add(idx + taskStateMessages.length);

	// Pre-compute per-message token costs. Token costs don't change as we
	// drop messages, so we can pre-compute once.
	const tokenCosts: number[] = totalCandidate.map((m) => estimator(messageToText(m)));
	let projection = tokenCosts.reduce((acc, n) => acc + n, 0);

	// Walk oldest -> newest, dropping non-essentials until the projection fits.
	// Single-pass is sufficient: dropping an earlier message can only lower
	// the projection; later drops may be needed if earlier drops were skipped
	// because they were essential. Iterate until stable.
	while (projection > options.tokenBudget) {
		let droppedAny = false;
		for (let i = 0; i < totalCandidate.length; i++) {
			if (projection <= options.tokenBudget) break;
			if (totalEssential.has(i)) continue;
			projection -= tokenCosts[i]!;
			totalCandidate.splice(i, 1);
			tokenCosts.splice(i, 1);
			totalEssential.delete(i);
			// Shift essential indices that point past the removed slot.
			const shifted = new Set<number>();
			for (const idx of totalEssential) {
				shifted.add(idx > i ? idx - 1 : idx);
			}
			totalEssential.clear();
			for (const idx of shifted) totalEssential.add(idx);
			accounting.droppedByBudget++;
			droppedAny = true;
		}
		if (!droppedAny) break; // Nothing left to drop; essentials overflow the cap.
	}

	// Recompute per-category counts for the final output.
	const finalMessages = totalCandidate;
	for (const m of finalMessages) {
		switch (m.role) {
			case "user":
				accounting.keptUserMessages++;
				break;
			case "assistant":
				accounting.keptAssistantMessages++;
				break;
			case "toolResult":
				accounting.keptToolResults++;
				break;
			case "compactionSummary":
				accounting.keptCompactionSummaries++;
				break;
			default:
				// bashExecution, branchSummary, custom — counted as custom for accounting.
				accounting.keptCustomMessages++;
				break;
		}
	}

	let keptTokens = 0;
	for (const m of finalMessages) keptTokens += estimator(messageToText(m));

	const compiled: CompiledContext = {
		messages: finalMessages,
		droppedCount: messages.length + taskStateMessages.length - finalMessages.length,
		keptTokens,
		budgetUsed: options.tokenBudget > 0 ? keptTokens / options.tokenBudget : 0,
		accounting,
	};

	// ---- Optional F1-diagnostics injection ----
	// When both `semanticAdapter` and `includeDiagnostics` are set,
	// the audit's "exact identifier/diagnostic lookup" responsibility
	// fires here. The diagnostics are fetched from the adapter, cross-
	// referenced against `taskState.changedFiles` to mark stale-file
	// findings as "confirmed unresolved", and prepended to the
	// projection as a `customType: "f1-diagnostics"` custom message.
	// The message is prepended ahead of the TaskState messages so the
	// model sees the most recent compilation errors first.
	if (options.semanticAdapter && options.includeDiagnostics) {
		const adapter = options.semanticAdapter;
		const path = options.diagnosticsPath;
		const now = taskState?.updatedAt ?? Date.now();
		return (async () => {
			const diagnostics = await adapter.getDiagnostics({ path });
			const changedFilePaths = new Set<string>();
			if (taskState) {
				for (const cf of taskState.changedFiles) {
					changedFilePaths.add(cf.path);
				}
			}
			const diagnosticsMessage = buildDiagnosticsContextMessage(diagnostics, changedFilePaths, now);
			if (diagnosticsMessage === null) {
				return compiled;
			}
			return {
				...compiled,
				messages: [diagnosticsMessage, ...compiled.messages],
			};
		})();
	}

	return compiled;
}

// Re-export Message type alias for consumers that need it alongside the
// public surface. Avoids pulling a second import path into their code.
export type { Message };

