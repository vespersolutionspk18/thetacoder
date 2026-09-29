import { type Context, defineService, type JsonValue } from "@theta/chord";

/** Server-built plugin generations available to presentations. */
export interface PresentationPlugins {
	prepareSession(
		request: { readonly sessionId: string; readonly packagePaths: readonly string[] | null },
		context: Context,
	): Promise<JsonValue>;
	reload(context: Context): Promise<JsonValue>;
}

export const PresentationPlugins = defineService<PresentationPlugins>("theta.presentation-plugins");

/** Plugin facets hosted in the currently attached Session worker. */
export interface SessionPlugins {
	reload(context: Context): Promise<void>;
}

export const SessionPlugins = defineService<SessionPlugins>("theta.session-plugins");

