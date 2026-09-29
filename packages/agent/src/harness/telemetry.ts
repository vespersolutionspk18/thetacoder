import type {
	ExactTelemetryAttributes,
	SchemaTelemetrySpan,
	TelemetrySchemaDefinition,
	TelemetrySchemaSpanEndAttributes,
	TelemetrySchemaSpanEventAttributes,
	TelemetrySchemaSpanEventName,
	TelemetrySchemaSpanName,
	TelemetrySchemaSpanStartAttributes,
	TelemetrySchemaSpanUnion,
	TelemetrySpan,
} from "@theta/telemetry";
import { type Context, getTelemetryContext, withTelemetryContext } from "./context.ts";

export type {
	AttributeValue,
	ExactTelemetryAttributes,
	SchemaTelemetrySpan,
	SpanAttributes,
	SpanOptions,
	SpanStatus,
	TelemetryAttributeDefinition,
	TelemetryAttributeMetadata,
	TelemetryAttributeType,
	TelemetryContext,
	TelemetryEventAttributeDefinition,
	TelemetryEventDefinition,
	TelemetryParentDefinition,
	TelemetrySchemaDefinition,
	TelemetrySchemaSpanEndAttributes,
	TelemetrySchemaSpanEventAttributes,
	TelemetrySchemaSpanEventName,
	TelemetrySchemaSpanName,
	TelemetrySchemaSpanStartAttributes,
	TelemetrySchemaSpanUnion,
	TelemetrySpan,
	TelemetrySpanDefinition,
	TelemetryStartAttributeDefinition,
	TypedSpanStarter,
} from "@theta/telemetry";

export const AI_TELEMETRY_SCHEMA = {
	version: 1,
	spans: {
		"theta.ai.request": {
			description: "One logical request to an AI provider",
			parents: { kind: "any" },
			startAttributes: {
				"theta.ai.operation": {
					type: "string",
					required: true,
					values: ["stream", "fetch_deferred", "cancel_deferred", "generate_images"],
					description: "Logical provider operation",
				},
				"theta.ai.provider": {
					type: "string",
					required: true,
					description: "Selected provider id",
				},
				"theta.ai.model": {
					type: "string",
					required: true,
					description: "Requested model id",
				},
				"theta.ai.api": {
					type: "string",
					required: true,
					description: "Provider API id",
				},
				"theta.ai.streaming": {
					type: "boolean",
					required: true,
					description: "Whether this operation returns a stream",
				},
				"theta.ai.deferred": {
					type: "boolean",
					required: false,
					description: "Whether the operation requests or participates in deferred execution",
				},
			},
			endAttributes: {
				"theta.ai.response.model": { type: "string", description: "Concrete response model" },
				"theta.ai.response.id": {
					type: "string",
					cardinality: "high",
					description: "Provider response id",
				},
				"theta.ai.response.stop_reason": {
					type: "string",
					values: ["stop", "length", "tool_use", "error", "aborted", "deferred"],
					description: "Normalized terminal response reason",
				},
				"theta.ai.http.status_code": { type: "number", description: "Final HTTP status" },
				"theta.ai.usage.input_tokens": { type: "number", description: "Reported input tokens" },
				"theta.ai.usage.output_tokens": { type: "number", description: "Reported output tokens" },
				"theta.ai.usage.cache_read_tokens": { type: "number", description: "Reported cache-read tokens" },
				"theta.ai.usage.cache_write_tokens": {
					type: "number",
					description: "Reported cache-write tokens",
				},
				"theta.ai.usage.reasoning_tokens": { type: "number", description: "Reported reasoning tokens" },
				"theta.ai.usage.total_tokens": { type: "number", description: "Reported total tokens" },
				"theta.ai.usage.cost": { type: "number", description: "Reported total cost" },
				"theta.ai.stream.chunk_count": { type: "number", description: "Streamed update chunk count" },
				"theta.ai.stream.time_to_first_chunk_ms": {
					type: "number",
					description: "Elapsed milliseconds to first update chunk",
				},
				"theta.ai.error.type": {
					type: "string",
					cardinality: "low",
					description: "Provider or transport error class",
				},
			},
			status: { default: "ok", errorWhen: "The operation throws or returns an error result" },
		},
	},
} as const satisfies TelemetrySchemaDefinition;

export type AiSpanName = TelemetrySchemaSpanName<typeof AI_TELEMETRY_SCHEMA>;
export type AiSpanStartAttributes<Name extends AiSpanName> = TelemetrySchemaSpanStartAttributes<
	typeof AI_TELEMETRY_SCHEMA,
	Name
