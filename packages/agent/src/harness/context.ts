import type { Context, ContextKey } from "@theta/chord";
import {
	awaitWithContext,
	BACKGROUND_CONTEXT,
	createContextKey,
	TODO_CONTEXT,
	withAbortSignal,
	withCancel,
	withContextValue,
	withoutAbortSignal,
} from "@theta/chord/context";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@theta/telemetry";

export {
	awaitWithContext,
	BACKGROUND_CONTEXT,
	type Context,
	type ContextKey,
	createContextKey,
	TODO_CONTEXT,
	withAbortSignal,
	withCancel,
	withContextValue,
	withoutAbortSignal,
};

const TELEMETRY_CONTEXT_KEY = createContextKey<TelemetryContext>("theta.telemetryContext");

/** Return the telemetry parent attached to a context, or the shared no-op parent. */
export function getTelemetryContext(context: Context): TelemetryContext {
	return context.value(TELEMETRY_CONTEXT_KEY) ?? NOOP_TELEMETRY_CONTEXT;
}

/** Derive a context whose telemetry children use the supplied parent or active span. */
export function withTelemetryContext(telemetryContext: TelemetryContext, context: Context): Context {
	return withContextValue(TELEMETRY_CONTEXT_KEY, telemetryContext, context);
}

