/**
 * F1 `query` tool — `find-relevant-context` intent: uncertainty.
 *
 * When the task is free-form and the manifest / symbol index carry
 * nothing the F1 pipeline can match, the relevant-context bundle is
 * empty and the tool must surface `uncertainty: "high"` so callers know
 * the result is uninformative.
 */

import { describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";
import { createQueryTool } from "../src/core/tools/query.ts";

function makeEmptyManifest(): FileManifestEntry[] {
	return [];
}

function makeEmptyIndex(): SymbolEntry[] {
	return [];
}

function makeUnrelatedManifest(): FileManifestEntry[] {
	// Files whose paths deliberately share no token with the task
	// identifiers. The plain `config/blue.txt` shape avoids the
	// `ts`-in-extension trap that `.ts` paths would introduce.
	return [
		{
			path: "config/blue.txt",
			absolutePath: "/abs/config/blue.txt",
			byteLength: 128,
			language: "plaintext",
			package: "@theta/test",
			generated: false,
			ignored: false,
		},
		{
			path: "config/red.txt",
			absolutePath: "/abs/config/red.txt",
			byteLength: 96,
			language: "plaintext",
			package: "@theta/test",
			generated: false,
			ignored: false,
		},
	];
}

describe("query tool — find-relevant-context (uncertainty)", () => {
	it("reports uncertainty: 'high' for a task with no hints and no symbol matches", async () => {
		const tool = createQueryTool(makeEmptyManifest(), makeEmptyIndex(), new MockSemanticQueryAdapter());
		const result = await tool.execute("call-1", {
			intent: "find-relevant-context",
			query: "do something abstract",
		});

		const output = result.details as {
			output: {
				results: unknown[];
				totalCandidates: number;
				uncertainty: "low" | "medium" | "high";
			};
		};

		// No manifest entries, no symbols, and the natural-language
		// extractor cannot anchor anything — the relevant-context
		// pipeline produces an empty bundle, which the tool surfaces
		// as high uncertainty.
		expect(output.output.results).toEqual([]);
		expect(output.output.totalCandidates).toBe(0);
		expect(output.output.uncertainty).toBe("high");
	});

	it("reports uncertainty: 'high' for a task that resolves to no matches against an unrelated manifest", async () => {
		const tool = createQueryTool(makeUnrelatedManifest(), makeEmptyIndex(), new MockSemanticQueryAdapter());
		const result = await tool.execute("call-2", {
			intent: "find-relevant-context",
			query: "fix the auth bug in user.ts",
		});

		const output = result.details as {
			output: {
				results: Array<{ path: string }>;
				totalCandidates: number;
				uncertainty: "low" | "medium" | "high";
			};
		};

		// Manifest contains `payments/...` paths; the natural-language
		// task only yields `auth`, `bug`, `user`, `ts` — none of which
		// appear in those paths or in an empty symbol index. The
		// bundle is empty and uncertainty is "high".
		expect(output.output.results).toEqual([]);
		expect(output.output.totalCandidates).toBe(0);
		expect(output.output.uncertainty).toBe("high");
	});

	it("does not fabricate a context-item when nothing matches", async () => {
		const tool = createQueryTool(makeEmptyManifest(), makeEmptyIndex(), new MockSemanticQueryAdapter());
		const result = await tool.execute("call-3", {
			intent: "find-relevant-context",
			query: "refactor the deployment pipeline",
		});

		const output = result.details as {
			output: {
				results: Array<{ kind: string }>;
				uncertainty: "low" | "medium" | "high";
			};
		};

		expect(output.output.results).toHaveLength(0);
		expect(output.output.uncertainty).toBe("high");
	});
});

