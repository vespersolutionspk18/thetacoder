import type { AgentTool, ToolOutcome } from "@theta/agent-core";
import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { contentIdentity } from "./edit-diff.ts";
import { invalidateFileContentCache } from "./file-content-cache.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { writeRenderers } from "./renderers/write.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
	expectedVersion: Type.Optional(
		Type.String({
			description:
				"Content identity returned in details.contentIdentity from a prior read of an EXISTING file. If supplied, the write is rejected when the on-disk content has changed since that read. Omit (or leave undefined) when writing a new file or when you do not want a precondition check.",
		}),
	),
});

export const writeToolSystemPromptContribution = {
	snippet: "Create or overwrite files",
	guidelines: ["Use write only for new files or complete rewrites."],
} as const;

export type WriteToolInput = Static<typeof writeSchema>;

/**
 * Structured details attached to a successful write tool result.
 *
 * The agent loop attaches a synthesized {@link ToolOutcome} before any
 * extension handlers run.
 */
export interface WriteToolDetails {
	/** Structured outcome synthesized by the agent loop. */
	outcome?: ToolOutcome;
	/** True when the file existed on disk before the write completed. */
	overwrote?: boolean;
	/**
	 * Content identity of the content written (BOM-stripped, LF-normalized).
	 * Shares the `contentIdentity()` scheme the read tool reports so the F2
	 * change-tracking bridge can record the change via `recordChange`.
	 */
	contentIdentity?: string;
}

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
	/**
	 * Optional read used only for optimistic-concurrency checks when
	 * `expectedVersion` is supplied. When omitted, the write tool falls back
	 * to the local filesystem read.
	 */
	readFile?: (absolutePath: string) => Promise<Buffer>;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
	readFile: (path) => fsReadFile(path),
};

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, WriteToolDetails | undefined> {
	const ops = options?.operations ?? defaultWriteOperations;
	const readFileForVersion = ops.readFile ?? fsReadFile;
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		promptSnippet: writeToolSystemPromptContribution.snippet,
		promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
		parameters: writeSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, content, expectedVersion }: { path: string; content: string; expectedVersion?: string },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);
			const dir = dirname(absolutePath);
			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();

				// Optimistic-concurrency precheck: if expectedVersion is set, verify the
				// current on-disk content matches it. The file may not exist yet, in
				// which case a missing-path error is treated as a stale observation
				// (caller must omit expectedVersion for new files).
				if (expectedVersion !== undefined) {
					let currentVersion: string;
					try {
						const buffer = await readFileForVersion(absolutePath);
						currentVersion = await contentIdentity(buffer.toString("utf-8"));
					} catch {
						throw new Error(
							"Stale observation: file does not exist or could not be read for expectedVersion check. Re-read or omit expectedVersion for new files.",
						);
					}
					throwIfAborted();
					if (currentVersion !== expectedVersion) {
						throw new Error(
							"Stale observation: file was modified since expectedVersion was captured. Re-read the file and retry.",
						);
					}
				}

				// Create parent directories if needed.
				await ops.mkdir(dir);
				throwIfAborted();

				// Write the file contents.
				await ops.writeFile(absolutePath, content);
				throwIfAborted();

				// Drop any cached bytes for this path so the next read serves the
				// freshly-written content instead of pre-write bytes.
				invalidateFileContentCache(absolutePath);

				// Identity of the content written (BOM-stripped, LF-normalized).
				// Reported in details so the F2 change-tracking bridge can record
				// the change via `recordChange`.
				const contentIdentityValue = await contentIdentity(content);
				throwIfAborted();

				return {
					content: [{ type: "text", text: `Successfully wrote to ${path}` }],
					details: { contentIdentity: contentIdentityValue },
				};
			});
		},
		...writeRenderers,
	};
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}

