/**
 * F1 semantic queries — `getDiagnostics` default behaviour.
 *
 * Without any `setMockDiagnostics` call, the mock must return an empty
 * array. This is the audit's explicit requirement: the harness must
 * not silently look like a real adapter that found no problems when
 * in fact no adapter ran. An empty list is the honest default.
 */

import { describe, expect, it } from "vitest";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";

describe("MockSemanticQueryAdapter — getDiagnostics default", () => {
	it("returns an empty array with no injection", async () => {
		const adapter = new MockSemanticQueryAdapter();
		const result = await adapter.getDiagnostics();
		expect(result).toEqual([]);
	});

	it("returns an empty array when options.path is provided and no injection", async () => {
		const adapter = new MockSemanticQueryAdapter();
		const result = await adapter.getDiagnostics({ path: "src/anything.ts" });
		expect(result).toEqual([]);
	});

	it("returns an empty array when includeWarnings is true and no injection", async () => {
		const adapter = new MockSemanticQueryAdapter();
		const result = await adapter.getDiagnostics({ includeWarnings: true });
		expect(result).toEqual([]);
	});

	it("resetForTests clears any previously injected diagnostics", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockDiagnostics([
			{
				relation: "diagnostic",
				file: "src/a.ts",
				line: 1,
				severity: "error",
				message: "x",
				timestamp: 0,
				certainty: "exact",
			},
		]);
		expect(await adapter.getDiagnostics()).toHaveLength(1);
		adapter.resetForTests();
		expect(await adapter.getDiagnostics()).toEqual([]);
	});
});

