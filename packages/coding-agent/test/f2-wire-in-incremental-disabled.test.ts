/**
 * F2 wire-in — incremental serialization disabled via the
 * `f2.incrementalSerialization: false` setting.
 *
 * When the user opts out, the F2 wire-in falls back to a fresh
 * `convertToLlm` walk on every call (byte-identical to the pre-F11
 * behavior). The lazy `IncrementalSerializer` is never allocated in
 * this mode, and two consecutive calls with the same `AgentMessage`
 * references do NOT share cached `Message` objects.
 *
 * Complements `f2-wire-in-incremental.test.ts` (default on) and
 * `f2-wire-in-incremental-cache-hit.test.ts` (cache hit on the
 * second turn).
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
 * `bashExecution` is the cleanest signal for "no caching": the
 * pre-F11 `convertToLlm` walk allocates a new `Message` for every
 * call (the message is re-serialized into a `text` block each time),
 * so two non-cached calls produce two different `Message` objects
 * even with the same `AgentMessage` reference.
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
// Tests
// ---------------------------------------------------------------------------

describe("F2 wire-in — incremental serialization disabled", () => {
	it("does not construct the serializer when the setting is off (no allocation on the disabled path)", () => {
		const settings = SettingsManager.inMemory({ f2: { incrementalSerialization: false } });
		const { convert, getSerializer } = createF2ConvertToLlm(settings);

		// Drive a few calls through the wire-in. The serializer
		// must never be allocated in the disabled path — only the
		// fresh `convertToLlm` walk runs.
		convert([makeUser("hi", 1)]);
		convert([makeAssistant("hello", 2)]);
		convert([makeBashExecution("ls", "README.md\n", 3)]);

		expect(getSerializer()).toBeNull();
	});

	it("produces output equivalent to a fresh `convertToLlm` walk (byte-identical to the pre-F11 path)", () => {
		const settings = SettingsManager.inMemory({ f2: { incrementalSerialization: false } });
		const { convert } = createF2ConvertToLlm(settings);

		const messages: AgentMessage[] = [
			makeUser("hi", 1),
			makeAssistant("hello", 2),
			makeBashExecution("ls", "README.md\n", 3),
		];

		const wireIn = convert(messages);
		const fresh = convertToLlm(messages);
		expect(wireIn).toEqual(fresh);
	});

	it("returns a fresh Message object on every call for a `bashExecution` (no cache, no reference sharing)", () => {
		const settings = SettingsManager.inMemory({ f2: { incrementalSerialization: false } });
		const { convert, getSerializer } = createF2ConvertToLlm(settings);

		const bash = makeBashExecution("ls", "README.md\n", 1);
		const first = convert([bash]);
		const second = convert([bash]);

		expect(first).toHaveLength(1);
		expect(second).toHaveLength(1);
		// `bashExecution` always re-serializes in `convertToLlm`, so
		// the disabled path produces a brand new `Message` each
		// call. The references must NOT be equal — that would mean
		// the cache was somehow still active.
		expect(second[0]).not.toBe(first[0]);
		// And, of course, the serializer is still null.
		expect(getSerializer()).toBeNull();
	});

	it("picks up a mid-session toggle of `f2.incrementalSerialization` from on to off", () => {
		// The wire-in reads the setting on every call, so flipping
		// it via the setter takes effect on the next call without
		// re-creating the helper. This guards against accidentally
		// caching the setting at helper-construction time.
		const settings = SettingsManager.inMemory({});
		const { convert, getSerializer } = createF2ConvertToLlm(settings);

		const bash = makeBashExecution("ls", "README.md\n", 1);

		// First call with the setting on (default): serializer is
		// allocated and the cache miss produces a Message object.
		const onResult = convert([bash]);
		expect(getSerializer()).not.toBeNull();
		const onMessage = onResult[0]!;

		// Flip the setting off. The next call should bypass the
		// incremental path entirely — no fresh cache hit, just a
		// fresh `convertToLlm` walk. The previously cached Message
		// is still in the serializer, but the wire-in no longer
		// consults it.
		settings.setF2IncrementalSerializationEnabled(false);
		const offResult = convert([bash]);
		expect(offResult[0]).not.toBe(onMessage);

		// The disabled path did not consult the cache, so the
		// cached entry from the on-phase is unchanged.
		expect(getSerializer()?.getCacheStats()).toEqual({ hits: 0, misses: 1, size: 1 });
	});
});

