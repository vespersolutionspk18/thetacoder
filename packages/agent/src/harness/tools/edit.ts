import { type Static, Type } from "typebox";
import type { ToolOutcome } from "../../types.ts";
import type { AgentHarnessTool, FileError } from "../types.ts";
import {
	applyEditsToNormalizedContent,
	contentIdentity,
	detectLineEnding,
	type Edit,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToolPath } from "./path-utils.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{},
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		}),
		expectedVersion: Type.Optional(
			Type.String({
				description:
					"Content identity returned in details.contentIdentity from a prior read. If supplied and mismatched, the edit is rejected.",
			}),
		),
	},
	{},
);

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & { oldText?: unknown; newText?: unknown };
type SingleEditInput = { oldText: string; newText: string };

function isSingleEditInput(value: unknown): value is SingleEditInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const edit = value as Record<string, unknown>;
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

export interface EditToolDetails {
	diff: string;
	patch: string;
	firstChangedLine?: number;
	/**
	 * Content identity of the resulting file content (the bytes actually
	 * written; BOM-stripped, LF-normalized). Mirrors the normal-path edit
	 * tool so consumers can record the change and verify freshness.
	 */
	contentIdentity?: string;
	/** Structured outcome synthesized by the agent loop. */
	outcome?: ToolOutcome;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") return input as EditToolInput;
	const args = input as Record<string, unknown>;
	if (typeof args.edits === "string") {
		try {
			const parsed: unknown = JSON.parse(args.edits);
			if (Array.isArray(parsed)) {
				args.edits = parsed;
			} else if (isSingleEditInput(parsed)) {
				args.edits = [parsed];
			}
		} catch {}
	} else if (isSingleEditInput(args.edits)) {
		args.edits = [args.edits];
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") return args as EditToolInput;
	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

function editAccessError(path: string, error: FileError): Error {
	return new Error(`Could not edit file: ${path}. Error code: ${error.code}.`, { cause: error });
}

export function createEditTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof editSchema,
	EditToolDetails | undefined
> {
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		parameters: editSchema,
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input, _onUpdate, { env }, _invocation, context) {
			const { path, edits } = validateEditInput(input);
			const expectedVersion = input.expectedVersion;
			const absolutePath = await resolveToolPath(env, path, context);
			return withFileMutationQueue(
				env,
				absolutePath,
				async () => {
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");
					const info = await env.fileInfo(absolutePath, context);
					if (!info.ok) throw editAccessError(path, info.error);
					if (info.value.kind !== "file" && info.value.kind !== "symlink") {
						throw new Error(`Could not edit file: ${path}. Path is not a file.`);
					}

					const readResult = await env.readTextFile(absolutePath, context);
					if (!readResult.ok) throw editAccessError(path, readResult.error);
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");

					// Optimistic-concurrency precheck: reject if the caller supplied a stale identity.
					if (expectedVersion !== undefined) {
						const currentVersion = await contentIdentity(readResult.value);
						if (currentVersion !== expectedVersion) {
							throw new Error(
								"Stale observation: file was modified since expectedVersion was captured. Re-read the file and retry.",
							);
						}
					}

					const { bom, text: content } = stripBom(readResult.value);
					const originalEnding = detectLineEnding(content);
					const normalizedContent = normalizeToLF(content);
					const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");

					const finalContent = bom + restoreLineEndings(newContent, originalEnding);
					const writeResult = await env.writeFile(absolutePath, finalContent, context);
					if (!writeResult.ok) throw editAccessError(path, writeResult.error);
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");

					// Identity of the resulting content (BOM-stripped, LF-normalized).
					// Mirrors the normal-path edit tool so consumers that bridge results
					// into task state can record the change via `recordChange`.
					const contentIdentityValue = await contentIdentity(finalContent);
					const diffResult = generateDiffString(baseContent, newContent);
					return {
						content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
						details: {
							diff: diffResult.diff,
							patch: generateUnifiedPatch(path, baseContent, newContent),
							firstChangedLine: diffResult.firstChangedLine,
							contentIdentity: contentIdentityValue,
						},
					};
				},
				context,
			);
		},
	};
}

