/**
 * F2 evidence freshness — read-tool wiring (failure paths).
 *
 * `captureReadResultForFreshness` is intentionally conservative: it
 * updates the `_latestEvidenceHashes` map only when the call looks
 * like a real, trustworthy read. Every other shape — non-`read`
 * tool, error result, missing `contentIdentity`, missing `path`,
 * wrong type — must leave the map untouched so the freshness check
 * keeps reporting the file as `missing` (or whatever the previous
 * state implied) instead of overwriting it with a junk value.
 */

import { describe, expect, it } from "vitest";
import { captureReadResultForFreshness } from "../src/core/evidence-freshness.ts";

describe("F2 evidence freshness — read wiring (failure paths)", () => {
	it("does not update the map when the tool name is not 'read'", () => {
		const latestHashes = new Map<string, string>();
		const updated = captureReadResultForFreshness(latestHashes, {
			toolName: "bash",
			args: { path: "src/a.ts" },
			result: { details: { contentIdentity: "hash-a" } },
			isError: false,
		});

		expect(updated).toBe(false);
		expect(latestHashes.size).toBe(0);
	});

	it("does not update the map when the read result is an error", () => {
		const latestHashes = new Map<string, string>();
		const updated = captureReadResultForFreshness(latestHashes, {
			toolName: "read",
			args: { path: "src/a.ts" },
			result: { details: { contentIdentity: "hash-a" } },
			isError: true,
		});

		expect(updated).toBe(false);
		expect(latestHashes.size).toBe(0);
	});

	it("does not update the map when the result has no details", () => {
		const latestHashes = new Map<string, string>();
		const updated = captureReadResultForFreshness(latestHashes, {
			toolName: "read",
			args: { path: "src/a.ts" },
			result: { details: undefined },
			isError: false,
		});

		expect(updated).toBe(false);
		expect(latestHashes.size).toBe(0);
	});

	it("does not update the map when details.contentIdentity is missing", () => {
		const latestHashes = new Map<string, string>();
		const updated = captureReadResultForFreshness(latestHashes, {
			toolName: "read",
			args: { path: "src/a.ts" },
			result: { details: {} },
			isError: false,
		});

		expect(updated).toBe(false);
		expect(latestHashes.size).toBe(0);
	});

	it("does not update the map when contentIdentity is an empty string", () => {
		const latestHashes = new Map<string, string>();
		const updated = captureReadResultForFreshness(latestHashes, {
			toolName: "read",
			args: { path: "src/a.ts" },
			result: { details: { contentIdentity: "" } },
			isError: false,
		});

		expect(updated).toBe(false);
		expect(latestHashes.size).toBe(0);
	});

	it("does not update the map when args.path is missing", () => {
		const latestHashes = new Map<string, string>();
		const updated = captureReadResultForFreshness(latestHashes, {
			toolName: "read",
			args: {},
			result: { details: { contentIdentity: "hash-a" } },
			isError: false,
		});

		expect(updated).toBe(false);
		expect(latestHashes.size).toBe(0);
	});

	it("does not update the map when args.path is an empty string", () => {
		const latestHashes = new Map<string, string>();
		const updated = captureReadResultForFreshness(latestHashes, {
			toolName: "read",
			args: { path: "" },
			result: { details: { contentIdentity: "hash-a" } },
			isError: false,
		});

		expect(updated).toBe(false);
		expect(latestHashes.size).toBe(0);
	});

	it("does not update the map when args.path is not a string", () => {
		const latestHashes = new Map<string, string>();
		const updated = captureReadResultForFreshness(latestHashes, {
			toolName: "read",
			args: { path: 42 },
			result: { details: { contentIdentity: "hash-a" } },
			isError: false,
		});

		expect(updated).toBe(false);
		expect(latestHashes.size).toBe(0);
	});

	it("does not update the map when args itself is null", () => {
		const latestHashes = new Map<string, string>();
		const updated = captureReadResultForFreshness(latestHashes, {
			toolName: "read",
			args: null,
			result: { details: { contentIdentity: "hash-a" } },
			isError: false,
		});

		expect(updated).toBe(false);
		expect(latestHashes.size).toBe(0);
	});

	it("does not overwrite a previously recorded entry when the latest call is a failure", () => {
		// Seed the map with a successful read, then make sure a
		// subsequent failed read leaves the seed intact.
		const latestHashes = new Map<string, string>();
		captureReadResultForFreshness(latestHashes, {
			toolName: "read",
			args: { path: "src/a.ts" },
			result: { details: { contentIdentity: "hash-a" } },
			isError: false,
		});

		captureReadResultForFreshness(latestHashes, {
			toolName: "read",
			args: { path: "src/a.ts" },
			result: { details: { contentIdentity: "hash-should-not-overwrite" } },
			isError: true,
		});

		expect(latestHashes.get("src/a.ts")).toBe("hash-a");
	});
});

