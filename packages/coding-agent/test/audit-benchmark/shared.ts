/**
 * Shared helpers for the audit benchmark.
 *
 * Keeps the cross-module plumbing in one place so `runner.ts`, `tasks.ts`,
 * and `metrics.ts` can stay focused on their own responsibilities.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, TextContent, UserMessage } from "@theta/ai";
import type { CustomMessage as CodingAgentCustomMessage } from "../../src/core/messages.ts";
import { convertToLlm } from "../../src/core/messages.ts";

// ---------------------------------------------------------------------------
// Token estimator
// ---------------------------------------------------------------------------

/** Same estimator as `compileContext` defaults: chars/4, rounded up. */
export function estimateTokens(text: string): number {
	if (text.length === 0) return 0;
	return Math.ceil(text.length / 4);
}

/** Plain-text projection of a list of AgentMessages for token estimation. */
export function messagesToPlainText(messages: AgentMessage[]): string {
	const out: string[] = [];
	for (const m of messages) {
		out.push(messageToText(m));
	}
	return out.join("\n");
}

function messageToText(message: AgentMessage): string {
	switch (message.role) {
		case "user":
			return userMessageText(message as UserMessage);
		case "assistant":
			return assistantMessageText(message as AssistantMessage);
		case "toolResult":
			return (message as { content: Array<TextContent | { type: string }> }).content
				.filter((b) => (b as { type: string }).type === "text")
				.map((b) => (b as TextContent).text)
				.join("\n");
		case "compactionSummary":
			return (message as { summary: string }).summary;
		case "branchSummary":
			return (message as { summary: string }).summary;
		case "bashExecution":
			return `${(message as { command: string }).command}\n${(message as { output: string }).output}`;
		case "custom":
			return typeof (message as { content: unknown }).content === "string"
				? ((message as { content: string }).content as string)
				: (message as { content: Array<TextContent> }).content
						.filter((b) => b.type === "text")
						.map((b) => b.text)
						.join("\n");
		default: {
			const _exhaustive: never = message;
			return String(_exhaustive);
		}
	}
}

function userMessageText(message: UserMessage): string {
	return typeof message.content === "string"
		? message.content
		: (message.content as TextContent[]).map((c) => c.text).join("\n");
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

// ---------------------------------------------------------------------------
// Synthetic message builders
// ---------------------------------------------------------------------------

/** A monotonically increasing clock so messages in a single task have a stable ordering. */
export class TaskClock {
	now = 1_000_000;
	next(): number {
		this.now += 1;
		return this.now;
	}
}

export function makeUser(text: string, clock: TaskClock): UserMessage {
	return { role: "user", content: text, timestamp: clock.next() };
}

export function makeAssistantText(text: string, clock: TaskClock): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: clock.next(),
	};
}

export function makeAssistantToolCall(
	toolName: string,
	arguments_: Record<string, unknown>,
	clock: TaskClock,
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: `call_${clock.now}_${Math.random().toString(36).slice(2, 7)}`,
				name: toolName,
				arguments: arguments_,
			},
		],
		api: "anthropic-messages",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: clock.next(),
	};
}

export function makeToolResult(
	toolCallId: string,
	toolName: string,
	text: string,
	clock: TaskClock,
	options: { isError?: boolean } = {},
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: options.isError ?? false,
		timestamp: clock.next(),
	};
}

export function makeCustomMessage(
	customType: string,
	content: string,
	clock: TaskClock,
	details?: Record<string, unknown>,
): CodingAgentCustomMessage {
	const base: CodingAgentCustomMessage = {
		role: "custom",
		customType,
		content,
		display: false,
		timestamp: clock.next(),
	};
	if (details) base.details = details;
	return base;
}

// ---------------------------------------------------------------------------
// Synthetic fixture
// ---------------------------------------------------------------------------

/**
 * The synthetic fixture is a 5-file project. The benchmark creates
 * one of these in a temp directory and uses it as the "known" codebase
 * for navigation and edit tasks. Returns the file paths and their
 * initial contents.
 */
