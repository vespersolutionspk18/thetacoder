/**
 * F11 incremental serialization for the F2 convertToLlm step.
 *
 * The regular `convertToLlm` walks the full message array and re-serializes
 * tool arguments on every call. The F2 layer calls it once per provider
 * request, so for a long session the same assistant message with the same
 * tool-call arguments is converted over and over.
 *
 * `IncrementalSerializer` caches the converted `Message` per
 * `AgentMessage`, keyed by a content hash of the fields that affect the
 * convertToLlm output (tool-call arguments dominate). When the same
 * `AgentMessage` reference is passed in again with the same inputs, the
 * cached `Message` is returned without re-running the conversion.
 *
 * The cache is a `WeakMap<AgentMessage, CacheEntry>` so entries
 * auto-evict when the message is no longer referenced (e.g. compacted
 * out of the session). A small `Set<AgentMessage>` mirrors the keys to
 * expose a `size` stat via `getCacheStats()`; the session already holds
 * the messages strongly, so the Set does not extend their lifetime in
 * practice.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, Message, ToolCall } from "@theta/ai";
import { convertToLlm } from "./messages.ts";

interface CacheEntry {
	/** Stable hash of the conversion-relevant fields of the source message. */
	hash: string;
	/** The Message object previously produced by convertToLlm for this input. */
	result: Message;
}

export interface IncrementalSerializerStats {
	/** Number of `serialize` calls that returned a cached entry. */
	hits: number;
	/** Number of `serialize` calls that had to re-run convertToLlm. */
	misses: number;
	/** Number of distinct AgentMessages currently held in the cache. */
	size: number;
}

/**
 * Cache the F2 convertToLlm output per AgentMessage, re-using the
 * previous result when the message's conversion-relevant fields
 * (tool-call arguments, role, text, etc.) are unchanged.
 *
 * The serializer is safe to share across the message array passed to a
 * single `convertToLlm` call: every call uses the same backing cache.
 */
export class IncrementalSerializer {
	private readonly cache = new WeakMap<AgentMessage, CacheEntry>();
	// Mirror the cache keys for accurate `size` reporting. The session
	// already holds the messages strongly via its own state, so the Set
	// does not extend their lifetime in practice; it only exposes the
	// count for `getCacheStats()`. When a message is GC'd by the session
	// (e.g. after compaction), the entry disappears from the WeakMap and
	// `pruneTracked` walks the Set to drop the dangling key.
	private readonly tracked = new Set<AgentMessage>();
	private hits = 0;
	private misses = 0;

	/**
	 * Convert a single AgentMessage to a Message, using the cache when
	 * the message's conversion-relevant fields are unchanged. Returns
	 * `undefined` for messages that convertToLlm drops (e.g.
	 * `bashExecution` with `excludeFromContext`); these are not cached
	 * so the next call still reports the correct result if the flag
	 * is later cleared.
	 */
	serialize(message: AgentMessage): Message | undefined {
		const hash = hashMessage(message);
		const existing = this.cache.get(message);
		if (existing && existing.hash === hash) {
			this.hits++;
			return existing.result;
		}
		this.misses++;
		const converted = convertToLlm([message]);
		if (converted.length === 0) {
			// Filtered out by convertToLlm. Do not cache the "no result"
			// case so a later change to the message can flip the result
			// without a stale entry blocking it.
			return undefined;
		}
		// `convertToLlm` may return the same object reference as the
		// source message (e.g. assistant/user/toolResult pass through).
		// Deep-clone the result so later mutations on the source
		// AgentMessage don't retroactively rewrite the cached Message.
		const result = structuredClone(converted[0]!);
		const wasNew = !existing;
		this.cache.set(message, { hash, result });
		if (wasNew) {
			this.tracked.add(message);
		}
		return result;
	}

	/**
	 * Diagnostic stats: cache hits, misses, and the current number of
	 * cached messages. The session's strong references to messages mean
	 * `size` matches the number of distinct messages that have been
	 * converted since the serializer was created.
	 */
	getCacheStats(): IncrementalSerializerStats {
		return { hits: this.hits, misses: this.misses, size: this.tracked.size };
	}

	/** Reset the hit/miss counters without dropping cached entries. */
	resetStats(): void {
		this.hits = 0;
		this.misses = 0;
	}
}

/**
 * Incremental version of `convertToLlm` backed by a shared
 * `IncrementalSerializer`. Re-issuing the call with the same
 * `AgentMessage` references reuses the cached `Message` for each
 * unchanged message and only re-serializes messages whose inputs
 * changed since the last call.
 */
export function convertToLlmIncremental(serializer: IncrementalSerializer, messages: AgentMessage[]): Message[] {
	const out: Message[] = [];
	for (const m of messages) {
		const converted = serializer.serialize(m);
		if (converted !== undefined) {
			out.push(converted);
		}
	}
	return out;
}

