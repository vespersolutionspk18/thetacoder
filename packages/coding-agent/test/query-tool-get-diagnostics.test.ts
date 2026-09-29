/**
 * F1 `query` tool — `get-diagnostics` intent.
 *
 * Uses `MockSemanticQueryAdapter.setMockDiagnostics` to inject
 * deterministic findings, then asserts the tool maps them to
 * `kind: "diagnostic"` results with severity, code, message, source,
 * snapshot, and timestamp preserved.
 */

import { describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";
import { createQueryTool } from "../src/core/tools/query.ts";

function makeManifest(): FileManifestEntry[] {
	return [
		{
			path: "src/a.ts",
			absolutePath: "/abs/src/a.ts",
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		},
		{
			path: "src/b.ts",
			absolutePath: "/abs/src/b.ts",
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		},
	];
}

describe("query tool — get-diagnostics", () => {
	it("returns injected diagnostics mapped to kind: 'diagnostic'", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockDiagnostics([
			{
				relation: "diagnostic",
				file: "src/a.ts",
				line: 5,
				column: 3,
				code: 2322,
				severity: "error",
				message: "Type 'string' is not assignable to type 'number'.",
				source: "typescript",
				snapshotId: "snap-a",
				timestamp: 1_700_000_000_000,
				certainty: "exact",
			},
		]);
		const tool = createQueryTool(makeManifest(), [], adapter);
		const result = await tool.execute("call-1", { intent: "get-diagnostics", query: "any" });

		const output = result.details as {
			output: {
				intent: string;
				results: Array<{
					kind: string;
					path: string;
					line: number;
					severity: string;
					code?: number | string;
					message: string;
					source?: string;
					snapshotId?: string;
					timestamp: number;
					certainty: string;
				}>;
				uncertainty: string;
			};
		};
		expect(output.output.intent).toBe("get-diagnostics");
		expect(output.output.results).toHaveLength(1);
		const item = output.output.results[0];
		expect(item.kind).toBe("diagnostic");
		expect(item.path).toBe("src/a.ts");
		expect(item.line).toBe(5);
		expect(item.severity).toBe("error");
		expect(item.code).toBe(2322);
		expect(item.message).toMatch(/not assignable/);
		expect(item.source).toBe("typescript");
		expect(item.snapshotId).toBe("snap-a");
		expect(item.timestamp).toBe(1_700_000_000_000);
		expect(item.certainty).toBe("exact");
		expect(output.output.uncertainty).toBe("low");
	});

	it("returns an empty result list when the adapter has no diagnostics", async () => {
		const adapter = new MockSemanticQueryAdapter();
		const tool = createQueryTool(makeManifest(), [], adapter);
		const result = await tool.execute("call-2", { intent: "get-diagnostics", query: "any" });

		const output = result.details as {
			output: { intent: string; results: unknown[]; uncertainty: string };
		};
		expect(output.output.intent).toBe("get-diagnostics");
		expect(output.output.results).toEqual([]);
		expect(output.output.uncertainty).toBe("low");
	});

	it("filters out warnings by default unless includeWarnings is set", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockDiagnostics([
			{
				relation: "diagnostic",
				file: "src/a.ts",
				line: 1,
				severity: "error",
				message: "err",
				timestamp: 0,
				certainty: "exact",
			},
			{
				relation: "diagnostic",
				file: "src/b.ts",
				line: 2,
				severity: "warning",
				message: "warn",
				timestamp: 0,
				certainty: "candidate",
			},
		]);
		const tool = createQueryTool(makeManifest(), [], adapter);

		const errorsOnly = await tool.execute("call-3", {
			intent: "get-diagnostics",
			query: "any",
		});
		const errorsOutput = errorsOnly.details as { output: { results: Array<{ severity: string }> } };
		expect(errorsOutput.output.results).toHaveLength(1);
		expect(errorsOutput.output.results[0]?.severity).toBe("error");

		const withWarnings = await tool.execute("call-4", {
			intent: "get-diagnostics",
			query: "any",
			options: { includeWarnings: true },
		});
		const allOutput = withWarnings.details as { output: { results: unknown[] } };
		expect(allOutput.output.results).toHaveLength(2);
	});

	it("forwards the path option to the adapter", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockDiagnostics([
			{
				relation: "diagnostic",
				file: "src/a.ts",
				line: 1,
				severity: "error",
				message: "in a",
				timestamp: 0,
				certainty: "exact",
			},
			{
				relation: "diagnostic",
				file: "src/b.ts",
				line: 1,
				severity: "error",
				message: "in b",
				timestamp: 0,
				certainty: "exact",
			},
		]);
		const tool = createQueryTool(makeManifest(), [], adapter);
		const result = await tool.execute("call-5", {
			intent: "get-diagnostics",
			query: "any",
			options: { path: "src/b.ts" },
		});
		const output = result.details as { output: { results: Array<{ path: string }> } };
		expect(output.output.results).toHaveLength(1);
		expect(output.output.results[0]?.path).toBe("src/b.ts");
	});
});

