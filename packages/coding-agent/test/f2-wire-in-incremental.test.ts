/**
 * F2 wire-in — incremental serialization (default on).
 *
 * Verifies that the F2 `convertToLlm` wire-in
 * (`createF2ConvertToLlm` in `packages/coding-agent/src/core/sdk.ts`)
 * uses the F11 incremental serializer to cache the per-`AgentMessage`
 * conversion output. The serializer is constructed lazily on first
 * use and persisted across turns (one per F2-enabled session, i.e.
 * one per `createF2ConvertToLlm` invocation).
 *
 * The default `f2.incrementalSerialization` setting is `true`, so
 * this test asserts the default behavior — the wire-in uses the
 * incremental path. The opt-out path is covered by
 * `f2-wire-in-incremental-disabled.test.ts`.
 */

import type { AgentMessage } from "@theta/agent-core";
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../src/core/messages.ts";
import { createF2ConvertToLlm } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A `bashExecution` message: `convertToLlm` allocates a new `Message`
 * for each call (it does not pass-through for this role), so reference
 * identity across calls is a clean cache signal — a cache hit returns
 * the same `Message` object that the first call produced via
 * `structuredClone`.
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

function makeUser(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function makeAssistant(text: string, timestamp: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "faux-1",
		timestamp,
	};
}

// ---------------------------------------------------------------------------
// Settings default
// ---------------------------------------------------------------------------

describe("F2 wire-in — incremental serialization (default)", () => {
	it("defaults `f2.incrementalSerialization` to true", () => {
		const settings = SettingsManager.inMemory({});
		expect(settings.getF2IncrementalSerializationEnabled()).toBe(true);
	});

	it("round-trips the setting via the setter", () => {
		const settings = SettingsManager.inMemory({});
		settings.setF2IncrementalSerializationEnabled(false);
		expect(settings.getF2IncrementalSerializationEnabled()).toBe(false);
		settings.setF2IncrementalSerializationEnabled(true);
		expect(settings.getF2IncrementalSerializationEnabled()).toBe(true);
	});

	it("honors an explicit `f2.incrementalSerialization: true` in the settings blob", () => {
		const settings = SettingsManager.inMemory({ f2: { incrementalSerialization: true } });
		expect(settings.getF2IncrementalSerializationEnabled()).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Lazy serializer init
	// -------------------------------------------------------------------------

	it("does not construct the serializer until the first call to `convert`", () => {
		const settings = SettingsManager.inMemory({});
		const { convert, getSerializer } = createF2ConvertToLlm(settings);
		// The lazy init has not run yet — no serializer has been allocated.
		expect(getSerializer()).toBeNull();
		// The first call triggers the lazy init.
		convert([makeUser("hi", 1)]);
		expect(getSerializer()).not.toBeNull();
	});

	// -------------------------------------------------------------------------
	// Output equivalence with the pre-F11 `convertToLlm` walk
	// -------------------------------------------------------------------------

	it("produces the same converted output as a fresh `convertToLlm` walk for an unchanged message", () => {
		const settings = SettingsManager.inMemory({});
		const { convert } = createF2ConvertToLlm(settings);

		const messages: AgentMessage[] = [
			makeUser("hi", 1),
			makeAssistant("hello", 2),
			makeBashExecution("ls", "README.md\n", 3),
		];

		const incremental = convert(messages);
		const fresh = convertToLlm(messages);
		expect(incremental).toEqual(fresh);
	});

	// -------------------------------------------------------------------------
	// Cache property: a cache hit returns the same Message object
	// -------------------------------------------------------------------------

	it("returns the same Message object on the second call for an unchanged `bashExecution` (cache hit)", () => {
		// `bashExecution` is the cleanest cache signal: `convertToLlm`
		// allocates a new `Message` for every call (the message is
		// re-serialized into a `text` block each time), so two
		// non-cached calls would produce two different `Message`
		// objects. The F11 incremental serializer caches the
		// `structuredClone`d result on first call and returns the
		// same object on every subsequent call with the same
		// `AgentMessage` reference.
		const settings = SettingsManager.inMemory({});
		const { convert, getSerializer } = createF2ConvertToLlm(settings);

		const bash = makeBashExecution("ls", "README.md\n", 1);
		const first = convert([bash]);
		const second = convert([bash]);

		expect(first).toHaveLength(1);
		expect(second).toHaveLength(1);
		// Cache hit: same reference, not just deep-equal.
		expect(second[0]).toBe(first[0]);

		// The serializer's stats reflect one miss and one hit.
		const stats = getSerializer()?.getCacheStats();
		expect(stats).toEqual({ hits: 1, misses: 1, size: 1 });
	});
});