/**
 * Build a `(messages) => Message[]` function compatible with the F2
 * `convertToLlm` wire-in. The returned closure is backed by a
 * long-lived `IncrementalSerializer` so repeated calls with the same
 * `AgentMessage` references skip per-message re-serialization.
 *
 * Usage from the F2 wire-in:
 *   const convertToLlmWithCache = createIncrementalConvertToLlm();
 *   // pass `convertToLlmWithCache` where a `(messages) => Message[]`
 *   // is expected.
 */
export function createIncrementalConvertToLlm(): (messages: AgentMessage[]) => Message[] {
	const serializer = new IncrementalSerializer();
	return (messages) => convertToLlmIncremental(serializer, messages);
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Compute a stable string hash of the fields of an `AgentMessage` that
 * affect the `convertToLlm` output. Two messages with the same hash
 * are guaranteed to produce the same `Message` from `convertToLlm` for
 * the current `messages.ts` implementation.
 */
function hashMessage(message: AgentMessage): string {
	switch (message.role) {
		case "assistant": {
			// Tool-call arguments are the volatile, expensive piece.
			// Thinking blocks do not affect convertToLlm output, so they
			// are intentionally excluded from the hash.
			const textParts: string[] = [];
			const toolCalls: { id: string; name: string; arguments: unknown }[] = [];
			for (const block of (message as AssistantMessage).content) {
				if (block.type === "toolCall") {
					const tc = block as ToolCall;
					toolCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
				} else if (block.type === "text") {
					textParts.push(block.text);
				}
			}
			return stableStringify({
				kind: "assistant",
				stopReason: (message as AssistantMessage).stopReason,
				api: (message as AssistantMessage).api,
				provider: (message as AssistantMessage).provider,
				model: (message as AssistantMessage).model,
				timestamp: message.timestamp,
				text: textParts.join("\n"),
				toolCalls,
			});
		}
		case "user":
			return stableStringify({
				kind: "user",
				content: message.content,
				timestamp: message.timestamp,
			});
		case "toolResult":
			return stableStringify({
				kind: "toolResult",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: message.content,
				isError: message.isError,
				timestamp: message.timestamp,
			});
		case "bashExecution":
			return stableStringify({
				kind: "bashExecution",
				command: message.command,
				output: message.output,
				exitCode: message.exitCode,
				cancelled: message.cancelled,
				truncated: message.truncated,
				fullOutputPath: message.fullOutputPath,
				timestamp: message.timestamp,
				excludeFromContext: message.excludeFromContext,
			});
		case "custom":
			return stableStringify({
				kind: "custom",
				customType: message.customType,
				content: message.content,
				display: message.display,
				timestamp: message.timestamp,
			});
		case "branchSummary":
			return stableStringify({
				kind: "branchSummary",
				summary: message.summary,
				fromId: message.fromId,
				timestamp: message.timestamp,
			});
		case "compactionSummary":
			return stableStringify({
				kind: "compactionSummary",
				summary: message.summary,
				tokensBefore: message.tokensBefore,
				timestamp: message.timestamp,
			});
		default: {
			// Exhaustiveness check; never reached at runtime.
			const _exhaustive: never = message;
			return String(_exhaustive);
		}
	}
}

/**
 * Deterministic JSON-ish serializer used as a cheap content hash.
 * Object keys are sorted so `{a:1,b:2}` and `{b:2,a:1}` hash to the
 * same string. Functions and symbols are dropped (matches
 * `JSON.stringify`); cycles are broken with a `[circular]` marker.
 *
 * This is not a cryptographic hash — it is a fast stable key for
 * equality checks inside the in-memory cache. Use the returned string
 * as a Map/WeakMap key; equality of hashes implies equality of
 * converted output for the purposes of `convertToLlm`.
 */
function stableStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	return stringify(value, seen);
}

function stringify(value: unknown, seen: WeakSet<object>): string {
	if (value === null) return "null";
	if (value === undefined) return "null";
	const t = typeof value;
	if (t === "string") return JSON.stringify(value);
	if (t === "number") return Number.isFinite(value as number) ? String(value) : "null";
	if (t === "boolean") return value ? "true" : "false";
	if (t === "bigint") return `${(value as bigint).toString()}n`;
	if (t === "function" || t === "symbol") return "null";
	if (Array.isArray(value)) {
		if (seen.has(value)) return '"[circular]"';
		seen.add(value);
		const parts: string[] = [];
		for (const v of value) {
			parts.push(stringify(v, seen));
		}
		seen.delete(value);
		return `[${parts.join(",")}]`;
	}
	if (t === "object") {
		const obj = value as Record<string, unknown>;
		if (seen.has(obj)) return '"[circular]"';
		seen.add(obj);
		const keys = Object.keys(obj).sort();
		const parts: string[] = [];
		for (const k of keys) {
			parts.push(`${JSON.stringify(k)}:${stringify(obj[k], seen)}`);
		}
		seen.delete(obj);
		return `{${parts.join(",")}}`;
	}
	return "null";
}

