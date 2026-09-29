/**
 * F1 `query` tool — SDK wiring.
 *
 * `createCodingToolDefinitionsWithLiveQuery` in `sdk.ts` is the SDK's
 * hook for assembling the default coding tool list with the F1
 * `query` tool wired in. It must:
 *
 *   - call `createCodingToolDefinitions` so the resulting list
 *     includes the F1 `query` tool alongside the built-in coding
 *     tools (read, bash, edit, write);
 *   - pass a LIVE data accessor (`options.query.getData`) through to
 *     that call, so the query tool resolves the current manifest /
 *     syntax index / adapter on every invocation — fresh after a
 *     `live.refresh()`, without rebuilding the tools.
 *
 * The test spies on `createCodingToolDefinitions` to verify the
 * wiring without depending on the tool's internal `execute` logic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveQueryToolData } from "../src/core/repository/query-data.ts";
import { MockSemanticQueryAdapter } from "../src/core/repository/semantic-queries.ts";
import { createCodingToolDefinitionsWithLiveQuery } from "../src/core/sdk.ts";
import * as toolsModule from "../src/core/tools/index.ts";

import { makeTempDir, removeTempDir, touchFile } from "./live-manifest-helpers.ts";

describe("SDK — live query wiring", () => {
	let root: string;

	beforeEach(async () => {
		root = await makeTempDir("query-data-wiring");
		await touchFile(root, "a.ts", "export const a = 1;");
	});

	afterEach(async () => {
		await removeTempDir(root);
		vi.restoreAllMocks();
	});

	it("calls createCodingToolDefinitions with the live data source", async () => {
		const adapter = new MockSemanticQueryAdapter();
		const live = createLiveQueryToolData({ root, adapter });

		const spy = vi.spyOn(toolsModule, "createCodingToolDefinitions");

		const tools = await createCodingToolDefinitionsWithLiveQuery(root, live);

		expect(spy).toHaveBeenCalledTimes(1);
		const call = spy.mock.calls[0];
		expect(call?.[0]).toBe(root);
		const options = call?.[1];
		expect(options?.query).toBeDefined();
		// The wiring is a LIVE accessor, not a frozen snapshot.
		const getData = options?.query?.getData;
		if (typeof getData !== "function") throw new Error("expected a live data source");
		const snapshot = await getData();
		expect(snapshot.semanticAdapter).toBe(adapter);
		// Manifest should contain the file we created.
		const manifestPaths = snapshot.manifest.map((entry) => entry.path);
		expect(manifestPaths).toContain("a.ts");
		// The returned tool list is built from the same live data.
		const toolNames = tools.map((t) => t.name);
		expect(toolNames).toContain("query");
	});

	it("returns a tool list that includes the query tool alongside the built-ins", async () => {
		const live = createLiveQueryToolData({ root });
		const tools = await createCodingToolDefinitionsWithLiveQuery(root, live);
		const names = tools.map((t) => t.name);
		expect(names).toContain("query");
		expect(names).toContain("read");
		expect(names).toContain("bash");
		expect(names).toContain("edit");
		expect(names).toContain("write");
	});

	it("resolves a fresh snapshot at call time (no stale data)", async () => {
		const adapter = new MockSemanticQueryAdapter();
		const live = createLiveQueryToolData({ root, adapter });

		const spy = vi.spyOn(toolsModule, "createCodingToolDefinitions");

		await createCodingToolDefinitionsWithLiveQuery(root, live);
		await live.refresh();
		await createCodingToolDefinitionsWithLiveQuery(root, live);

		expect(spy).toHaveBeenCalledTimes(2);
		const firstGet = spy.mock.calls[0]?.[1]?.query?.getData;
		const secondGet = spy.mock.calls[1]?.[1]?.query?.getData;
		// Both builds are wired to a live accessor (not a frozen
		// snapshot).
		if (typeof firstGet !== "function" || typeof secondGet !== "function") {
			throw new Error("expected live data sources on both calls");
		}

		// The accessor resolves the CURRENT snapshot at call time:
		// after a mutation + refresh it returns a fresh manifest —
		// the previously built snapshot is no longer what's served.
		await touchFile(root, "b.ts", "export const b = 2;");
		await live.refresh();
		const after = await secondGet();
		const afterPaths = after.manifest.map((entry) => entry.path);
		expect(afterPaths).toContain("a.ts");
		expect(afterPaths).toContain("b.ts");
		// The adapter, however, is preserved across rebuilds.
		expect(after.semanticAdapter).toBe(adapter);
	});
});

