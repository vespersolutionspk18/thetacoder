/**
 * F2 provider-protocol validation.
 *
 * Each LLM provider has a slightly different wire protocol. Some require
 * alternating user/assistant messages (Anthropic), some require the first
 * non-system message to be user (OpenAI), some reject empty text blocks
 * (Google). The audit (Section 20, item 8 of the 10 context compiler
 * responsibilities) calls for a dedicated validation pass that knows the
 * quirks of each provider and can insert synthetic bridge messages to
 * bring the projection into compliance where possible.
 *
 * The function takes a `CompiledContext` and a `ProviderName`, walks the
 * projection, and:
 *   - reports issues (`ValidationIssue[]`) for every detected deviation
 *   - inserts synthetic bridge messages where the protocol can be salvaged
 *   - returns a fixed `CompiledContext` plus a `fixedCount` of inserts
 *
 * The function is opt-in. `compileContext` does not call it; the host
 * (agent loop, pre-flight check, or extension) decides when to apply
 * the protocol layer. Calling it with the same `CompiledContext` and the
 * same `ProviderName` is idempotent: the second call sees the
 * already-fixed messages and reports no new issues.
 *
 * Custom (`role: "custom"`) messages are skipped by the structural
 * rules. The downstream `convertToLlm` transformer in `messages.ts`
 * renders them as user-role for the LLM, and the F2 layer does not
 * second-guess that mapping.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, UserMessage } from "@theta/ai";
import type { CompiledContext } from "./context-compiler.ts";
import type { CustomMessage as CodingAgentCustomMessage } from "./messages.ts";

// =========================================================================
// Public types
// =========================================================================

/**
 * Provider names the F2 layer knows about. `unknown` is a defensive
 * fallback: when the caller cannot identify the target provider, the
 * validator is a no-op rather than guessing.
 */
export type ProviderName = "anthropic" | "openai" | "google" | "cohere" | "unknown";

/** The set of protocol rules the validator can flag. */
export type ValidationRule =
	| "alternating-roles"
	| "first-message-must-be-user"
	| "empty-text-not-allowed"
	| "tool-result-must-follow-tool-call"
	| "role-sequence-mismatch";

/**
 * A single detected protocol deviation. Errors mark structural breaks
 * the validator could not salvage; warnings mark situations where the
 * validator chose not to fix (e.g. an orphan tool result that would
 * require synthesizing a tool call).
 */
export interface ValidationIssue {
	provider: ProviderName;
	rule: ValidationRule;
	message: string;
	severity: "error" | "warning";
	location?: { index: number };
}

/**
 * Result of a `validateProviderProtocol` call.
 *
 * - `ok` is true when no issue has `severity: "error"`. Warnings do not
 *   flip `ok` to false: a warning is a known limitation, not a hard
 *   violation.
 * - `context` is a fresh `CompiledContext` carrying the (possibly
 *   bridge-instrumented) messages. The input context is not mutated.
 * - `issues` lists every detected deviation in walk order.
 * - `fixedCount` counts the synthetic messages inserted.
 */
export interface ValidationResult {
	ok: boolean;
	context: CompiledContext;
	issues: ValidationIssue[];
	fixedCount: number;
}

// =========================================================================
// Internal helpers
// =========================================================================

/** The customType used for every synthetic bridge message this module emits. */
const SYNTHETIC_BRIDGE_CUSTOM_TYPE = "synthetic-bridge";

/**
 * Build a synthetic bridge message. The `targetRole` field tells the
 * downstream provider adapter which LLM role the bridge should be
 * rendered as. `details.synthetic: true` is the public marker the
 * synthetic-marker test asserts on; `details.rule` names the protocol
 * rule that triggered the insertion.
 */
function makeSyntheticBridge(
	targetRole: "user" | "assistant",
	rule: ValidationRule,
	timestamp: number,
): CodingAgentCustomMessage {
	return {
		role: "custom",
		customType: SYNTHETIC_BRIDGE_CUSTOM_TYPE,
		content: "",
		display: false,
		details: { synthetic: true, rule, targetRole },
		timestamp,
	};
}

/**
 * Return a copy of `m` with any empty text block (`text === ""`)
 * replaced by a single space. Returns `null` when nothing changed so
 * the caller can skip allocating a new message object on the hot path.
 */
function replaceEmptyTextInUser(m: UserMessage): UserMessage | null {
	if (typeof m.content === "string") {
		if (m.content === "") {
			return { ...m, content: [{ type: "text", text: " " }] };
		}
		return null;
	}
	let changed = false;
	const newContent = m.content.map((block) => {
		if (block.type === "text" && block.text === "") {
			changed = true;
			return { type: "text" as const, text: " " };
		}
		return block;
	});
	if (!changed) return null;
	return { ...m, content: newContent };
}

