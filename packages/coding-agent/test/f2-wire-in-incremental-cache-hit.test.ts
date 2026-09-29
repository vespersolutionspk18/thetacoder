/**
 * F2 wire-in — incremental serialization: the second turn is a cache hit.
 *
 * The F2 layer is invoked once per provider request, so the same
 * `AgentMessage` references (the entire conversation history up to the
 * current turn) flow through `convertToLlm` on every turn. The F11
 * incremental serializer caches the per-message conversion output, so
 * only the newly-appended messages on each turn re-serialize; the
 * unchanged prefix is served from the cache.
 *
 * This test exercises the realistic turn-by-turn pattern:
 *   - Turn 1: 3 messages, all cache misses.
 *   - Turn 2: 4 messages (the original 3 + 1 new). The first 3 are
 *     cache hits; the 4th is a cache miss.
 *
 * The behavioral assertion is Message reference identity for the
 * unchanged prefix: the `Message` returned for the same
 * `AgentMessage` reference on the second call must be `===` to the
 * one returned on the first call (the F11 serializer caches the
 * `structuredClone`d result and returns it verbatim on cache hits).
 * The new message on turn 2 is a fresh `Message` (cache miss).
 *
 * The `IncrementalSerializer` stats getter exposed by
 * `createF2ConvertToLlm` provides the structural assertion:
 *   - After turn 1: hits = 0, misses = 3, size = 3.
 *   - After turn 2: hits = 3, misses = 4, size = 4.
 */

import type { AgentMessage } from "@theta/agent-core";
import { describe, expect, it } from "vitest";
import { createF2ConvertToLlm } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * `bashExecution` messages: `convertToLlm` allocates a new `Message`
 * for each call (the message is re-serialized into a `text` block
 * each time), so a `bashExecution` reference is the cleanest cache
 * signal — a non-cached path produces a new `Message` object every
 * call, while the F11 incremental serializer returns the same
 * `Message` object on cache hits.
 */
function makeBashExecution(command: string, output: string, timestamp: number): AgentMessage {
	return {
		role: "bashExecution",
		command,
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("F2 wire-in — incremental serialization cache hit on the second turn", () => {
	it("serves the unchanged prefix from the cache on the second turn; only the new message re-serializes", () => {
		const settings = SettingsManager.inMemory({});
		const { convert, getSerializer } = createF2ConvertToLlm(settings);

		// Turn 1: three `bashExecution` messages flow through the
		// wire-in. Each one is a cache miss (the cache starts empty).
		const turn1: AgentMessage[] = [
			makeBashExecution("ls", "a.txt\n", 1),
			makeBashExecution("cat a.txt", "alpha\n", 2),
			makeBashExecution("wc -l a.txt", "1\n", 3),
		];
		const turn1Result = convert(turn1);
		expect(turn1Result).toHaveLength(3);
		// All three are cache misses; the serializer has populated
		// three entries.
		expect(getSerializer()?.getCacheStats()).toEqual({ hits: 0, misses: 3, size: 3 });

		// Turn 2: the user appends a new `bashExecution` and we
		// re-issue the entire conversation history. The wire-in
		// should serve the first three from the cache and only
		// re-serialize the new one.
		const turn2: AgentMessage[] = [turn1[0]!, turn1[1]!, turn1[2]!, makeBashExecution("echo done", "done\n", 4)];
		const turn2Result = convert(turn2);
		expect(turn2Result).toHaveLength(4);

		// The first three are cache hits: same `Message` object
		// reference as on turn 1. The fourth is a cache miss: a
		// new `Message` object.
		expect(turn2Result[0]).toBe(turn1Result[0]);
		expect(turn2Result[1]).toBe(turn1Result[1]);
		expect(turn2Result[2]).toBe(turn1Result[2]);
		expect(turn2Result[3]).not.toBe(turn1Result[0]);
		expect(turn2Result[3]).not.toBe(turn1Result[1]);
		expect(turn2Result[3]).not.toBe(turn1Result[2]);

		// Stats: 3 hits (the unchanged prefix) + 1 miss (the new
		// message). The cache size grew to 4.
		expect(getSerializer()?.getCacheStats()).toEqual({ hits: 3, misses: 4, size: 4 });
	});

	it("re-serializes a message whose conversion-relevant fields changed between turns", () => {
		// The F11 incremental serializer hashes the
		// conversion-relevant fields of each `AgentMessage`. If a
		// field that affects the `convertToLlm` output changes
		// (e.g. a different `output` on a `bashExecution`), the
		// hash no longer matches and the wire-in re-runs the
		// conversion instead of returning the stale cached
		// `Message`.
		const settings = SettingsManager.inMemory({});
		const { convert, getSerializer } = createF2ConvertToLlm(settings);

		const mutable: AgentMessage = makeBashExecution("ls", "first\n", 1);
		const turn1 = convert([mutable]);
		expect(getSerializer()?.getCacheStats()).toEqual({ hits: 0, misses: 1, size: 1 });

		// Mutate the field that `convertToLlm` reads. The wire-in
		// should detect the hash mismatch and re-serialize.
		(mutable as { output: string }).output = "second\n";
		const turn2 = convert([mutable]);

		// Cache miss: a fresh `Message` object, not the stale one.
		expect(turn2[0]).not.toBe(turn1[0]);
		// And the new content made it through to the LLM-bound
		// message (the wire-in must not serve stale content).
		const textBlock = (turn2[0] as { content: Array<{ type: string; text?: string }> }).content[0]!;
		expect(textBlock.text).toContain("second");
		// The new entry replaced the old one (same size — one
		// message in the cache, just a different hash).
		expect(getSerializer()?.getCacheStats()).toEqual({ hits: 0, misses: 2, size: 1 });
	});

	it("preserves cache hit behavior across multiple turns (turn 3 is also a cache hit for the unchanged prefix)", () => {
		const settings = SettingsManager.inMemory({});
		const { convert, getSerializer } = createF2ConvertToLlm(settings);

		const a = makeBashExecution("echo a", "a\n", 1);
		const b = makeBashExecution("echo b", "b\n", 2);

		// Turn 1: [a, b] — two misses.
		const r1 = convert([a, b]);
		expect(getSerializer()?.getCacheStats()).toEqual({ hits: 0, misses: 2, size: 2 });

		// Turn 2: [a, b, a', b'] — two hits, two misses.
		const aPrime = makeBashExecution("echo a", "a'\n", 3);
		const bPrime = makeBashExecution("echo b", "b'\n", 4);
		const r2 = convert([a, b, aPrime, bPrime]);
		expect(getSerializer()?.getCacheStats()).toEqual({ hits: 2, misses: 4, size: 4 });
		// The first two entries are the same `Message` objects
		// served from the cache.
		expect(r2[0]).toBe(r1[0]);
		expect(r2[1]).toBe(r1[1]);

		// Turn 3: [a, b, a', b', a''] — four hits, one miss.
		const aDoublePrime = makeBashExecution("echo a", "a''\n", 5);
		const r3 = convert([a, b, aPrime, bPrime, aDoublePrime]);
		expect(getSerializer()?.getCacheStats()).toEqual({ hits: 6, misses: 5, size: 5 });
		// The first four entries match the previous turn's first
		// four (all served from the cache). The new fifth entry
		// is a fresh `Message`.
		expect(r3[0]).toBe(r2[0]);
		expect(r3[1]).toBe(r2[1]);
		expect(r3[2]).toBe(r2[2]);
		expect(r3[3]).toBe(r2[3]);
		expect(r3[4]).not.toBe(r2[0]);
	});
});