export interface SyntheticFixture {
	rootDir: string;
	files: { path: string; content: string; contentHash: string }[];
}

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Cheap non-crypto hash for the synthetic fixture. */
export function cheapHash(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) {
		h = (h * 33) ^ text.charCodeAt(i);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/** Materialize the synthetic 5-file project at `rootDir`. */
export function createSyntheticFixture(rootDir: string): SyntheticFixture {
	const files: { path: string; content: string; contentHash: string }[] = (
		[
			{
				path: "src/index.ts",
				content:
					"// entry point\nexport function greet(name: string): string {\n" +
					"  return 'hello, ' + name;\n" +
					"}\n",
			},
			{
				path: "src/math.ts",
				content:
					"// math helpers\nexport function add(a: number, b: number): number {\n" +
					"  // BUG: returns a - b instead of a + b (audit fixture bug)\n" +
					"  return a - b;\n" +
					"}\n" +
					"export function subtract(a: number, b: number): number {\n" +
					"  return a - b;\n" +
					"}\n",
			},
			{
				path: "src/util.ts",
				content:
					"// misc utilities\nexport function clamp(n: number, lo: number, hi: number): number {\n" +
					"  return Math.max(lo, Math.min(hi, n));\n" +
					"}\n" +
					"export function identity<T>(x: T): T {\n" +
					"  return x;\n" +
					"}\n",
			},
			{
				path: "src/format.ts",
				content:
					"// string formatting\nexport function shout(s: string): string {\n" +
					"  return s.toUpperCase() + '!';\n" +
					"}\n" +
					"export function whisper(s: string): string {\n" +
					"  return s.toLowerCase() + '.';\n" +
					"}\n",
			},
			{
				path: "README.md",
				content:
					"# synthetic fixture\n" +
					"\n" +
					"Five-file project used by the audit benchmark.\n" +
					"\n" +
					"- `src/index.ts` re-exports `greet`.\n" +
					"- `src/math.ts` contains the audit's intentional bug.\n" +
					"- `src/util.ts` and `src/format.ts` are noise.\n",
			},
		] as { path: string; content: string; contentHash?: string }[]
	).map((f) => ({
		...f,
		contentHash: f.contentHash ?? "",
	}));
	for (const f of files) {
		const absPath = join(rootDir, f.path);
		mkdirSync(join(absPath, ".."), { recursive: true });
		writeFileSync(absPath, f.content, "utf-8");
		f.contentHash = cheapHash(f.content);
	}
	return { rootDir, files };
}

// ---------------------------------------------------------------------------
// Token / prompt projection helpers
// ---------------------------------------------------------------------------

/**
 * Run the full F2 wire-in pipeline (compileContext + freshness +
 * cache-markers + convertToLlm) over a message stream. Returns:
 *   - `projection`: the AgentMessage[] that was sent to the LLM
 *   - `promptTokens`: estimated prompt tokens
 *   - `generatedTokens`: estimated generated tokens
 *   - `cacheControlEmissions`: number of cache-control markers placed
 *   - `freshnessWarningCount`: 0 or 1 per turn
 *   - `redundantSourceDeliveries`: count of consecutive identical tool-result text
 *   - `f2Cache`: IncrementalSerializer stats (when F2 is on)
 *
 * The `convertToLlm` is captured in `lastConvert` for the runner to
 * call on each turn; we report the prompt/generated token estimate by
 * text length here.
 */
export interface F2PipelineResult {
	projection: AgentMessage[];
	promptTokens: number;
	generatedTokens: number;
	cacheControlEmissions: number;
	freshnessWarningCount: number;
	redundantSourceDeliveries: number;
	llmMessages: ReturnType<typeof convertToLlm>;
}

import {
	annotateCacheMarkers,
	attachCachePlanToMessages,
	type RenderCacheOptions,
} from "../../src/core/cache-rendering.ts";
import type { CompiledContext } from "../../src/core/context-compiler.ts";
import { compileContext } from "../../src/core/context-compiler.ts";
import { annotateStaleness, checkEvidenceFreshness, type FreshnessReport } from "../../src/core/evidence-freshness.ts";
import { convertToLlmIncremental, type IncrementalSerializer } from "../../src/core/incremental-serialization.ts";
import type { TaskState } from "../../src/core/task-state.ts";

export interface RunF2PipelineOptions {
	messages: AgentMessage[];
	taskState: TaskState | undefined;
	latestHashes: Map<string, string>;
	f2Enabled: boolean;
	incrementalSerializer: IncrementalSerializer | null;
	renderOptions: RenderCacheOptions;
	tokenBudget: number;
}

export function runF2Pipeline(options: RunF2PipelineOptions): F2PipelineResult {
	const { messages, taskState, latestHashes, f2Enabled, incrementalSerializer, renderOptions, tokenBudget } = options;

	// ---- compileContext ----
	const compiled: CompiledContext = compileContext(messages, taskState, { tokenBudget });

	// ---- evidence freshness ----
	const freshnessReport: FreshnessReport = checkEvidenceFreshness({
		taskState,
		latestHashes,
	});
	const annotated = annotateStaleness(freshnessReport, compiled);

	// ---- cache markers + plan attachment ----
	const cacheAnnotated = annotateCacheMarkers(annotated, renderOptions);
	const projection: AgentMessage[] = attachCachePlanToMessages(cacheAnnotated.messages, cacheAnnotated.cachePlan!);

	// ---- convertToLlm (F2 incremental or plain) ----
	const llmMessages = f2Enabled
		? convertToLlmIncremental(incrementalSerializer!, projection)
		: convertToLlm(projection);

	// ---- token estimates ----
	let promptChars = 0;
	let generatedChars = 0;
	for (const m of projection) {
		if (m.role === "assistant") {
			generatedChars += messageToText(m).length;
		} else {
			promptChars += messageToText(m).length;
		}
	}
	const promptTokens = Math.ceil(promptChars / 4);
	const generatedTokens = Math.ceil(generatedChars / 4);

	// ---- counters ----
	const cacheControlEmissions = cacheAnnotated.cachePlan?.markers.length ?? 0;
	const freshnessWarningCount = freshnessReport.staleCount + freshnessReport.missingCount > 0 ? 1 : 0;
	let redundantSourceDeliveries = 0;
	let lastText: string | null = null;
	for (const m of projection) {
		if (m.role === "toolResult") {
			const t = messageToText(m);
			if (t !== "" && t === lastText) redundantSourceDeliveries += 1;
			lastText = t;
		} else {
			lastText = null;
		}
	}

	return {
		projection,
		promptTokens,
		generatedTokens,
		cacheControlEmissions,
		freshnessWarningCount,
		redundantSourceDeliveries,
		llmMessages,
	};
}

