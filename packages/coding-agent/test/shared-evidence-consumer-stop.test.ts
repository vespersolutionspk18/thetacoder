/**
 * F10 shared evidence consumer — stopPolling.
 *
 * `stopPolling` must end the active interval cleanly. Calling it
 * twice is fine (idempotent). Calling it when no interval is active
 * is also fine (no throw). This is the safety net the previous test
 * suite relies on.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemorySharedEvidenceStore } from "../src/core/repository/shared-evidence.ts";
import { createSharedEvidenceConsumer } from "../src/core/repository/shared-evidence-consumer.ts";

describe("SharedEvidenceConsumer — stopPolling", () => {
	let store: InMemorySharedEvidenceStore;
	let consumer: ReturnType<typeof createSharedEvidenceConsumer>;
	let seen: string[];

	beforeEach(() => {
		store = new InMemorySharedEvidenceStore();
		seen = [];
		consumer = createSharedEvidenceConsumer({
			store,
			source: "s",
			onNew: (e) => seen.push(e.id),
		});
	});

	afterEach(() => {
		consumer.stopPolling();
	});

	it("stopPolling is a no-op when no interval is running", () => {
		expect(() => consumer.stopPolling()).not.toThrow();
		expect(() => consumer.stopPolling()).not.toThrow();
	});

	it("stops the interval so further publishes are not observed", async () => {
		consumer.startPolling(5);
		await new Promise((r) => setTimeout(r, 10));
		await consumer.publish("file-manifest", { v: 1 });
		await new Promise((r) => setTimeout(r, 30));
		expect(seen.length).toBeGreaterThanOrEqual(1);

		consumer.stopPolling();
		const snapshot = seen.length;
		await consumer.publish("file-manifest", { v: 2 });
		await new Promise((r) => setTimeout(r, 30));
		expect(seen.length).toBe(snapshot);
	});

	it("startPolling twice replaces the previous interval cleanly", async () => {
		const stop1 = consumer.startPolling(5);
		const stop2 = consumer.startPolling(10);
		// Calling the first stop should not throw and should not
		// cancel the new interval.
		stop1();
		stop2();
		expect(() => consumer.stopPolling()).not.toThrow();
	});
});

