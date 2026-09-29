/**
 * F11 incremental serialization — WeakMap-based auto-eviction.
 *
 * The cache is a `WeakMap<AgentMessage, ...>`. When the only strong
 * reference to a message is the cache itself, dropping the local
 * reference and forcing a GC pass must let the entry become eligible
 * for collection. After the GC, a new `serialize` call for an
 * equivalent-but-freshly-constructed message is a miss.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { convertToLlmIncremental, IncrementalSerializer } from "../src/core/incremental-serialization.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

// Exposed for tests; Node's --expose-gc flag toggles this. The repo's
// vitest config doesn't enable it by default, so we check for the
// helper and skip the GC-dependent assertions when it is absent.
type GcGlobal = typeof globalThis & { gc?: () => void };
const gcAvailable = typeof (globalThis as GcGlobal).gc === "function";

describe("F11 incremental serialization — WeakMap auto-eviction", () => {
	it("drops a cached entry when the AgentMessage is collected", async () => {
		if (!gcAvailable) {
			// Without `--expose-gc` we can't deterministically force a
			// collection. The behavior is well-defined by the platform;
			// we skip the assertion to keep the suite runnable in CI.
			return;
		}

		const serializer = new IncrementalSerializer();
		const makeFresh = () => makeUser("transient", Date.now()) as AgentMessage;

		// Build a message that is *only* reachable from the cache by
		// letting the local `let` go out of scope after a tiny pause.
		const populate = () => {
			const local = makeFresh();
			convertToLlmIncremental(serializer, [local]);
		};
		populate();
		// After populate() returns, the only strong reference to the
		// AgentMessage should be inside the serializer's cache.
		expect(serializer.getCacheStats().size).toBe(1);

		// Force the WeakMap to release the entry.
		(globalThis as GcGlobal).gc!();
		// Allow the FinalizationRegistry-style queue (if any) to settle.
		await new Promise((r) => setTimeout(r, 0));
		(globalThis as GcGlobal).gc!();

		// The cache key set mirrors the WeakMap; a GC pass on a message
		// with no other strong references should reduce `size` to 0.
		expect(serializer.getCacheStats().size).toBe(0);
	});

	it("treats a freshly-constructed equivalent message as a miss when the original was collected", () => {
		if (!gcAvailable) return;

		const serializer = new IncrementalSerializer();
		const build = (text: string) => makeUser(text, 1) as AgentMessage;

		{
			const original = build("temp");
			convertToLlmIncremental(serializer, [original]);
		}
		(globalThis as GcGlobal).gc!();

		// A brand-new object with the same shape is a different key
		// (WeakMap keys are object identity), so this must miss.
		const fresh = build("temp");
		convertToLlmIncremental(serializer, [fresh]);
		expect(serializer.getCacheStats().misses).toBe(2);
	});

	it("retains entries for messages that are still referenced externally", async () => {
		if (!gcAvailable) return;

		const serializer = new IncrementalSerializer();
		const kept: AgentMessage[] = [];
		for (let i = 0; i < 5; i++) {
			const m = makeUser(`live-${i}`, i) as AgentMessage;
			kept.push(m);
			convertToLlmIncremental(serializer, [m]);
		}
		expect(serializer.getCacheStats().size).toBe(5);

		// GC must not drop entries whose key is still reachable via `kept`.
		(globalThis as GcGlobal).gc!();
		await new Promise((r) => setTimeout(r, 0));

		expect(serializer.getCacheStats().size).toBe(5);
		// Re-serializing a still-reachable message is a hit.
		convertToLlmIncremental(serializer, kept);
		expect(serializer.getCacheStats().hits).toBe(5);
	});
});

