/**
 * F1 `query` tool — get-definition intent.
 *
 * Mocks a definition result and asserts the tool returns it as a
 * single context-item with `score: 1.0` and `certainty: "exact"`.
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
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		},
	];
}

describe("query tool — get-definition", () => {
	it("returns the first definition location as a single context-item", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockResult("definition", "Foo", {
			relation: "definition",
			symbol: "Foo",
			locations: [
				{ path: "src/foo.ts", startLine: 10, endLine: 20 },
				{ path: "src/foo.ts", startLine: 30, endLine: 40 },
			],
			certainty: "exact",
		});

		const tool = createQueryTool(makeManifest(), [], adapter);
		const result = await tool.execute("call-1", { intent: "get-definition", query: "Foo" });

		const output = result.details as {
			output: {
				results: Array<{
					kind: string;
					path: string;
					startLine?: number;
					endLine?: number;
					score: number;
					certainty: string;
				}>;
				uncertainty: string;
			};
		};
		expect(output.output.results.length).toBe(1);
		const item = output.output.results[0];
		expect(item.kind).toBe("context-item");
		expect(item.path).toBe("src/foo.ts");
		expect(item.startLine).toBe(10);
		expect(item.endLine).toBe(20);
		expect(item.score).toBe(1.0);
		expect(item.certainty).toBe("exact");
		expect(output.output.uncertainty).toBe("low");
	});

	it("returns an empty result with high uncertainty when the mock has no injection", async () => {
		// Default mock returns `certainty: "unknown"` and empty locations.
		const adapter = new MockSemanticQueryAdapter();
		const tool = createQueryTool(makeManifest(), [], adapter);
		const result = await tool.execute("call-2", { intent: "get-definition", query: "Bar" });

		const output = result.details as {
			output: { results: unknown[]; uncertainty: string };
		};
		expect(output.output.results.length).toBe(0);
		expect(output.output.uncertainty).toBe("high");
	});
});

