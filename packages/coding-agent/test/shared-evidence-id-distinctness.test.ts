/**
 * F10 shared evidence — id distinctness.
 *
 * The id is the keystone of the store: two agents that produce the
 * same id for two different payloads would silently overwrite each
 * other's evidence. This test pins that payloads differing in any
 * structural way (kind, primitive value, container shape) produce
 * different ids.
 */

import { describe, expect, it } from "vitest";
import { evidenceId } from "../src/core/repository/shared-evidence.ts";

describe("evidenceId — distinctness", () => {
	it("two different primitive payloads produce different ids", () => {
		expect(evidenceId("file-manifest", 1)).not.toBe(evidenceId("file-manifest", 2));
		expect(evidenceId("file-manifest", "a")).not.toBe(evidenceId("file-manifest", "b"));
		expect(evidenceId("file-manifest", true)).not.toBe(evidenceId("file-manifest", false));
	});

	it("the same payload under a different kind produces a different id", () => {
		// The kind is part of the digest on purpose, so a manifest and a
		// syntax-index with the same content never collide.
		const payload = { shared: true };
		expect(evidenceId("file-manifest", payload)).not.toBe(evidenceId("syntax-index", payload));
		expect(evidenceId("file-content", payload)).not.toBe(evidenceId("compilation-result", payload));
	});

	it("a missing key produces a different id from a present key", () => {
		const a = { root: "/repo" };
		const b = { root: "/repo", entries: 0 };

		expect(evidenceId("file-manifest", a)).not.toBe(evidenceId("file-manifest", b));
	});

	it("a different nested value produces a different id", () => {
		const a = { outer: { inner: 1 } };
		const b = { outer: { inner: 2 } };

		expect(evidenceId("syntax-index", a)).not.toBe(evidenceId("syntax-index", b));
	});

	it("an empty object and a non-empty object produce different ids", () => {
		expect(evidenceId("file-manifest", {})).not.toBe(evidenceId("file-manifest", { x: 1 }));
	});

	it("an array and an object with the same elements produce different ids", () => {
		expect(evidenceId("syntax-index", [1, 2, 3])).not.toBe(evidenceId("syntax-index", { 0: 1, 1: 2, 2: 3 }));
	});

	it("produces a 64-character lowercase hex digest", () => {
		const id = evidenceId("file-manifest", { root: "/repo" });
		expect(id).toMatch(/^[0-9a-f]{64}$/);
	});
});

