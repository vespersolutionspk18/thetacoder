/**
 * F1 semantic queries — `getDiagnostics` mock injection.
 *
 * `setMockDiagnostics([...])` injects a deterministic list of
 * diagnostics. The subsequent `getDiagnostics()` call must return that
 * list, apply the `path` and `includeWarnings` filters correctly, and
 * record a `"diagnostic"` entry in the query log.
 */

import { describe, expect, it } from "vitest";
import { type DiagnosticResult, MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";

describe("MockSemanticQueryAdapter — getDiagnostics with injection", () => {
	it("returns the injected diagnostics verbatim on the next call (errors only by default)", async () => {
		const adapter = new MockSemanticQueryAdapter();
		const injected: DiagnosticResult[] = [
			{
				relation: "diagnostic",
				file: "src/foo.ts",
				line: 10,
				column: 4,
				code: 2304,
				severity: "error",
				message: "Cannot find name 'foo'.",
				source: "typescript",
				snapshotId: "abc123",
				timestamp: 1_700_000_000_000,
				certainty: "exact",
			},
			{
				relation: "diagnostic",
				file: "src/bar.ts",
				line: 3,
				severity: "warning",
				message: "Unused variable.",
				source: "typescript",
				snapshotId: "def456",
				timestamp: 1_700_000_000_000,
				certainty: "candidate",
			},
		];
		adapter.setMockDiagnostics(injected);

		// Default: warnings filtered out.
		const errorsOnly = await adapter.getDiagnostics();
		expect(errorsOnly).toHaveLength(1);
		expect(errorsOnly[0]?.file).toBe("src/foo.ts");
		expect(errorsOnly[0]?.code).toBe(2304);
		expect(errorsOnly[0]?.severity).toBe("error");

		// With includeWarnings: both returned.
		const all = await adapter.getDiagnostics({ includeWarnings: true });
		expect(all).toHaveLength(2);
		expect(all[0]?.file).toBe("src/foo.ts");
		expect(all[1]?.file).toBe("src/bar.ts");
		expect(all[1]?.severity).toBe("warning");
	});

	it("filters out warning severity by default", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockDiagnostics([
			{
				relation: "diagnostic",
				file: "src/a.ts",
				line: 1,
				severity: "error",
				message: "boom",
				timestamp: 0,
				certainty: "exact",
			},
			{
				relation: "diagnostic",
				file: "src/b.ts",
				line: 2,
				severity: "warning",
				message: "soft",
				timestamp: 0,
				certainty: "candidate",
			},
		]);

		const errors = await adapter.getDiagnostics();
		expect(errors).toHaveLength(1);
		expect(errors[0]?.file).toBe("src/a.ts");

		const all = await adapter.getDiagnostics({ includeWarnings: true });
		expect(all).toHaveLength(2);
	});

	it("filters by path when options.path is provided", async () => {
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
			{
				relation: "diagnostic",
				file: "src/b.ts",
				line: 2,
				severity: "error",
				message: "y",
				timestamp: 0,
				certainty: "exact",
			},
		]);

		const onlyA = await adapter.getDiagnostics({ path: "src/a.ts" });
		expect(onlyA).toHaveLength(1);
		expect(onlyA[0]?.file).toBe("src/a.ts");
	});

	it("returns a defensive copy so external mutation does not leak into the mock", async () => {
		const adapter = new MockSemanticQueryAdapter();
		const original: DiagnosticResult[] = [
			{
				relation: "diagnostic",
				file: "src/foo.ts",
				line: 1,
				severity: "error",
				message: "x",
				timestamp: 0,
				certainty: "exact",
			},
		];
		adapter.setMockDiagnostics(original);

		const first = await adapter.getDiagnostics();
		// Mutate the returned array.
		(first as DiagnosticResult[]).length = 0;
		const second = await adapter.getDiagnostics();
		expect(second).toHaveLength(1);
	});

	it("records a 'diagnostic' entry in the query log", async () => {
		const adapter = new MockSemanticQueryAdapter();
		adapter.setMockDiagnostics([]);
		await adapter.getDiagnostics();
		const log = adapter.getQueryLog();
		expect(log.some((entry) => entry.relation === "diagnostic")).toBe(true);
	});
});

