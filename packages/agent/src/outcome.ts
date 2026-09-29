/**
 * Tool outcome synthesis.
 *
 * Every tool result carries a structured {@link ToolOutcome} in `details.outcome`
 * so the model and downstream telemetry see a typed status instead of having to
 * parse raw text. The synthesizer is tool-aware: it reads the per-tool details
 * it knows about (truncation, exit codes, limit flags, diff presence) and
 * maps them into the common shape.
 *
 * Layer-2 floor (agent-loop) always runs the synthesizer regardless of
 * extensions. Layer-3 (extension `tool_result` handlers) may override the
 * outcome when a handler explicitly returns `details.outcome`.
 */

import type { ImageContent, TextContent } from "@theta/ai";
import type { AgentToolResult, ToolOutcome, ToolOutcomeStatus } from "./types.ts";

export type { ToolOutcome, ToolOutcomeStatus } from "./types.ts";

/**
 * Derive a {@link ToolOutcome} from a tool's final result. The synthesizer
 * reads the tool-specific `details` shape and maps it to the common outcome
 * fields. Callers should attach the result to `result.details.outcome` before
 * any extension `tool_result` handlers run, so handlers can override if they
 * have better information.
 */
export function synthesizeOutcome(toolName: string, result: AgentToolResult<unknown>, isError: boolean): ToolOutcome {
	const details = (result.details ?? {}) as Record<string, unknown>;
	const text = firstText(result.content);

	switch (toolName) {
		case "bash":
		case "powershell":
			return synthesizeShell(toolName, isError, details, text);
		case "edit":
			return synthesizeEdit(isError, details, text);
		case "read":
			return synthesizeRead(isError, details, text, result);
		case "write":
			return synthesizeWrite(isError, details, text);
		case "grep":
			return synthesizeGrep(isError, details, text);
		case "find":
			return synthesizeFind(isError, details, text);
		case "ls":
			return synthesizeLs(isError, details, text);
		default:
			return synthesizeGeneric(toolName, isError, details, text);
	}
}

function synthesizeShell(
	toolName: string,
	isError: boolean,
	details: Record<string, unknown>,
	text: string | undefined,
): ToolOutcome {
	const parser = toolName === "powershell" ? "powershell-spawn" : "shell-spawn";
	const exitStatus = readExitStatus(details, text);
	const truncated = readTruncationFlag(details);
	const parserIdentity = "exact-match";
	const base: Omit<ToolOutcome, "status"> = {
		parserIdentity,
		source: { parser },
		confidence: 0.5,
	};

	if (isError) {
		const aborted = text !== undefined && /\baborted\b/i.test(text);
		const timedOut = text !== undefined && /\btimed out\b/i.test(text);
		const status: ToolOutcomeStatus = aborted ? "cancelled" : "failed";
		const warnings: string[] = [];
		if (timedOut) warnings.push("timeout");
		return {
			...base,
			status,
			exitStatus,
			confidence: exitStatus !== undefined ? 0.9 : 0.5,
			...(warnings.length > 0 ? { warnings } : {}),
			...(text !== undefined ? { rawEvidence: text } : {}),
		};
	}

	if (truncated) {
		return {
			...base,
			status: "incomplete",
			exitStatus,
			source: {
				parser,
				snapshot: readString(details.fullOutputPath),
			},
			confidence: 0.5,
		};
	}

	return {
		...base,
		status: "succeeded",
		exitStatus,
		source: { parser, snapshot: readString(details.fullOutputPath) },
		confidence: 1,
	};
}

function synthesizeEdit(isError: boolean, details: Record<string, unknown>, text: string | undefined): ToolOutcome {
	const parser = "exact-match";
	const parserIdentity = parser;
	const base: Omit<ToolOutcome, "status"> = {
		parserIdentity,
		source: { parser },
		confidence: 0.5,
	};

	if (isError) {
		const message = text ?? "";
		const ambiguous = /\bFound \d+ occurrences\b/.test(message);
		const overlapping = /\boverlap\b/i.test(message);
		const status: ToolOutcomeStatus = ambiguous || overlapping ? "failed" : "failed";
		const confidence = ambiguous ? 0.4 : overlapping ? 0.5 : 0.5;
		return {
			...base,
			status,
			confidence,
			observations: {
				ambiguousMatch: ambiguous,
				overlappingEdits: overlapping,
			},
			...(text !== undefined ? { rawEvidence: text } : {}),
		};
	}

	const diff = typeof details.diff === "string" ? details.diff : undefined;
	const hasDiff = diff !== undefined && diff.length > 0;
	return {
		...base,
		status: hasDiff ? "succeeded" : "unknown",
		confidence: hasDiff ? 1 : 0.5,
		source: { parser, snapshot: typeof details.patch === "string" ? details.patch : undefined },
		observations: {
			patch: typeof details.patch === "string" ? details.patch : undefined,
			firstChangedLine: details.firstChangedLine,
		},
	};
}

