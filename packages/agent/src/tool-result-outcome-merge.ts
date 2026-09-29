/**
 * Tool-result outcome merge helpers.
 *
 * Layer-2 (agent-loop) attaches a synthesized {@link ToolOutcome} to every
 * tool result before extension `tool_result` handlers run. Layer-3
 * handlers may replace the entire `details` object. The merge helpers in
 * this file preserve the synthesized outcome across that replacement: a
 * handler that does not carry its own `outcome` keeps the synthesized one;
 * a handler that explicitly sets `outcome` wins.
 *
 * The helpers are exported so they can be exercised by unit tests without
 * needing the full extension runner import graph.
 */

import type { ToolOutcome } from "./types.ts";

/** Extract a synthesized {@link ToolOutcome} from opaque tool details. */
export function extractOutcome(details: unknown): ToolOutcome | undefined {
	if (details === null || typeof details !== "object") return undefined;
	const obj = details as Record<string, unknown>;
	const outcome = obj.outcome;
	if (outcome === undefined) return undefined;
	if (outcome === null || typeof outcome !== "object") return undefined;
	return outcome as ToolOutcome;
}

/** Whether the details object explicitly carries its own `outcome` field. */
export function hasOwnOutcome(details: unknown): boolean {
	if (details === null || typeof details !== "object") return false;
	return "outcome" in (details as Record<string, unknown>);
}

/** Narrow `unknown` details into a plain object, or `undefined` if not one. */
export function toRecord(details: unknown): Record<string, unknown> | undefined {
	if (details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
	return details as Record<string, unknown>;
}

/**
 * Return `details` with the synthesized outcome preserved when the
 * replacement does not carry its own. When the handler explicitly set
 * `outcome`, the handler value wins.
 */
export function preserveOutcome<TDetails>(
	originalDetails: unknown,
	replacementDetails: TDetails,
	synthesizedOutcome: ToolOutcome | undefined,
): TDetails {
	if (synthesizedOutcome === undefined) return replacementDetails;
	if (hasOwnOutcome(replacementDetails)) return replacementDetails;
	const preserved = {
		...(toRecord(originalDetails) ?? {}),
		...(toRecord(replacementDetails) ?? {}),
		outcome: synthesizedOutcome,
	};
	return preserved as TDetails;
}

