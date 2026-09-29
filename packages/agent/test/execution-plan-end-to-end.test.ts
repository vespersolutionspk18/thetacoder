import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@theta/ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

describe("execution plan end-to-end", () => {
	it("routes a plan-bearing assistant message through the F6 executor and emits 3 tool result messages", async () => {
		const readCalls: string[] = [];
		const bashCalls: string[] = [];

		const readSchema = Type.Object({ path: Type.String() });
		const readTool: AgentTool<typeof readSchema, { path: string }> = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: readSchema,
			async execute(_toolCallId, params) {
				readCalls.push(params.path);
				return {
					content: [{ type: "text", text: `read:${params.path}` }],
					details: { path: params.path },
				};
			},
		};

		const bashSchema = Type.Object({ command: Type.String() });
		const bashTool: AgentTool<typeof bashSchema, { command: string }> = {
			name: "bash",
			label: "Bash",
			description: "Run a bash command",
			parameters: bashSchema,
			async execute(_toolCallId, params) {
				bashCalls.push(params.command);
				return {
					content: [{ type: "text", text: `bash:${params.command}` }],
					details: { command: params.command },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [readTool, bashTool],
		};

		const userPrompt = createUserMessage("execute the plan");
		const steps = [
			{ id: "s1", kind: "read", target: "/path/a.txt", operation: "/path/a.txt", dependsOn: [] },
			{ id: "s2", kind: "bash", target: "echo hi", operation: "echo hi", dependsOn: [] },
			{ id: "s3", kind: "read", target: "/path/b.txt", operation: "/path/b.txt", dependsOn: [] },
		];
		const envelope = {
			plan: { id: "p1", intent: "test", steps, stopConditions: [], createdAt: 0 },
			steps,
		};

		type CapturedStepResult = {
			stepId: string;
			status: string;
			output?: unknown;
			error?: Error;
			startedAt: number;
			endedAt: number;
			wallTimeMs: number;
		};
		type PlanRunner = (step: unknown, signal: AbortSignal | undefined) => Promise<CapturedStepResult>;

		let executorCalls = 0;
		let executorPlanSeen: unknown;
		const capturedStepResults: CapturedStepResult[] = [];

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			executionPlan: {
				enabled: true,
				executor: async (plan, runner, options) => {
					executorCalls++;
					executorPlanSeen = plan;
					const stepResults: CapturedStepResult[] = [];
					const runnerFn = runner as PlanRunner;
					for (const step of steps) {
						const result = await runnerFn(step, options?.signal);
						stepResults.push(result);
					}
					capturedStepResults.push(...stepResults);
					return { status: "completed", stepResults };
				},
			},
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage([], "stop");
					(message as { executionPlan?: unknown }).executionPlan = envelope;
					stream.push({ type: "done", reason: "stop", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "Plan complete" }], "stop");
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		// Executor was invoked exactly once.
		expect(executorCalls).toBe(1);
		// The executor received the plan we attached to the assistant message.
		expect(executorPlanSeen).toBe(envelope.plan);

		// The executor collected 3 step results in declaration order, all succeeded.
		expect(capturedStepResults.length).toBe(3);
		expect(capturedStepResults.map((r) => r.stepId)).toEqual(["s1", "s2", "s3"]);
		expect(capturedStepResults.every((r) => r.status === "succeeded")).toBe(true);

		// The 3 step results flow back as ToolResultMessages in the conversation.
		const toolResultMessages = messages.filter(
			(m): m is Extract<AgentMessage, { role: "toolResult" }> => m.role === "toolResult",
		);
		expect(toolResultMessages.length).toBe(3);

		// Each tool result is wired to the right tool name based on the step's kind.
		expect(toolResultMessages[0]?.toolName).toBe("read");
		expect(toolResultMessages[1]?.toolName).toBe("bash");
		expect(toolResultMessages[2]?.toolName).toBe("read");

		// The real tool output flows back as the tool result content (not a
		// synthesized "Plan step X succeeded" placeholder).
		const firstText = toolResultMessages[0]?.content[0];
		expect(firstText && firstText.type === "text" ? firstText.text : "").toBe("read:/path/a.txt");
		const secondText = toolResultMessages[1]?.content[0];
		expect(secondText && secondText.type === "text" ? secondText.text : "").toBe("bash:echo hi");
		const thirdText = toolResultMessages[2]?.content[0];
		expect(thirdText && thirdText.type === "text" ? thirdText.text : "").toBe("read:/path/b.txt");

		// Tools were invoked exactly the right number of times with the right args.
		expect(readCalls).toEqual(["/path/a.txt", "/path/b.txt"]);
		expect(bashCalls).toEqual(["echo hi"]);

		// No tool result was an error in the happy path.
		expect(toolResultMessages.every((m) => m.isError !== true)).toBe(true);

		// The conversation also includes the plan-bearing assistant message and
		// the final assistant turn-end reply from the second LLM call.
		const assistantMessages = messages.filter((m) => m.role === "assistant");
		expect(assistantMessages.length).toBe(2);

		// The tool execution events fire 3 times in the order the steps ran.
		const toolStartEvents = events.filter(
			(e): e is Extract<AgentEvent, { type: "tool_execution_start" }> => e.type === "tool_execution_start",
		);
		expect(toolStartEvents.length).toBe(3);
		expect(toolStartEvents.map((e) => e.toolName)).toEqual(["read", "bash", "read"]);
	});
});