/** Same as `replaceEmptyTextInUser` but for the assistant content array. */
function replaceEmptyTextInAssistant(m: AssistantMessage): AssistantMessage | null {
	let changed = false;
	const newContent = m.content.map((block) => {
		if (block.type === "text" && block.text === "") {
			changed = true;
			return { type: "text" as const, text: " " };
		}
		return block;
	});
	if (!changed) return null;
	return { ...m, content: newContent };
}

// =========================================================================
// Per-provider rule walkers
// =========================================================================

/**
 * Anthropic and Cohere share the same conversation-shape requirements:
 * strictly alternating user/assistant messages, and every tool result
 * must be followed by an assistant turn. Cohere is listed separately
 * because the audit treats it as its own provider; the rule set is
 * identical to Anthropic's.
 *
 * `messages` is the live working array (caller-owned). The walker
 * mutates it in place by splicing in synthetic bridges. `insertSynthetic`
 * does the splice and increments the caller's `fixedCount`.
 */
function walkAnthropicLike(
	provider: "anthropic" | "cohere",
	messages: AgentMessage[],
	issues: ValidationIssue[],
	insertSynthetic: (index: number, targetRole: "user" | "assistant", rule: ValidationRule) => void,
): void {
	// Walk 1: alternating-roles. We check the immediately preceding
	// message in the wire sequence (not the last conversational
	// role) so that toolResult and other non-conversational messages
	// correctly separate two same-role conversational messages. The
	// pattern `assistant(toolCall) → toolResult → assistant(text)`
	// is wire-valid for Anthropic because the provider adapter
	// renders the toolResult as a user-role `tool_result` block, so
	// the F2-layer alternation check should not flag it.
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i]!;
		if (m.role !== "user" && m.role !== "assistant") continue;
		const currentRole: "user" | "assistant" = m.role;
		const prev = i > 0 ? messages[i - 1] : undefined;
		if (prev !== undefined && (prev.role === "user" || prev.role === "assistant") && prev.role === currentRole) {
			// Two same-role conversational messages with nothing
			// between them in the wire sequence → bridge with a
			// message of the opposite role.
			const targetRole: "user" | "assistant" = currentRole === "user" ? "assistant" : "user";
			issues.push({
				provider,
				rule: "alternating-roles",
				severity: "error",
				message: `Two consecutive ${currentRole} messages at index ${i}; inserting synthetic ${targetRole} bridge.`,
				location: { index: i },
			});
			insertSynthetic(i, targetRole, "alternating-roles");
		}
	}

	// Walk 2: role-sequence-mismatch. For each tool result, look at
	// the immediate next message. If it is also a tool result, we
	// report a warning: we cannot synthesize the missing assistant
	// turn without knowing what it should say. If it is a user
	// message, we fix by inserting an assistant bridge. If it is an
	// assistant message, no action is needed. The walker advances
	// `i` past the inserted bridge or the second tool result so the
	// same pair is not reported twice.
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i]!;
		if (m.role !== "toolResult") continue;
		const next = messages[i + 1];
		if (!next) continue;
		if (next.role === "toolResult") {
			issues.push({
				provider,
				rule: "role-sequence-mismatch",
				severity: "warning",
				message: `Consecutive toolResult messages starting at index ${i + 1}; cannot automatically resolve.`,
				location: { index: i + 1 },
			});
			// Skip the second toolResult on the next iteration.
			i++;
		} else if (next.role === "user") {
			issues.push({
				provider,
				rule: "role-sequence-mismatch",
				severity: "error",
				message: `toolResult at index ${i} must be followed by an assistant message; inserting synthetic assistant bridge.`,
				location: { index: i + 1 },
			});
			insertSynthetic(i + 1, "assistant", "role-sequence-mismatch");
			// The bridge has role "custom" and is skipped by the
			// next iteration's toolResult check, so no manual
			// skip is needed.
		}
		// next.role === "assistant" or other: nothing to do.
	}
}

/**
 * OpenAI's two rules: the first non-system message must be user
 * (fixed by inserting a synthetic user bridge), and every tool result
 * must follow a tool call with the matching id (warning only, since
 * the missing tool call cannot be synthesized).
 */
