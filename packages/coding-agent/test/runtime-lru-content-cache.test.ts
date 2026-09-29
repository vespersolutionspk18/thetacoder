import { describe, expect, it } from "vitest";
import { LruContentCache } from "../src/core/runtime-hotspots.ts";

describe("LruContentCache", () => {
	it("starts empty", () => {
		const cache = new LruContentCache<string, number>({ maxEntries: 3 });
		expect(cache.size()).toBe(0);
		expect(cache.get("nope")).toBeUndefined();
	});

	it("supports basic get/put and reports size", () => {
		const cache = new LruContentCache<string, number>({ maxEntries: 3 });
		cache.put("a", 1);
		cache.put("b", 2);
		expect(cache.size()).toBe(2);
		expect(cache.get("a")).toBe(1);
		expect(cache.get("b")).toBe(2);
		expect(cache.get("c")).toBeUndefined();
	});

	it("overwrites the value when putting the same key twice", () => {
		const cache = new LruContentCache<string, number>({ maxEntries: 3 });
		cache.put("a", 1);
		cache.put("a", 99);
		expect(cache.size()).toBe(1);
		expect(cache.get("a")).toBe(99);
	});

	it("evicts the least-recently-used entry when capacity is exceeded", () => {
		const cache = new LruContentCache<string, number>({ maxEntries: 3 });
		cache.put("a", 1);
		cache.put("b", 2);
		cache.put("c", 3);
		cache.put("d", 4); // Should evict "a".
		expect(cache.size()).toBe(3);
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toBe(2);
		expect(cache.get("c")).toBe(3);
		expect(cache.get("d")).toBe(4);
	});

	it("promotes a hit to most-recently-used, sparing it from the next eviction", () => {
		const cache = new LruContentCache<string, number>({ maxEntries: 3 });
		cache.put("a", 1);
		cache.put("b", 2);
		cache.put("c", 3);
		// Touch "a" so it is now the most-recently-used.
		expect(cache.get("a")).toBe(1);
		cache.put("d", 4); // Should evict "b" (oldest) instead of "a".
		expect(cache.get("a")).toBe(1);
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("c")).toBe(3);
		expect(cache.get("d")).toBe(4);
	});

	it("supports explicit delete and clear", () => {
		const cache = new LruContentCache<string, number>({ maxEntries: 3 });
		cache.put("a", 1);
		cache.put("b", 2);
		cache.delete("a");
		expect(cache.size()).toBe(1);
		expect(cache.get("a")).toBeUndefined();
		cache.clear();
		expect(cache.size()).toBe(0);
		expect(cache.get("b")).toBeUndefined();
	});

	it("rejects non-positive maxEntries at construction", () => {
		expect(() => new LruContentCache<string, number>({ maxEntries: 0 })).toThrow(/positive integer/);
		expect(() => new LruContentCache<string, number>({ maxEntries: -1 })).toThrow(/positive integer/);
		expect(() => new LruContentCache<string, number>({ maxEntries: 1.5 })).toThrow(/positive integer/);
	});
});

