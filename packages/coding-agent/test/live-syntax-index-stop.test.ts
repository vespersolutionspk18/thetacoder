/**
 * F1 live syntax index — `stop()` halts the underlying watcher.
 *
 * After `stop()` returns, the underlying `FileWatcher.stop()` must
 * have been invoked. Subsequent events delivered by the watcher must
 * not affect the live index, because the subscription has been torn
 * down.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveSyntaxIndex } from "../src/core/repository/live-syntax-index.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";

import { makeFakeWatcher, makeTempDir, removeTempDir, touchFile } from "./live-syntax-index-helpers.ts";

describe("createLiveSyntaxIndex — stop", () => {
	let root: string;
	let fake: ReturnType<typeof makeFakeWatcher>;

	beforeEach(async () => {
		root = await makeTempDir("live-syntax-index-stop");
		await touchFile(root, "a.ts", "export const a = 1;");
		fake = makeFakeWatcher();
	});

	afterEach(async () => {
		await removeTempDir(root);
	});

	it("calls the underlying watcher's stop() exactly once", () => {
		const live = createLiveSyntaxIndex({
			index: [{ kind: "variable", name: "a", path: "a.ts", startLine: 1, endLine: 1, language: "typescript" }],
			watcher: fake.watcher,
			root,
		});

		expect(fake.stopCalls).toBe(0);
		live.stop();
		// The underlying watcher's stop() is async; give it a tick to run.
		return new Promise<void>((resolveFn) => {
			const check = () => {
				if (fake.stopCalls >= 1) {
					expect(fake.stopCalls).toBe(1);
					resolveFn();
					return;
				}
				setTimeout(check, 5);
			};
			check();
		});
	});

	it("is idempotent — calling stop() twice does not re-invoke watcher.stop()", async () => {
		const live = createLiveSyntaxIndex({
			index: [],
			watcher: fake.watcher,
			root,
		});

		live.stop();
		live.stop();
		await new Promise((r) => setTimeout(r, 20));
		expect(fake.stopCalls).toBe(1);
	});

	it("detaches the watcher subscription so further events are ignored", async () => {
		await touchFile(root, "before.ts", "export const before = 1;");

		const live = createLiveSyntaxIndex({
			index: [
				{
					kind: "variable",
					name: "before",
					path: "before.ts",
					startLine: 1,
					endLine: 1,
					language: "typescript",
				},
			],
			watcher: fake.watcher,
			root,
		});

		live.stop();

		// Even though we fire a change event after stop(), the entry
		// must not be re-extracted because the handler is detached.
		await fake.fire({ kind: "change", path: "before.ts", timestamp: 1 });

		const syms = live.getSymbolsForFile("before.ts");
		expect(syms.map((s) => s.name)).toEqual(["before"]);
	});

	it("retains the seeded index after stop()", () => {
		const seed: SymbolEntry[] = [
			{ kind: "variable", name: "a", path: "a.ts", startLine: 1, endLine: 1, language: "typescript" },
		];
		const live = createLiveSyntaxIndex({
			index: seed,
			watcher: fake.watcher,
			root,
		});
		live.stop();
		expect(live.getSymbols().map((s) => s.name)).toEqual(["a"]);
	});
});

