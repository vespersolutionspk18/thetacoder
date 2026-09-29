/**
 * F1 `query` tool — find-relevant-context surfaces diagnostics from
 * the adapter when the user supplies a path hint.
 *
 * The tool must call `semanticAdapter.getDiagnostics({ path })` when
 * `options.path` is set, convert the result to `hints.diagnostics`
 * format, and let `getRelevantContext` surface them as
 * `kind: "diagnostic"` items.
 */

import { describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";
import { createQueryTool } from "../src/core/tools/query.ts";

function makeManifest(): FileManifestEntry[] {
	return [
		{
			path: "src/foo.ts",
			absolutePath: "/abs/src/foo.ts",
			byteLength: 1024,
			language: "typescript",
			package: "@theta/test",
			generated: false,
			ignored: false,
		},
	];
}

describe("query tool — find-relevant-context with path hint surfaces diagnostics", () => {
	it("includes adapter diagnostics in the relevant-context bundle when a path hint is provided", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockDiagnostics([
			{
				relation: "diagnostic",
				file: "src/foo.ts",
				line: 12,
				code: 2304,
				severity: "error",
				message: "Cannot find name 'foo'.",
				timestamp: 1_700_000_000_000,
				certainty: "exact",
			},
		]);

		const tool = createQueryTool(makeManifest(), [], adapter);
		const result = await tool.execute("call-1", {
			intent: "find-relevant-context",
			query: "investigate the build failure",
			options: { path: "src/foo.ts" },
		});

		const output = result.details as {
			output: {
				intent: string;
				results: Array<{ kind: string; path: string; startLine?: number; reasons?: string[]; certainty: string }>;
				uncertainty: string;
			};
		};

		// A diagnostic item should be present in the bundle, mapped to
		// the `context-item` kind by the existing relevant-context
		// mapping, anchored to the diagnostic's file/line.
		const diag = output.output.results.find(
			(r) => r.kind === "context-item" && r.path === "src/foo.ts" && r.startLine === 12,
		);
		expect(diag).toBeDefined();

		// Diagnostics are exact, so the bundle uncertainty should be
		// "low" (alongside the explicit-path match).
		expect(output.output.uncertainty).toBe("low");
	});

	it("does not query the adapter for diagnostics when no path hint is provided", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockDiagnostics([
			{
				relation: "diagnostic",
				file: "src/foo.ts",
				line: 1,
				severity: "error",
				message: "should not surface",
				timestamp: 0,
				certainty: "exact",
			},
		]);

		const tool = createQueryTool(makeManifest(), [], adapter);
		const result = await tool.execute("call-2", {
			intent: "find-relevant-context",
			query: "look at foo",
		});
		const output = result.details as {
			output: { results: Array<{ path: string; startLine?: number }> };
		};
		// The diagnostic was injected but no path hint was passed, so
		// the file/line for the diagnostic should not appear in the
		// result items (it would only match if some other path-hint
		// logic pulled it in).
		const diagnosticLine = output.output.results.find((r) => r.path === "src/foo.ts" && r.startLine === 1);
		expect(diagnosticLine).toBeUndefined();
	});

	it("surfaces a numeric diagnostic in the bundle regardless of the original code type", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockDiagnostics([
			{
				relation: "diagnostic",
				file: "src/foo.ts",
				line: 1,
				code: 2322,
				severity: "error",
				message: "type mismatch",
				timestamp: 0,
				certainty: "exact",
			},
		]);
		const tool = createQueryTool(makeManifest(), [], adapter);
		const result = await tool.execute("call-3", {
			intent: "find-relevant-context",
			query: "type errors",
			options: { path: "src/foo.ts" },
		});
		const output = result.details as {
			output: { results: Array<{ kind: string; path: string; startLine?: number }> };
		};
		// The numeric `code` was coerced to a TS-prefixed string
		// when fed into `hints.diagnostics`; the important end-to-end
		// check is that the diagnostic still appears in the bundle.
		const diag = output.output.results.find(
			(r) => r.kind === "context-item" && r.path === "src/foo.ts" && r.startLine === 1,
		);
		expect(diag).toBeDefined();
	});
});

