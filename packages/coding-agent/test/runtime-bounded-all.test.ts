import { describe, expect, it } from "vitest";
import { boundedAll } from "../src/core/runtime-hotspots.ts";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("boundedAll", () => {
	it("returns an empty array for empty input", async () => {
		const results = await boundedAll([], 3, async (n: number) => n * 2);
		expect(results).toEqual([]);
	});

	it("preserves input order in the result array", async () => {
		const items = [3, 1, 4, 1, 5, 9, 2, 6];
		const results = (await boundedAll(items, 4, async (n: number) => {
			// Intentionally sleep a variable amount so completion order != input order.
			await sleep(5 + n);
			return n * 10;
		})) as number[];
		expect(results).toEqual(items.map((n) => n * 10));
	});

	it("caps concurrency at the configured limit (10 tasks, limit=3)", async () => {
		const items = Array.from({ length: 10 }, (_, i) => i);
		let inFlight = 0;
		let maxObserved = 0;
		const results = await boundedAll(items, 3, async (n: number) => {
			inFlight++;
			maxObserved = Math.max(maxObserved, inFlight);
			await sleep(15);
			inFlight--;
			return n;
		});
		expect(maxObserved).toBeLessThanOrEqual(3);
		expect(maxObserved).toBeGreaterThan(0);
		expect(results).toEqual(items);
	});

	it("rejects with the first worker error", async () => {
		const items = [1, 2, 3, 4, 5];
		await expect(
			boundedAll(items, 2, async (n: number) => {
				if (n === 3) throw new Error("boom");
				await sleep(5);
				return n;
			}),
		).rejects.toThrow("boom");
	});

	it("rejects non-positive limits", async () => {
		await expect(boundedAll([1, 2, 3], 0, async (n) => n)).rejects.toThrow(/positive integer/);
		await expect(boundedAll([1, 2, 3], -1, async (n) => n)).rejects.toThrow(/positive integer/);
		await expect(boundedAll([1, 2, 3], 1.5, async (n) => n)).rejects.toThrow(/positive integer/);
	});

	it("works with a limit larger than the number of items", async () => {
		const items = [1, 2, 3];
		const results = (await boundedAll(items, 100, async (n: number) => n + 1)) as number[];
		expect(results).toEqual([2, 3, 4]);
	});
});

