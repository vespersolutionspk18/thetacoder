import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTypedSpanStarter, NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@theta/telemetry";
import { describe, expect, expectTypeOf, it } from "vitest";
import { renderAgentTelemetrySchemaMarkdown } from "../../scripts/generate-telemetry-docs.ts";
import { BACKGROUND_CONTEXT, withTelemetryContext } from "../../src/harness/context.ts";
import {
	AGENT_TELEMETRY_SCHEMAS,
	AI_TELEMETRY_SCHEMA,
	type AiSpanEndAttributes,
	type AiSpanStartAttributes,
	HARNESS_TELEMETRY_SCHEMA,
	type HarnessSpanEndAttributes,
	type HarnessSpanStartAttributes,
	startAiSpan,
	startHarnessSpan,
} from "../../src/harness/telemetry.ts";

describe("agent telemetry schemas", () => {
	it("serializes both schemas and generates the checked-in reference", () => {
		expect(() => JSON.stringify(AI_TELEMETRY_SCHEMA)).not.toThrow();
		expect(() => JSON.stringify(HARNESS_TELEMETRY_SCHEMA)).not.toThrow();
		expect(AGENT_TELEMETRY_SCHEMAS).toEqual([AI_TELEMETRY_SCHEMA, HARNESS_TELEMETRY_SCHEMA]);
		expect(Object.keys(HARNESS_TELEMETRY_SCHEMA.spans)).toEqual([
			"theta.harness.run",
			"theta.harness.compaction",
			"theta.harness.navigation",
			"theta.harness.checkpoint",
			"theta.harness.turn",
			"theta.harness.step",
			"theta.harness.tool",
			"theta.harness.hook",
			"theta.harness.sleep",
			"theta.harness.event_handler",
			"theta.session.write",
		]);
		const actual = readFileSync(resolve(import.meta.dirname, "../../docs/telemetry-schema.md"), "utf8");
		expect(actual).toBe(renderAgentTelemetrySchemaMarkdown());
	});

	it("starts AI-request and harness spans through one composed typed starter", async () => {
		const startSpan = createTypedSpanStarter(NOOP_TELEMETRY_CONTEXT, AGENT_TELEMETRY_SCHEMAS);
		await startSpan(
			"theta.harness.step",
			{
				"theta.lane.name": "main",
				"theta.operation.id": "operation",
				"theta.step.kind": "assistant",
				"theta.step.attempt": 1,
			},
			async (stepSpan, startChildSpan) => {
				stepSpan.setAttributes({ "theta.step.outcome": "succeeded" });
				await startChildSpan(
					"theta.ai.request",
					{
						"theta.ai.operation": "stream",
						"theta.ai.provider": "provider",
						"theta.ai.model": "model",
						"theta.ai.api": "api",
						"theta.ai.streaming": true,
					},
					(requestSpan) => {
						requestSpan.setAttributes({ "theta.ai.response.stop_reason": "stop" });
					},
				);
			},
		);
	});

	it("infers exact AI start and optional end attributes", async () => {
		type Start = AiSpanStartAttributes<"theta.ai.request">;
		type End = AiSpanEndAttributes<"theta.ai.request">;
		expectTypeOf<Start>().toMatchTypeOf<{
			"theta.ai.operation": "stream" | "fetch_deferred" | "cancel_deferred" | "generate_images";
			"theta.ai.provider": string;
			"theta.ai.model": string;
			"theta.ai.api": string;
			"theta.ai.streaming": boolean;
			"theta.ai.deferred"?: boolean;
		}>();
		expectTypeOf<End["theta.ai.response.stop_reason"]>().toEqualTypeOf<
			"stop" | "length" | "tool_use" | "error" | "aborted" | "deferred" | undefined
		>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		const context = withTelemetryContext(telemetryContext, BACKGROUND_CONTEXT);
		await startAiSpan(
			"theta.ai.request",
			{
				"theta.ai.operation": "stream",
				"theta.ai.provider": "provider",
				"theta.ai.model": "model",
				"theta.ai.api": "api",
				"theta.ai.streaming": true,
			},
			(span) => {
				span.setAttributes({ "theta.ai.response.stop_reason": "tool_use" });
				// @ts-expect-error theta.ai.request declares no span events
				span.addEvent("chunk");
			},
			context,
		);

		const compileTimeFailures = () => {
			const extraAttributes = {
				"theta.ai.operation": "stream",
				"theta.ai.provider": "provider",
				"theta.ai.model": "model",
				"theta.ai.api": "api",
				"theta.ai.streaming": true,
				"theta.ai.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startAiSpan("theta.ai.request", extraAttributes, () => {}, context);
			// @ts-expect-error missing required start attributes
			void startAiSpan("theta.ai.request", { "theta.ai.operation": "stream" }, () => {}, context);
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});

	it("infers per-span harness literals and optional completion enrichment", async () => {
		type RunStart = HarnessSpanStartAttributes<"theta.harness.run">;
		type RunEnd = HarnessSpanEndAttributes<"theta.harness.run">;
		type WriteStart = HarnessSpanStartAttributes<"theta.session.write">;
		type WriteEnd = HarnessSpanEndAttributes<"theta.session.write">;
		expectTypeOf<RunStart["theta.operation.kind"]>().toEqualTypeOf<"run">();
		expectTypeOf<RunEnd["theta.operation.outcome"]>().toEqualTypeOf<
			"completed" | "aborted" | "failed" | "suspended" | undefined
		>();
		const writeStart = {
			"theta.session.id": "session",
			"theta.session.item_count": 2,
			"theta.session.item_kinds": ["entry", "value", "list"],
		} satisfies WriteStart;
		const writeEnd = {
			"theta.session.first_seq": 1,
			"theta.session.last_seq": 2,
		} satisfies WriteEnd;
		expectTypeOf(writeStart["theta.session.item_count"]).toEqualTypeOf<number>();
		expectTypeOf(writeEnd["theta.session.last_seq"]).toEqualTypeOf<number>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		const context = withTelemetryContext(telemetryContext, BACKGROUND_CONTEXT);
		await startHarnessSpan(
			"theta.harness.run",
			{
				"theta.session.id": "session",
				"theta.lane.name": "main",
				"theta.operation.id": "operation",
				"theta.operation.kind": "run",
				"theta.operation.recovery": false,
			},
			(span) => {
				span.setAttributes({ "theta.operation.outcome": "completed" });
				span.setAttributes({});
				// @ts-expect-error the harness schema declares no span events
				span.addEvent("result");
			},
			context,
		);

		const compileTimeFailures = () => {
			const extraRunAttributes = {
				"theta.session.id": "session",
				"theta.lane.name": "main",
				"theta.operation.id": "operation",
				"theta.operation.kind": "run",
				"theta.operation.recovery": false,
				"theta.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startHarnessSpan("theta.harness.run", extraRunAttributes, () => {}, context);
			void startHarnessSpan(
				"theta.harness.checkpoint",
				{
					"theta.lane.name": "main",
					"theta.operation.id": "operation",
					"theta.checkpoint.kind": "normal",
				},
				(span) => {
					// @ts-expect-error empty end schemas reject every attribute
					span.setAttributes({ "theta.unknown": true });
				},
				context,
			);
			void startHarnessSpan(
				"theta.harness.run",
				{
					"theta.session.id": "session",
					"theta.lane.name": "main",
					"theta.operation.id": "operation",
					// @ts-expect-error run spans accept only the run operation kind
					"theta.operation.kind": "navigation",
					"theta.operation.recovery": false,
				},
				() => {},
				context,
			);
			// @ts-expect-error missing required run start attributes
			void startHarnessSpan("theta.harness.run", {}, () => {}, context);
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});
});