function synthesizeRead(
	isError: boolean,
	details: Record<string, unknown>,
	text: string | undefined,
	result: AgentToolResult<unknown>,
): ToolOutcome {
	const parser = "node-fs";
	const parserIdentity = parser;
	const base: Omit<ToolOutcome, "status"> = {
		parserIdentity,
		source: { parser },
		confidence: 0.5,
	};

	const truncation = details.truncation as { truncated?: boolean; firstLineExceedsLimit?: boolean } | undefined;
	const firstLineExceedsLimit = truncation?.firstLineExceedsLimit === true;
	const truncated = truncation?.truncated === true;
	const hasImage = result.content.some((c) => (c as ImageContent).type === "image");

	if (isError) {
		const status: ToolOutcomeStatus = firstLineExceedsLimit ? "incomplete" : "failed";
		return {
			...base,
			status,
			confidence: 0.5,
			observations: { firstLineExceedsLimit },
			...(text !== undefined ? { rawEvidence: text } : {}),
		};
	}

	if (firstLineExceedsLimit) {
		return {
			...base,
			status: "incomplete",
			confidence: 0.5,
			observations: { firstLineExceedsLimit: true },
		};
	}

	const hasText = text !== undefined && text.length > 0;
	if (truncated) {
		return {
			...base,
			status: "incomplete",
			confidence: 0.5,
			observations: { truncated: true },
		};
	}

	if (!hasText && !hasImage) {
		return {
			...base,
			status: "incomplete",
			confidence: 0.5,
			observations: { emptyContent: true },
		};
	}

	return {
		...base,
		status: "succeeded",
		confidence: 1,
		observations: hasImage ? { image: true } : undefined,
	};
}

function synthesizeWrite(isError: boolean, details: Record<string, unknown>, text: string | undefined): ToolOutcome {
	const parser = "node-fs";
	const parserIdentity = parser;
	const base: Omit<ToolOutcome, "status"> = {
		parserIdentity,
		source: { parser },
		confidence: 0.5,
	};

	if (isError) {
		return {
			...base,
			status: "failed",
			confidence: 0.5,
			...(text !== undefined ? { rawEvidence: text } : {}),
		};
	}

	return {
		...base,
		status: "succeeded",
		confidence: 1,
		observations: {
			overwrote: details.overwrote === true,
		},
	};
}

function synthesizeGrep(isError: boolean, details: Record<string, unknown>, text: string | undefined): ToolOutcome {
	const parser = "rg";
	const parserIdentity = parser;
	const base: Omit<ToolOutcome, "status"> = {
		parserIdentity,
		source: { parser },
		confidence: 0.5,
	};

	const matchLimitReached = typeof details.matchLimitReached === "number" ? details.matchLimitReached : undefined;
	const linesTruncated = details.linesTruncated === true;
	const truncated = readTruncationFlag(details);
	const matches = countMatches(text);

	if (isError) {
		return {
			...base,
			status: "failed",
			confidence: 0.5,
			observations: { matches: 0 },
			...(text !== undefined ? { rawEvidence: text } : {}),
		};
	}

	const observations: Record<string, unknown> = { matches };
	if (matchLimitReached !== undefined) observations.matchLimitReached = matchLimitReached;
	if (linesTruncated) observations.linesTruncated = true;
	if (truncated) observations.truncated = true;

	const partialResults = matchLimitReached !== undefined || truncated || linesTruncated;
	if (partialResults) observations.partialResults = true;

	return {
		...base,
		status: "succeeded",
		confidence: partialResults ? 0.5 : 0.9,
		observations,
	};
}

