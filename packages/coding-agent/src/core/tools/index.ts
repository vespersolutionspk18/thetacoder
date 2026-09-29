export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export {
	createF1ReadOnlyToolDefinitions,
	type F1ReadOnlyToolOptions,
} from "./f1-readonly.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createLocalPowerShellOperations,
	createPowerShellTool,
	createPowerShellToolDefinition,
	type PowerShellOperations,
	type PowerShellSpawnContext,
	type PowerShellSpawnHook,
	type PowerShellToolDetails,
	type PowerShellToolInput,
	type PowerShellToolOptions,
} from "./powershell.ts";
export {
	type CreateQueryToolOptions,
	createQueryTool,
	type QueryToolDataSnapshot,
	type QueryToolDataSource,
	type QueryToolDetails,
	type QueryToolInput,
	type QueryToolInputOptions,
	type QueryToolIntent,
	type QueryToolOutput,
	type QueryToolResultItem,
	queryToolSystemPromptContribution,
} from "./query.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@theta/agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import type { FileManifestEntry } from "../repository/manifest.ts";
import type { SemanticQueryAdapter } from "../repository/semantic-queries.ts";
import type { SymbolEntry } from "../repository/syntax-index.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createF1ReadOnlyToolDefinitions, type F1ReadOnlyToolOptions } from "./f1-readonly.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createPowerShellTool, createPowerShellToolDefinition, type PowerShellToolOptions } from "./powershell.ts";
import { type CreateQueryToolOptions, createQueryTool, type QueryToolDataSnapshot } from "./query.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
]);

/**
 * Data dependency for the `query` tool. Two shapes are accepted:
 *
 *   - **Live source** (preferred for the SDK / session path): a
 *     `getData()` accessor that resolves a fresh
 *     manifest / symbol index / semantic adapter at the start of every
 *     query tool call. Back it with `LiveQueryToolData.getToolData()`
 *     so worktree mutations are reflected in the next query without a
 *     session reload.
 *   - **Frozen snapshot**: explicit arrays captured at factory time.
 *     Kept for callers that manage their own data and for tests.
 *
 * The bundle is passed through `ToolsOptions.query` so the default
 * tool list can include the tool.
 */
export type QueryToolData =
	| {
			manifest: FileManifestEntry[];
			symbolIndex: SymbolEntry[];
			semanticAdapter: SemanticQueryAdapter;
			getData?: undefined;
			options?: CreateQueryToolOptions;
	  }
	| {
			manifest?: undefined;
			symbolIndex?: undefined;
			semanticAdapter?: undefined;
			/**
			 * Resolve a fresh data snapshot at the start of each query
			 * tool invocation. Typically `() => liveQueryToolData.getToolData()`.
			 */
			getData: () => Promise<QueryToolDataSnapshot>;
			options?: CreateQueryToolOptions;
	  };

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	powershell?: PowerShellToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	/**
	 * Data layer for the F1 `query` tool. When provided, the tool is
	 * appended to `createCodingToolDefinitions` / `createCodingTools`.
	 */
	query?: QueryToolData;
	/**
	 * Data layer for the F1 read-only tools (`grep-f1`, `find-f1`,
	 * `ls-f1`). When provided, all three are appended to the readonly
	 * tool list returned by `createReadOnlyToolDefinitions` /
	 * `createReadOnlyTools`. The manifest and symbol index are bound
	 * at construction time; an empty manifest yields empty results
	 * (the caller is responsible for falling back to the original
	 * filesystem-backed tools in that case).
	 */
	f1ReadOnly?: F1ReadOnlyToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "powershell":
			return createPowerShellToolDefinition(cwd, options?.powershell);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "powershell":
			return createPowerShellTool(cwd, options?.powershell);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	const tools: ToolDef[] = [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
	];
	// The F1 `query` tool needs the manifest + syntax index + semantic
	// adapter. When the caller passes that bundle via `options.query`
	// (either a live `getData()` source or a frozen snapshot), we
	// append the tool so the default coding tool list includes it.
	// Without the data, the tool is simply omitted — nothing else in
	// the function is affected.
	if (options?.query) {
		const query = options.query;
		tools.push(
			query.getData !== undefined
				? createQueryTool({ getData: query.getData }, query.options)
				: createQueryTool(query.manifest, query.symbolIndex, query.semanticAdapter, query.options),
		);
	}
	return tools;
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	const tools: ToolDef[] = [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
	];
	// When the F1 data layer is supplied, append the F1-backed
	// read-only tools (`grep-f1`, `find-f1`, `ls-f1`). The tools
	// always query the supplied manifest + symbol index and never
	// touch the filesystem; callers should fall back to the standard
	// tools above when the manifest is empty.
	if (options?.f1ReadOnly) {
		tools.push(...createF1ReadOnlyToolDefinitions(options.f1ReadOnly));
	}
	return tools;
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		powershell: createPowerShellToolDefinition(cwd, options?.powershell),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	const tools: Tool[] = [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
	];
	if (options?.query) {
		const query = options.query;
		tools.push(
			query.getData !== undefined
				? createQueryTool({ getData: query.getData }, query.options)
				: createQueryTool(query.manifest, query.symbolIndex, query.semanticAdapter, query.options),
		);
	}
	return tools;
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	const tools: Tool[] = [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
	];
	if (options?.f1ReadOnly) {
		tools.push(...createF1ReadOnlyToolDefinitions(options.f1ReadOnly));
	}
	return tools;
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		powershell: createPowerShellTool(cwd, options?.powershell),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
	};
}