>;
export type AiSpanEndAttributes<Name extends AiSpanName> = TelemetrySchemaSpanEndAttributes<
	typeof AI_TELEMETRY_SCHEMA,
	Name
>;
export type AiSpanAttributes<Name extends AiSpanName> = AiSpanStartAttributes<Name> & AiSpanEndAttributes<Name>;
export type AiSpanEventName<Name extends AiSpanName> = TelemetrySchemaSpanEventName<typeof AI_TELEMETRY_SCHEMA, Name>;
export type AiSpanEventAttributes<
	Name extends AiSpanName,
	EventName extends AiSpanEventName<Name>,
> = TelemetrySchemaSpanEventAttributes<typeof AI_TELEMETRY_SCHEMA, Name, EventName>;
export type AiTelemetrySpan<Name extends AiSpanName> = SchemaTelemetrySpan<typeof AI_TELEMETRY_SCHEMA, Name>;
export type AiSpan = TelemetrySchemaSpanUnion<typeof AI_TELEMETRY_SCHEMA>;

export function startAiSpan<Name extends AiSpanName, const Attributes extends AiSpanStartAttributes<Name>, Result>(
	name: Name,
	attributes: ExactTelemetryAttributes<AiSpanStartAttributes<Name>, Attributes>,
	callback: (span: AiTelemetrySpan<Name>, context: Context) => Result | Promise<Result>,
	context: Context,
): Promise<Result> {
	return getTelemetryContext(context).startSpan({ name, attributes }, (span) =>
		callback(span as AiTelemetrySpan<Name>, withTelemetryContext(span, context)),
	);
}

const HOOK_NAMES = [
	"before_run",
	"before_drive",
	"before_run_end",
	"transform_context",
	"before_request",
	"before_payload",
	"after_response",
	"before_tool",
	"after_tool",
	"before_compaction",
	"before_navigation",
] as const;

const EVENT_TYPES = [
	"run_start",
	"run_resume",
	"run_suspend",
	"operation_abort",
	"run_end",
	"fault",
	"handler_error",
	"turn_start",
	"turn_end",
	"retry_scheduled",
	"retry_start",
	"retry_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_start",
	"tool_update",
	"tool_end",
	"entry_added",
	"queue_update",
	"value_update",
	"config_update",
	"compaction_start",
	"compaction_end",
	"navigation_start",
	"navigation_end",
	"lane_created",
	"usage",
] as const;

const operationStartAttributes = {
	"theta.session.id": {
		type: "string",
		required: true,
		cardinality: "high",
		description: "Session id",
	},
	"theta.lane.name": {
		type: "string",
		required: true,
		cardinality: "high",
		description: "Lane name",
	},
	"theta.operation.id": {
		type: "string",
		required: true,
		cardinality: "high",
		description: "Durable operation id",
	},
	"theta.operation.recovery": {
		type: "boolean",
		required: true,
		description: "Whether this invocation resumes durable work",
	},
} as const;

const operationErrorAttributes = {
	"theta.error.code": {
		type: "string",
		cardinality: "low",
		description: "Stable operation error code",
	},
	"theta.error.type": {
		type: "string",
		cardinality: "low",
		description: "Low-cardinality operation error class",
	},
} as const;