function synthesizeFind(isError: boolean, details: Record<string, unknown>, text: string | undefined): ToolOutcome {
	const parser = "fd";
	const parserIdentity = parser;
	const base: Omit<ToolOutcome, "status"> = {
		parserIdentity,
		source: { parser },
		confidence: 0.5,
	};

	const resultLimitReached = typeof details.resultLimitReached === "number" ? details.resultLimitReached : undefined;
	const truncated = readTruncationFlag(details);

	if (isError) {
		return {
			...base,
			status: "failed",
			confidence: 0.5,
			observations: { results: 0 },
			...(text !== undefined ? { rawEvidence: text } : {}),
		};
	}

	const observations: Record<string, unknown> = { results: countLines(text) };
	if (resultLimitReached !== undefined) observations.resultLimitReached = resultLimitReached;
	if (truncated) observations.truncated = true;

	const partialResults = resultLimitReached !== undefined || truncated;
	if (partialResults) observations.partialResults = true;

	return {
		...base,
		status: "succeeded",
		confidence: partialResults ? 0.5 : 0.9,
		observations,
	};
}

function synthesizeLs(isError: boolean, details: Record<string, unknown>, text: string | undefined): ToolOutcome {
	const parser = "node-fs";
	const parserIdentity = parser;
	const base: Omit<ToolOutcome, "status"> = {
		parserIdentity,
		source: { parser },
		confidence: 0.5,
	};

	const entryLimitReached = typeof details.entryLimitReached === "number" ? details.entryLimitReached : undefined;
	const truncated = readTruncationFlag(details);
	const empty = text !== undefined && /empty directory/i.test(text);

	if (isError) {
		return {
			...base,
			status: "failed",
			confidence: 0.5,
			observations: { entries: 0 },
			...(text !== undefined ? { rawEvidence: text } : {}),
		};
	}

	const observations: Record<string, unknown> = { entries: empty ? 0 : countLines(text) };
	if (entryLimitReached !== undefined) observations.entryLimitReached = entryLimitReached;
	if (truncated) observations.truncated = true;
	if (empty) observations.emptyDirectory = true;

	const partialResults = entryLimitReached !== undefined || truncated;
	if (partialResults) observations.partialResults = true;

	return {
		...base,
		status: "succeeded",
		confidence: partialResults ? 0.5 : 0.9,
		observations,
	};
}

function synthesizeGeneric(
	toolName: string,
	isError: boolean,
	details: Record<string, unknown>,
	text: string | undefined,
): ToolOutcome {
	const parser = details?.parser as string | undefined;
	const base: Omit<ToolOutcome, "status"> = {
		parserIdentity: parser ?? "unknown",
		source: { parser },
		confidence: 0.5,
		observations: { toolName },
	};

	if (isError) {
		return {
			...base,
			status: "failed",
			confidence: 0.5,
			...(text !== undefined ? { rawEvidence: text } : {}),
		};
	}

	return {
		...base,
		status: "succeeded",
		confidence: 0.9,
	};
}

function firstText(content: AgentToolResult<unknown>["content"]): string | undefined {
	for (const block of content) {
		if ((block as TextContent).type === "text" && typeof (block as TextContent).text === "string") {
			return (block as TextContent).text;
		}
	}
	return undefined;
}

function readExitStatus(details: Record<string, unknown>, text: string | undefined): number | undefined {
	if (typeof details.exitStatus === "number") return details.exitStatus;
	if (typeof details.exitCode === "number") return details.exitCode;
	if (text === undefined) return undefined;
	const match = /exited with code (\d+)/.exec(text);
	if (match) {
		const parsed = Number.parseInt(match[1], 10);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readTruncationFlag(details: Record<string, unknown>): boolean {
	const truncation = details.truncation as { truncated?: unknown } | undefined;
	return truncation?.truncated === true;
}

function countMatches(text: string | undefined): number {
	if (text === undefined) return 0;
	const lines = text.split("\n");
	let count = 0;
	for (const line of lines) {
		// Grep emits "path:lineno:match" or "path-lineno-match" form.
		if (/:\d+:/.test(line) || /-\d+-/.test(line)) count++;
	}
	return count;
}

function countLines(text: string | undefined): number {
	if (text === undefined || text.length === 0) return 0;
	return text.split("\n").length;
}

