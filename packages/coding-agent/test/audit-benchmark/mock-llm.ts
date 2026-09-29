/**
 * Scripted mock LLM provider for the audit benchmark.
 *
 * The benchmark's real subject of measurement is the F2 context-compiler
 * + convertToLlm pipeline, not the model itself. The mock provider's job
 * is to deterministically hand the runner the next scripted assistant
 * response, so the F2 layer's metrics (cache hits, prompt token growth,
 * freshness warnings, redundant source deliveries) can be measured
 * without a real LLM.
 *
 * The mock implements the same `fauxAssistantMessage` surface as
 * `@theta/ai`'s `faux` provider, but is purpose-built for the audit
 * benchmark and keeps the queue + state inline for easy inspection in
 * tests.
 */

import type { AssistantMessage } from "@theta/ai";
import { fauxAssistantMessage } from "@theta/ai";

/** A single scripted response, paired with the `AssistantMessage` the
 *  runner will record in the message stream. */
export interface ScriptedResponse {
	assistantMessage: AssistantMessage;
}

/** Build a ScriptedResponse from a plain text body. */
export function scriptedText(text: string): ScriptedResponse {
	return { assistantMessage: fauxAssistantMessage(text) };
}

/**
 * ScriptedMockLLM is a thin FIFO queue. The runner calls `next()` once
 * per turn; if the queue runs dry, the run is marked incomplete (the
 * benchmark treats this as a failure that should not happen in a
 * correctly-built task).
 */
export class ScriptedMockLLM {
	private readonly queue: ScriptedResponse[];
	/** Number of times the runner called `next()`. */
	callCount = 0;
	/** Responses the runner actually consumed. */
	consumed: ScriptedResponse[] = [];

	constructor(responses: ScriptedResponse[]) {
		this.queue = responses.slice();
	}

	/** Pop the next scripted response. Throws if the queue is empty. */
	next(): ScriptedResponse {
		this.callCount += 1;
		const head = this.queue.shift();
		if (!head) {
			throw new Error("ScriptedMockLLM queue exhausted; the task underran its script");
		}
		this.consumed.push(head);
		return head;
	}

	/** True if no responses remain. */
	isExhausted(): boolean {
		return this.queue.length === 0;
	}

	/** Remaining count. */
	get pendingCount(): number {
		return this.queue.length;
	}
}