export const HARNESS_TELEMETRY_SCHEMA = {
	version: 1,
	spans: {
		"theta.harness.run": {
			description: "One admitted in-process run invocation",
			parents: { kind: "root_or_external" },
			startAttributes: {
				...operationStartAttributes,
				"theta.operation.kind": {
					type: "string",
					required: true,
					values: ["run"],
					description: "Run operation kind",
				},
			},
			endAttributes: {
				"theta.operation.outcome": {
					type: "string",
					values: ["completed", "aborted", "failed", "suspended"],
					description: "Run invocation outcome",
				},
				...operationErrorAttributes,
			},
			status: { default: "ok", errorWhen: "The run fails or throws" },
		},
		"theta.harness.compaction": {
			description: "One admitted in-process manual compaction invocation",
			parents: { kind: "root_or_external" },
			startAttributes: {
				...operationStartAttributes,
				"theta.operation.kind": {
					type: "string",
					required: true,
					values: ["compaction"],
					description: "Compaction operation kind",
				},
			},
			endAttributes: {
				"theta.operation.outcome": {
					type: "string",
					values: ["completed", "declined", "aborted", "failed"],
					description: "Compaction invocation outcome",
				},
				...operationErrorAttributes,
			},
			status: { default: "ok", errorWhen: "The compaction fails or throws" },
		},
		"theta.harness.navigation": {
			description: "One admitted in-process navigation invocation",
			parents: { kind: "root_or_external" },
			startAttributes: {
				...operationStartAttributes,
				"theta.operation.kind": {
					type: "string",
					required: true,
					values: ["navigation"],
					description: "Navigation operation kind",
				},
			},
			endAttributes: {
				"theta.operation.outcome": {
					type: "string",
					values: ["completed", "declined", "aborted", "failed"],
					description: "Navigation invocation outcome",
				},
				...operationErrorAttributes,
			},
			status: { default: "ok", errorWhen: "The navigation fails or throws" },
		},
		"theta.harness.checkpoint": {
			description: "One run checkpoint",
			parents: { kind: "spans", spans: ["theta.harness.run"] },
			startAttributes: {
				"theta.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				"theta.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Durable operation id",
				},
				"theta.checkpoint.kind": {
					type: "string",
					required: true,
					values: ["normal", "abort_reconcile"],
					description: "Checkpoint purpose",
				},
			},
			endAttributes: {},
			status: { default: "ok", errorWhen: "Checkpoint work throws" },
		},
		"theta.harness.turn": {
			description: "One assistant response and its tool batch",
			parents: { kind: "spans", spans: ["theta.harness.run"] },
			startAttributes: {
				"theta.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				"theta.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Durable operation id",
				},
				"theta.turn.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Invocation-local turn id",
				},
			},
			endAttributes: {},
			status: { default: "ok", errorWhen: "Turn work throws" },
		},
		"theta.harness.step": {
			description: "One durable retry attempt",
			parents: {
				kind: "spans",
				spans: ["theta.harness.turn", "theta.harness.checkpoint", "theta.harness.compaction", "theta.harness.navigation"],
			},
			startAttributes: {
				"theta.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				"theta.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Durable operation id",
				},
				"theta.step.kind": {
					type: "string",
					required: true,
					values: ["assistant", "compaction", "branch_summary"],
					description: "Retryable step kind",
				},
				"theta.step.attempt": {
					type: "number",
					required: true,
					description: "One-based durable attempt number",
				},
				"theta.compaction.reason": {
					type: "string",
					required: false,
					values: ["manual", "threshold", "overflow"],
					description: "Compaction trigger",
				},
			},
			endAttributes: {
				"theta.step.outcome": {
					type: "string",
					values: ["succeeded", "retry", "failed", "aborted", "deferred", "overflow"],
					description: "Attempt outcome",
				},
			},
			status: { default: "ok", errorWhen: "The attempt retries, fails, or throws" },
		},
		"theta.harness.tool": {
			description: "One raw phase-2 tool execution",
			parents: { kind: "spans", spans: ["theta.harness.turn", "theta.harness.run"] },
			startAttributes: {
				"theta.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				"theta.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Durable operation id",
				},
				"theta.turn.id": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Invocation-local live turn id",
				},
				"theta.tool.name": {
					type: "string",
					required: true,
					description: "Tool name",
				},
				"theta.tool.call_id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Tool call id",
				},
				"theta.tool.replay": {
					type: "string",
					required: true,
					values: ["never", "safe"],
					description: "Declared replay policy",
				},
				"theta.tool.recovery": {
					type: "boolean",
					required: true,
					description: "Whether this is recovery execution",
				},
			},
			endAttributes: {
				"theta.tool.is_error": {
					type: "boolean",
					description: "Whether raw phase-2 execution returned an error",
				},
			},
			status: { default: "ok", errorWhen: "Raw phase-2 execution returns an error" },
		},
		"theta.harness.hook": {
			description: "One registered hook handler invocation",
			parents: { kind: "any" },
			startAttributes: {
				"theta.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				"theta.operation.id": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Durable operation id when accepted",
				},
				"theta.hook.name": {
					type: "string",
					required: true,
					values: HOOK_NAMES,
					description: "Hook name",
				},
				"theta.hook.registration_id": {
					type: "string",
					required: false,
					description: "Optional hook registration metadata",
				},
			},
			endAttributes: {
				"theta.hook.outcome": {
					type: "string",
					values: ["completed", "skipped", "blocked", "failed"],
					description: "Handler outcome",
				},
			},
			status: { default: "ok", errorWhen: "The handler throws" },
		},
		"theta.harness.sleep": {
			description: "One retry delay",
			parents: {
				kind: "spans",
				spans: [
					"theta.harness.run",
					"theta.harness.compaction",
					"theta.harness.navigation",
					"theta.harness.turn",
					"theta.harness.checkpoint",
				],
			},
			startAttributes: {
				"theta.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Durable operation id",
				},
				"theta.sleep.delay_ms": {
					type: "number",
					required: true,
					description: "Requested delay in milliseconds",
				},
			},
			endAttributes: {
				"theta.sleep.outcome": {
					type: "string",
					values: ["elapsed", "aborted"],
					description: "Delay outcome",
				},
			},
			status: { default: "ok", errorWhen: "Sleep work throws" },
		},
		"theta.harness.event_handler": {
			description: "One passive event listener invocation",
			parents: { kind: "any" },
			startAttributes: {
				"theta.event.type": {
					type: "string",
					required: true,
					cardinality: "low",
					values: EVENT_TYPES,
					description: "Delivered harness event type",
				},
				"theta.lane.name": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Lane name for lane-scoped events",
				},
			},
			endAttributes: {},
			status: { default: "ok", errorWhen: "The listener throws" },
		},
		"theta.session.write": {
			description: "One committed session transaction",
			parents: { kind: "any" },
			startAttributes: {
				"theta.session.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Session id",
				},
				"theta.lane.name": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Lane name when supplied by the caller",
				},
				"theta.operation.id": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Durable operation id when supplied by the caller",
				},
				"theta.session.item_count": {
					type: "number",
					required: true,
					description: "Number of writes in the transaction",
				},
				"theta.session.item_kinds": {
					type: "string[]",
					required: true,
					elementValues: ["entry", "usage", "value", "list"],
					description: "Distinct write kinds in the transaction",
				},
			},
			endAttributes: {
				"theta.session.first_seq": {
					type: "number",
					description: "First committed sequence in the transaction",
				},
				"theta.session.last_seq": {
					type: "number",
					description: "Last committed sequence in the transaction",
				},
			},
			status: { default: "ok", errorWhen: "Storage rejects the transaction" },
		},
	},
} as const satisfies TelemetrySchemaDefinition;

