/**
 * F10 shared evidence — id stability across object identity.
 *
 * `evidenceId(kind, payload)` must produce the same digest for two
 * structurally equal payloads regardless of:
 *   - object reference (two `{}` literals are not the same reference),
 *   - key insertion order (`{a:1,b:2}` vs `{b:2,a:1}`),
 *   - nested key order at any depth.
 *
 * The point is that two agents can independently compute the same id
 * for the same logical fact without coordinating.
 */

import { describe, expect, it } from "vitest";
import { evidenceId } from "../src/core/repository/shared-evidence.ts";

describe("evidenceId — stability", () => {
	it("returns the same id for two distinct object references with equal content", () => {
		const a = { root: "/repo", entries: 42 };
		const b = { root: "/repo", entries: 42 };

		expect(evidenceId("file-manifest", a)).toBe(evidenceId("file-manifest", b));
	});

	it("ignores object key insertion order", () => {
		const a = { root: "/repo", count: 1, name: "x" };
		const b = { name: "x", count: 1, root: "/repo" };

		expect(evidenceId("syntax-index", a)).toBe(evidenceId("syntax-index", b));
	});

	it("ignores nested object key insertion order", () => {
		const a = { outer: { z: 1, a: 2, m: 3 }, tail: true };
		const b = { tail: true, outer: { m: 3, a: 2, z: 1 } };

		expect(evidenceId("reference-result", a)).toBe(evidenceId("reference-result", b));
	});

	it("treats arrays as ordered sequences (order matters)", () => {
		const a = { items: [1, 2, 3] };
		const b = { items: [3, 2, 1] };

		expect(evidenceId("syntax-index", a)).not.toBe(evidenceId("syntax-index", b));
	});

	it("treats null and undefined properties as equivalent to missing keys", () => {
		const a = { root: "/r", extras: undefined };
		const b = { root: "/r" };

		expect(evidenceId("file-manifest", a)).toBe(evidenceId("file-manifest", b));
	});

	it("normalizes Map insertion order", () => {
		const a = new Map<string, number>([
			["x", 1],
			["y", 2],
		]);
		const b = new Map<string, number>([
			["y", 2],
			["x", 1],
		]);

		expect(evidenceId("file-manifest", a)).toBe(evidenceId("file-manifest", b));
	});

	it("normalizes Set insertion order", () => {
		const a = new Set([1, 2, 3]);
		const b = new Set([3, 1, 2]);

		expect(evidenceId("syntax-index", a)).toBe(evidenceId("syntax-index", b));
	});
});

