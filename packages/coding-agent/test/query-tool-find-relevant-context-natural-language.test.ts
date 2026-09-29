/**
 * F1 `query` tool — `find-relevant-context` intent: natural-language task.
 *
 * Passes a free-form task ("fix the auth bug in user.ts") and asserts
 * the tool produces context items derived from the F1 relevant-context
 * pipeline. With no explicit `options.path`, the tool must rely on the
 * natural-language identifier extractor to seed `hints.keywords` and
 * `hints.explicitSymbols`, then surface the matching files and symbols.
 */

import { describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";
import { createQueryTool } from "../src/core/tools/query.ts";

function makeManifest(): FileManifestEntry[] {
	return [
		{
			path: "src/auth.ts",
			absolutePath: "/abs/src/auth.ts",
			byteLength: 1024,
			language: "typescript",
			package: "@theta/test",
			generated: false,
			ignored: false,
		},
		{
			path: "src/user.ts",
			absolutePath: "/abs/src/user.ts",
			byteLength: 512,
			language: "typescript",
			package: "@theta/test",
			generated: false,
			ignored: false,
		},
		{
			path: "src/payments.ts",
			absolutePath: "/abs/src/payments.ts",
			byteLength: 768,
			language: "typescript",
			package: "@theta/test",
			generated: false,
			ignored: false,
		},
	];
}

function makeIndex(): SymbolEntry[] {
	return [
		{
			kind: "function",
			name: "authenticateUser",
			path: "src/auth.ts",
			startLine: 10,
			endLine: 40,
			language: "typescript",
		},
		{
			kind: "function",
			name: "loadUser",
			path: "src/user.ts",
			startLine: 5,
			endLine: 25,
			language: "typescript",
		},
	];
}

describe("query tool — find-relevant-context (natural-language)", () => {
	it("returns context items for a free-form task mentioning identifiers", async () => {
		const tool = createQueryTool(makeManifest(), makeIndex(), new MockSemanticQueryAdapter());
		const result = await tool.execute("call-1", {
			intent: "find-relevant-context",
			query: "fix the auth bug in user.ts",
		});

		const output = result.details as {
			output: {
				intent: string;
				query: string;
				results: Array<{
					kind: string;
					path: string;
					score: number;
					reasons: string[];
					certainty: string;
				}>;
				truncated: boolean;
				totalCandidates: number;
				uncertainty: "low" | "medium" | "high";
			};
		};

		expect(output.output.intent).toBe("find-relevant-context");
		expect(output.output.query).toBe("fix the auth bug in user.ts");
		expect(output.output.results.length).toBeGreaterThan(0);

		// The natural-language extractor pulls `auth`, `bug`, `user`, `ts`
		// out of the task (skipping the stopword `the` / `in`). Both
		// `src/auth.ts` and `src/user.ts` are surfaced as context items.
		const paths = output.output.results.map((r) => r.path);
		expect(paths).toContain("src/auth.ts");
		expect(paths).toContain("src/user.ts");
	});

	it("maps the result items to kind: 'context-item' with score, reasons, and certainty", async () => {
		const tool = createQueryTool(makeManifest(), makeIndex(), new MockSemanticQueryAdapter());
		const result = await tool.execute("call-2", {
			intent: "find-relevant-context",
			query: "fix the auth bug in user.ts",
		});

		const output = result.details as {
			output: {
				results: Array<{
					kind: string;
					score: number;
					reasons: string[];
					certainty: string;
				}>;
			};
		};

		expect(output.output.results.length).toBeGreaterThan(0);
		for (const item of output.output.results) {
			expect(item.kind).toBe("context-item");
			expect(typeof item.score).toBe("number");
			expect(Array.isArray(item.reasons)).toBe(true);
			expect(item.reasons.length).toBeGreaterThan(0);
			expect(typeof item.certainty).toBe("string");
		}
	});

	it("populates truncated, totalCandidates, and uncertainty fields", async () => {
		const tool = createQueryTool(makeManifest(), makeIndex(), new MockSemanticQueryAdapter());
		const result = await tool.execute("call-3", {
			intent: "find-relevant-context",
			query: "fix the auth bug in user.ts",
		});

		const output = result.details as {
			output: {
				truncated: boolean;
				totalCandidates: number;
				uncertainty: "low" | "medium" | "high";
			};
		};

		expect(typeof output.output.truncated).toBe("boolean");
		expect(typeof output.output.totalCandidates).toBe("number");
		expect(output.output.totalCandidates).toBeGreaterThan(0);
		expect(["low", "medium", "high"]).toContain(output.output.uncertainty);
	});
});