/** Combined typed span vocabulary for agent-owned AI-request and harness telemetry. */
export const AGENT_TELEMETRY_SCHEMAS = [AI_TELEMETRY_SCHEMA, HARNESS_TELEMETRY_SCHEMA] as const;

export type HarnessSpanName = TelemetrySchemaSpanName<typeof HARNESS_TELEMETRY_SCHEMA>;
export type HarnessSpanStartAttributes<Name extends HarnessSpanName> = TelemetrySchemaSpanStartAttributes<
	typeof HARNESS_TELEMETRY_SCHEMA,
	Name
>;
export type HarnessSpanEndAttributes<Name extends HarnessSpanName> = TelemetrySchemaSpanEndAttributes<
	typeof HARNESS_TELEMETRY_SCHEMA,
	Name
>;
export type HarnessSpanAttributes<Name extends HarnessSpanName> = HarnessSpanStartAttributes<Name> &
	HarnessSpanEndAttributes<Name>;
export type HarnessSpanEventName<Name extends HarnessSpanName> = TelemetrySchemaSpanEventName<
	typeof HARNESS_TELEMETRY_SCHEMA,
	Name
>;
export type HarnessSpanEventAttributes<
	Name extends HarnessSpanName,
	EventName extends HarnessSpanEventName<Name>,
> = TelemetrySchemaSpanEventAttributes<typeof HARNESS_TELEMETRY_SCHEMA, Name, EventName>;
export type HarnessTelemetrySpan<Name extends HarnessSpanName> = SchemaTelemetrySpan<
	typeof HARNESS_TELEMETRY_SCHEMA,
	Name
>;
export type HarnessSpan = TelemetrySchemaSpanUnion<typeof HARNESS_TELEMETRY_SCHEMA>;

export function startHarnessSpan<
	Name extends HarnessSpanName,
	const Attributes extends HarnessSpanStartAttributes<Name>,
	Result,
>(
	name: Name,
	attributes: ExactTelemetryAttributes<HarnessSpanStartAttributes<Name>, Attributes>,
	callback: (span: HarnessTelemetrySpan<Name>, context: Context) => Result | Promise<Result>,
	context: Context,
): Promise<Result> {
	return getTelemetryContext(context).startSpan({ name, attributes }, (span: TelemetrySpan) =>
		callback(span as HarnessTelemetrySpan<Name>, withTelemetryContext(span, context)),
	);
}

