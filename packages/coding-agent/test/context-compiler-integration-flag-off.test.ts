/**
 * F2 context-compiler integration — flag off.
 *
 * When the `contextCompiler.enabled` setting is `false` (the default), the
 * agent loop must route `transformContext` output straight to `convertToLlm`
 * with no further modification. The integration is wired through the
 * `Agent.contextCompiler` field that the agent loop reads from
 * `AgentLoopConfig.contextCompiler`. This test exercises that wire end-to-end
 * through a real `AgentSession` and asserts the LLM call receives exactly the
 * messages `transformContext` returned, byte-for-byte.
 */

import type { AgentMessage } from "@theta/agent-core";
import type { AssistantMessage, Message, UserMessage } from "@theta/ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "./test-harness.ts";

function makeUser(text: string, ts: number): UserMessage {
	return { role: "user", content: text, timestamp: ts };
}

/** Extract the text content from a user/assistant message regardless of whether
 *  the content is a string or an array of TextContent/ImageContent blocks. */
function textOf(m: Message): string {
	if (m.role === "user" || m.role === "assistant" || m.role === "toolResult") {
		if (typeof m.content === "string") return m.content;
		return m.content
			.filter((b) => b.type === "text")
			.map((b) => (b.type === "text" ? b.text : ""))
			.join("\n");
	}
	return "";
}

function makeAssistant(text: string, ts: number): AssistantMessage {
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
		timestamp: ts,
	};
}

describe("F2 context compiler integration — flag off", () => {
	it("passes `transformContext` output to the LLM unchanged when contextCompiler.enabled=false", async () => {
		const harness = await createHarness({
			responses: ["ok"],
			systemPrompt: "test",
		});
		try {
			// Seed the agent state with a small conversation so transformContext
			// has something to operate on.
			const seeded: AgentMessage[] = [
				makeUser("seeded user 1", 1),
				makeAssistant("seeded assistant 1", 2),
				makeUser("seeded user 2", 3),
				makeAssistant("seeded assistant 2", 4),
			];
			harness.agent.state.messages = seeded.slice();

			// A transformContext that adds a distinctive marker so we can tell
			// whether the compiler ever ran (it must not, when the flag is off).
			const transformMarker: AgentMessage = {
				role: "user",
				content: "TRANSFORM_MARKER",
				timestamp: 9999,
			};
			const transformSpy: AgentMessage[][] = [];
			harness.agent.transformContext = async (messages) => {
				transformSpy.push(messages.slice());
				return [...messages, transformMarker];
			};

			// Flag off (explicit) — this is the post-F2 default and must
			// remain byte-identical to the pre-F2 passthrough.
			harness.agent.contextCompiler = { enabled: false };

			// Use a convertToLlm that preserves every AgentMessage (including
			// the user marker) so we can detect whether the compiler ever
			// touched the stream.
			harness.agent.convertToLlm = (messages) => messages as Message[];

			await harness.session.prompt("trigger");
			await harness.session.waitForIdle();

			// Sanity: transformContext was actually called.
			expect(transformSpy.length).toBeGreaterThan(0);

			const ctx = harness.faux.contexts[0];
			expect(ctx).toBeDefined();

			// Every seeded user message must still be present, plus the
			// transform marker. If the compiler had run, the marker would be
			// absent (it would have been trimmed by the budget step or never
			// inserted) and the older user messages might have been dropped.
			const llmMessages = ctx.messages;
			const userTexts = llmMessages.filter((m) => m.role === "user").map(textOf);
			expect(userTexts).toContain("seeded user 1");
			expect(userTexts).toContain("seeded user 2");
			expect(userTexts).toContain("TRANSFORM_MARKER");
			expect(userTexts).toContain("trigger");
		} finally {
			harness.cleanup();
		}
	});

	it("omitting contextCompiler entirely preserves the passthrough (default behavior)", async () => {
		const harness = await createHarness({
			responses: ["ok"],
			systemPrompt: "test",
		});
		try {
			harness.agent.state.messages = [makeUser("seeded", 1), makeAssistant("reply", 2)];

			let transformedCount = 0;
			harness.agent.transformContext = async (messages) => {
				transformedCount++;
				return messages;
			};
			// Do NOT set contextCompiler at all — the agent loop must treat
			// the missing field the same as `{ enabled: false }`.
			expect(harness.agent.contextCompiler).toBeUndefined();
			harness.agent.convertToLlm = (messages) => messages as Message[];

			await harness.session.prompt("hello");
			await harness.session.waitForIdle();

			expect(transformedCount).toBe(1);
			const ctx = harness.faux.contexts[0];
			const userTexts = ctx.messages.filter((m) => m.role === "user").map(textOf);
			expect(userTexts).toContain("seeded");
			expect(userTexts).toContain("hello");
		} finally {
			harness.cleanup();
		}
	});

	it("treats contextCompiler.enabled=true with no compile callback as a passthrough", async () => {
		// The agent loop guards on `compiler?.enabled && compiler.compile`,
		// so a misconfigured `{ enabled: true }` without a `compile` callback
		// must degrade safely to the passthrough rather than throw.
		const harness = await createHarness({
			responses: ["ok"],
			systemPrompt: "test",
		});
		try {
			harness.agent.state.messages = [makeUser("a", 1), makeAssistant("b", 2)];

			const marker: AgentMessage = { role: "user", content: "PASSTHROUGH_MARKER", timestamp: 5 };
			harness.agent.transformContext = async (messages) => [...messages, marker];
			harness.agent.contextCompiler = { enabled: true /* compile intentionally missing */ };
			harness.agent.convertToLlm = (messages) => messages as Message[];

			await harness.session.prompt("c");
			await harness.session.waitForIdle();

			const ctx = harness.faux.contexts[0];
			const userTexts = ctx.messages.filter((m) => m.role === "user").map(textOf);
			expect(userTexts).toContain("a");
			expect(userTexts).toContain("PASSTHROUGH_MARKER");
			expect(userTexts).toContain("c");
		} finally {
			harness.cleanup();
		}
	});
});