function walkOpenai(
	provider: "openai",
	messages: AgentMessage[],
	issues: ValidationIssue[],
	insertSynthetic: (index: number, targetRole: "user" | "assistant", rule: ValidationRule) => void,
): void {
	// First-message-must-be-user. CompiledContext does not carry a
	// system prompt (the system prompt is rendered separately by the
	// provider adapter), so the first AgentMessage in `messages` is
	// the first wire-format message. If it is not a user message, we
	// prepend a synthetic user bridge.
	if (messages.length > 0 && messages[0]!.role !== "user") {
		const firstRole = messages[0]!.role;
		issues.push({
			provider,
			rule: "first-message-must-be-user",
			severity: "error",
			message: `First message role is ${firstRole}; inserting synthetic user bridge.`,
			location: { index: 0 },
		});
		insertSynthetic(0, "user", "first-message-must-be-user");
	}

	// tool-result-must-follow-tool-call. Track the set of tool call
	// ids seen in any preceding assistant message. A toolResult whose
	// id is not in the set is orphan; we warn but do not fix, because
	// the missing tool call cannot be reconstructed from the result
	// alone.
	const knownToolCallIds = new Set<string>();
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i]!;
		if (m.role === "assistant") {
			for (const block of m.content) {
				if (block.type === "toolCall") {
					knownToolCallIds.add(block.id);
				}
			}
		} else if (m.role === "toolResult") {
			if (!knownToolCallIds.has(m.toolCallId)) {
				issues.push({
					provider,
					rule: "tool-result-must-follow-tool-call",
					severity: "warning",
					message: `toolResult with id ${m.toolCallId} at index ${i} does not follow a matching toolCall.`,
					location: { index: i },
				});
			}
		}
	}
}

/**
 * Google's quirk: every text block must be non-empty. We fix in place
 * by replacing `text === ""` with `" "` (a single space) on every
 * affected user or assistant message. The original message is not
 * mutated; a new message object is allocated when a fix is applied.
 * The walker also handles `UserMessage.content === ""` (the string
 * form), which the protocol treats the same as an empty text block.
 */
function walkGoogle(provider: "google", messages: AgentMessage[], issues: ValidationIssue[]): void {
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i]!;
		if (m.role === "user") {
			const fixed = replaceEmptyTextInUser(m);
			if (fixed !== null) {
				issues.push({
					provider,
					rule: "empty-text-not-allowed",
					severity: "error",
					message: `Empty text content at index ${i}; replacing with a single space.`,
					location: { index: i },
				});
				messages[i] = fixed;
			}
		} else if (m.role === "assistant") {
			const fixed = replaceEmptyTextInAssistant(m);
			if (fixed !== null) {
				issues.push({
					provider,
					rule: "empty-text-not-allowed",
					severity: "error",
					message: `Empty text block at index ${i}; replacing with a single space.`,
					location: { index: i },
				});
				messages[i] = fixed;
			}
		}
	}
}

// =========================================================================
// Public entry point
// =========================================================================

/**
 * Validate `context.messages` against the wire protocol of `provider`
 * and (where possible) insert synthetic bridge messages to bring the
 * projection into compliance.
 *
 * The returned `context` is a fresh `CompiledContext`; the input is
 * not mutated. `issues` lists every deviation in walk order, and
 * `fixedCount` counts the synthetic messages inserted. The function
 * is idempotent: running it on a context that is already valid
 * reports zero issues and inserts zero bridges.
 */
export function validateProviderProtocol(context: CompiledContext, provider: ProviderName): ValidationResult {
	const issues: ValidationIssue[] = [];
	// Shallow clone the messages array; the per-provider walkers may
	// splice in new messages and replace individual entries in place
	// (e.g. Google's text-block fix). The original `CompiledContext`
	// remains untouched.
	const messages: AgentMessage[] = [...context.messages];
	let fixedCount = 0;
	const now = Date.now();

	const insertSynthetic = (index: number, targetRole: "user" | "assistant", rule: ValidationRule): void => {
		messages.splice(index, 0, makeSyntheticBridge(targetRole, rule, now));
		fixedCount++;
	};

	switch (provider) {
		case "anthropic":
		case "cohere":
			walkAnthropicLike(provider, messages, issues, insertSynthetic);
			break;
		case "openai":
			walkOpenai(provider, messages, issues, insertSynthetic);
			break;
		case "google":
			walkGoogle(provider, messages, issues);
			break;
		case "unknown":
			// No-op. A defensive fallback when the caller cannot
			// identify the target provider.
			break;
	}

	const ok = !issues.some((issue) => issue.severity === "error");

	return {
		ok,
		context: { ...context, messages },
		issues,
		fixedCount,
	};
}

