import type { AgentTool, ToolOutcome } from "@theta/agent-core";
import type { Api, ImageContent, Model, TextContent } from "@theta/ai";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from "fs/promises";
import { type Static, Type } from "typebox";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { contentIdentity } from "./edit-diff.ts";
import {
	type FileContentCacheEntry,
	getFileContentCacheEntry,
	invalidateFileContentCache,
	putFileContentCacheEntry,
} from "./file-content-cache.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import { readRenderers } from "./renderers/read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: [
		"Use read to examine files instead of cat or sed.",
		"details.contentIdentity is a precondition token for edit/write. Pass it back as `expectedVersion` on a matching `edit` or `write` to detect concurrent modifications.",
	],
} as const;

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
	/**
	 * Content identity of the text actually delivered to the model (post-truncation).
	 * Pass this back as `expectedVersion` on a matching `edit` or `write` so the tool can
	 * detect concurrent modifications and reject stale operations.
	 */
	contentIdentity?: string;
	/** Structured outcome synthesized by the agent loop. */
	outcome?: ToolOutcome;
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
	/**
	 * Stat the file for freshness verification of cached bytes (mtime/size).
	 * Defaults to `fs/promises.stat`. When omitted, cached entries cannot
	 * be fingerprint-verified and the read tool keeps the historical
	 * trust-the-cache contract (appropriate for remote read operations).
	 */
	stat?: (absolutePath: string) => Promise<{ mtimeMs: number; size: number }>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
	stat: async (path) => {
		const s = await fsStat(path);
		return { mtimeMs: s.mtimeMs, size: s.size };
	},
};

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete. The result includes details.contentIdentity; pass this back as \`expectedVersion\` on a matching \`edit\` or \`write\` to detect concurrent modifications.`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd);
							if (aborted) return;
							// Check if file exists and is readable.
							await ops.access(absolutePath);
							if (aborted) return;
							// Fast path: consult the LRU content cache before touching the disk.
							// The cached entry is only served when its recorded mtime/size
							// fingerprint still matches the disk state â€” the audit's
							// "verify at query boundaries" rule. Mutations via bash or an
							// external editor bypass the invalidation hooks, so the
							// fingerprint check is what prevents serving stale bytes (and a
							// stale `contentIdentity`, which would make subsequent
							// `expectedVersion` edits fail in a loop).
							let cached = getFileContentCacheEntry(absolutePath);
							if (cached !== undefined && ops.stat !== undefined) {
								// Fingerprint verification: mutations via bash or an
								// external editor bypass the invalidation hooks, so
								// the stat check is what prevents serving stale
								// bytes (and a stale `contentIdentity`, which would
								// make subsequent `expectedVersion` edits fail in a
								// loop). Custom operations without a `stat` keep the
								// historical trust-the-cache contract.
								try {
									const disk = await ops.stat(absolutePath);
									const fingerprinted = cached as FileContentCacheEntry;
									if (
										fingerprinted.mtimeMs === undefined ||
										fingerprinted.size === undefined ||
										fingerprinted.mtimeMs !== disk.mtimeMs ||
										fingerprinted.size !== disk.size
									) {
										invalidateFileContentCache(absolutePath);
										cached = undefined;
									}
								} catch {
									// Stat failed (file replaced/removed race): drop the
									// cached entry so the plain readFile below either
									// succeeds with fresh bytes or throws a real error.
									invalidateFileContentCache(absolutePath);
									cached = undefined;
								}
							}
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							if (mimeType) {
								// Read image as binary. The buffer is large and image
								// processing is the dominant cost, so the cache is only
								// used to skip the disk read â€” processImage still runs.
								const buffer = cached ? cached.bytes : await ops.readFile(absolutePath);
								const processed = await processImage(buffer, mimeType, { autoResizeImages });
								if (!processed.ok) {
									let textNote = `Read image file [${mimeType}]\n${processed.message}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [{ type: "text", text: textNote }];
								} else {
									let textNote = `Read image file [${processed.mimeType}]`;
									if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: processed.data, mimeType: processed.mimeType },
									];
								}
							} else {
								// Read text content. Skip the disk read on a cache hit;
								// reuse the cached identity too.
								const buffer = cached ? cached.bytes : await ops.readFile(absolutePath);
								const textContent = buffer.toString("utf-8");
								// Content identity is computed from the raw on-disk bytes (post-truncation of
								// the model's window) so the model can pass it back as `expectedVersion` on
								// a subsequent edit/write. Pass this back as `expectedVersion` on a matching
								// `edit` or `write` to detect concurrent modifications.
								const identity = cached?.hash ?? (await contentIdentity(textContent));
								if (!cached) {
									// Record the disk fingerprint alongside the bytes so the next
									// read can verify freshness (see the cache-consult block above).
									let mtimeMs: number | undefined;
									let size: number | undefined;
									if (ops.stat !== undefined) {
										try {
											const disk = await ops.stat(absolutePath);
											mtimeMs = disk.mtimeMs;
											size = disk.size;
										} catch {
											// Stat raced with a mutation; the entry stays
											// fingerprint-less and the next read re-reads.
										}
									}
									putFileContentCacheEntry(absolutePath, { bytes: buffer, hash: identity, mtimeMs, size });
								}
								const allLines = textContent.split("\n");
								const totalFileLines = allLines.length;
								// Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
								const startLine = offset ? Math.max(0, offset - 1) : 0;
								const startLineDisplay = startLine + 1;
								// Check if offset is out of bounds.
								if (startLine >= allLines.length) {
									throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
								}
								let selectedContent: string;
								let userLimitedLines: number | undefined;
								// If limit is specified by the user, honor it first. Otherwise truncateHead decides.
								if (limit !== undefined) {
									const endLine = Math.min(startLine + limit, allLines.length);
									selectedContent = allLines.slice(startLine, endLine).join("\n");
									userLimitedLines = endLine - startLine;
								} else {
									selectedContent = allLines.slice(startLine).join("\n");
								}
								// Apply truncation, respecting both line and byte limits.
								const truncation = truncateHead(selectedContent);
								let outputText: string;
								if (truncation.firstLineExceedsLimit) {
									// First line alone exceeds the byte limit. Point the model at a bash fallback.
									const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
									outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
									details = { truncation, contentIdentity: identity };
								} else if (truncation.truncated) {
									// Truncation occurred. Build an actionable continuation notice.
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;
									outputText = truncation.content;
									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
									} else {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
									}
									details = { truncation, contentIdentity: identity };
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
									// User-specified limit stopped early, but the file still has more content.
									const remaining = allLines.length - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;
									outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
									details = { contentIdentity: identity };
								} else {
									// No truncation and no remaining user-limited content.
									outputText = truncation.content;
									details = { contentIdentity: identity };
								}
								content = [{ type: "text", text: outputText }];
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: any) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			);
		},
		...readRenderers,
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}

