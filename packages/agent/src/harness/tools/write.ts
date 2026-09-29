import { type Static, Type } from "typebox";
import type { ToolOutcome } from "../../types.ts";
import type { AgentHarnessTool } from "../types.ts";
import { getOrThrow } from "../types.ts";
import { contentIdentity } from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToolPath } from "./path-utils.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

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

export type WriteToolInput = Static<typeof writeSchema>;

/**
 * Structured details attached to a successful write tool result.
 *
 * The write tool itself returns `undefined` from `execute()`. The agent loop
 * attaches a synthesized {@link ToolOutcome} before any extension handlers run.
 */
export interface WriteToolDetails {
	/** Structured outcome synthesized by the agent loop. */
	outcome?: ToolOutcome;
	/** True when the file existed on disk before the write completed. */
	overwrote?: boolean;
	/**
	 * Content identity of the content written (BOM-stripped, LF-normalized).
	 * Mirrors the normal-path write tool so consumers can record the change
	 * and verify freshness.
	 */
	contentIdentity?: string;
}

export function createWriteTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof writeSchema,
	WriteToolDetails | undefined
> {
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: writeSchema,
		async execute(_toolCallId, { path, content, expectedVersion }, _onUpdate, { env }, _invocation, context) {
			const absolutePath = await resolveToolPath(env, path, context);
			return withFileMutationQueue(
				env,
				absolutePath,
				async () => {
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");

					// Optimistic-concurrency precheck: if expectedVersion is set, verify the
					// current on-disk content matches it. The file may not exist yet, in
					// which case a missing-path error is treated as a stale observation
					// (caller must omit expectedVersion for new files).
					if (expectedVersion !== undefined) {
						const readResult = await env.readTextFile(absolutePath, context);
						if (!readResult.ok) {
							throw new Error(
								"Stale observation: file does not exist or could not be read for expectedVersion check. Re-read or omit expectedVersion for new files.",
							);
						}
						if (context.abortSignal?.aborted) throw new Error("Operation aborted");
						const currentVersion = await contentIdentity(readResult.value);
						if (currentVersion !== expectedVersion) {
							throw new Error(
								"Stale observation: file was modified since expectedVersion was captured. Re-read the file and retry.",
							);
						}
					}

					getOrThrow(await env.writeFile(absolutePath, content, context));
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");
					// Identity of the content written (BOM-stripped, LF-normalized).
					// Mirrors the normal-path write tool so consumers can record the
					// change and verify freshness.
					const contentIdentityValue = await contentIdentity(content);
					return {
						content: [{ type: "text", text: `Successfully wrote to ${path}` }],
						details: { contentIdentity: contentIdentityValue },
					};
				},
				context,
			);
		},
	};
}

