import type {
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Model,
	Provider,
	ProviderStreamOptions,
	RefreshModelsContext,
} from "@theta/ai";
import { stream, streamSimple } from "@theta/ai/compat";
import { LlamaClient, type LlamaModelInfo, llamaInferenceUrl, normalizeLlamaServerUrl } from "./client.ts";

export const LLAMA_PROVIDER_ID = "llama.cpp";
export const DEFAULT_LLAMA_SERVER_URL = "http://127.0.0.1:8080";
function credentialServerUrl(credential: ApiKeyCredential | undefined): string | undefined {
	const value = credential?.env?.LLAMA_BASE_URL;
	return typeof value === "string" && value.trim() ? normalizeLlamaServerUrl(value) : undefined;
}

async function resolveServerUrl(
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
): Promise<string | undefined> {
	const configured = credentialServerUrl(credential) ?? (await ctx.env("LLAMA_BASE_URL"))?.trim();
	return configured ? normalizeLlamaServerUrl(configured) : undefined;
}

function modelIsSelectable(model: LlamaModelInfo, routerAutoload: boolean): boolean {
	if (model.status.value === "loaded") return true;
	// llama.cpp reports idle-slept models as "sleeping"; requests wake them automatically.
	if (model.status.value === "sleeping") return true;
	// Unloaded presets are routable only when llama.cpp router autoload can load them on first use.
	return routerAutoload && model.status.value === "unloaded" && !model.status.failed && model.source === "preset";
}

async function routerAutoloadEnabled(
	client: LlamaClient,
	catalog: readonly LlamaModelInfo[],
	signal: AbortSignal,
): Promise<boolean> {
	if (!catalog.some((model) => model.status.value === "unloaded" && model.source === "preset")) return false;
	try {
		return (await client.props({ signal })).models_autoload === true;
	} catch {
		return false;
	}
}

// llama-server /props surfaces a few per-model signals that the model catalog does not
// enumerate. Reading them lets the harness pick a sensible capability contract for local
// reasoning models (Qwen3, GPT-OSS, DeepSeek R1, etc.) without forcing the user to hand-edit
// catalog entries. The runtime shape is whatever the server sent; we treat unknown fields
// as `undefined` and let the first available signal win.
type LlamaModelMeta = NonNullable<LlamaModelInfo["meta"]> & {
	reasoning?: boolean;
	architectures?: readonly string[];
	qwen3?: { thinking?: boolean };
};

function detectReasoning(meta: LlamaModelMeta | undefined): boolean {
	if (!meta) return false;
	if (meta.reasoning === true) return true;
	if (Array.isArray(meta.architectures)) {
		for (const arch of meta.architectures) {
			if (typeof arch === "string" && /gpt-oss|deepseek|qwen3|r1/i.test(arch)) return true;
		}
	}
	if (meta.qwen3?.thinking === true) return true;
	return false;
}

function reserveMaxTokens(contextWindow: number): number {
	// Leave room for the system prompt, tool definitions, and prior turns. Cap at 16K so a
	// 200K context window does not request a generation that the local server cannot budget
	// against its KV cache.
	return contextWindow > 8192 ? Math.min(contextWindow * 0.5, 16_384) : Math.floor(contextWindow * 0.5);
}

function toPiModel(model: LlamaModelInfo, serverUrl: string): Model<"openai-completions"> {
	const meta = model.meta as LlamaModelMeta | undefined;
	const nCtx = meta?.n_ctx;
	const nCtxTrain = meta?.n_ctx_train;
	const nCtxUsable = typeof nCtx === "number" && nCtx > 0;
	const nCtxTrainUsable = typeof nCtxTrain === "number" && nCtxTrain > 0;
	// Prefer the live n_ctx (current load) over n_ctx_train (model file's training context).
	// Fall back to n_ctx_train when the server reports no current context, then to 128K.
	const reportedContextWindow = nCtxUsable ? nCtx : nCtxTrainUsable ? nCtxTrain : undefined;
	const contextWindow = reportedContextWindow ?? 128_000;
	if (reportedContextWindow === undefined) {
		// Warning string: "llama.cpp: model <id> reports no n_ctx or n_ctx_train; using 128000 default. Configure a context size on the server (e.g. -c 8192) to silence this warning."
		console.warn(
			`llama.cpp: model ${JSON.stringify(model.id)} reports no n_ctx or n_ctx_train; ` +
				`using 128000 default. Configure a context size on the server (e.g. -c 8192) to silence this warning.`,
		);
	}
	const reasoning = detectReasoning(meta);
	return {
		id: model.id,
		name: model.id,
		api: "openai-completions",
		provider: LLAMA_PROVIDER_ID,
		baseUrl: llamaInferenceUrl(serverUrl),
		reasoning,
		input: model.architecture?.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: reserveMaxTokens(contextWindow),
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsLongCacheRetention: false,
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
			...(reasoning ? { thinkingTokenBudgetField: "thinking_budget_tokens" as const } : {}),
		},
	};
}

export interface LlamaProviderController {
	provider: Provider<"openai-completions">;
	setCatalog(models: readonly LlamaModelInfo[], serverUrl: string, options?: { routerAutoload?: boolean }): void;
}

export function createLlamaProvider(): LlamaProviderController {
	let models: readonly Model<"openai-completions">[] = [];

	const setCatalog = (
		catalog: readonly LlamaModelInfo[],
		serverUrl: string,
		options: { routerAutoload?: boolean } = {},
	): void => {
		models = catalog
			.filter((model) => modelIsSelectable(model, options.routerAutoload === true))
			.map((model) => toPiModel(model, serverUrl));
	};

	const provider: Provider<"openai-completions"> = {
		id: LLAMA_PROVIDER_ID,
		name: "llama.cpp",
		baseUrl: llamaInferenceUrl(DEFAULT_LLAMA_SERVER_URL),
		auth: {
			apiKey: {
				name: "llama.cpp server",
				login: async (interaction): Promise<ApiKeyCredential> => {
					const enteredUrl = await interaction.prompt({
						type: "text",
						message: "llama.cpp server URL",
						placeholder: process.env.LLAMA_BASE_URL ?? DEFAULT_LLAMA_SERVER_URL,
					});
					const serverUrl = normalizeLlamaServerUrl(
						enteredUrl.trim() || process.env.LLAMA_BASE_URL || DEFAULT_LLAMA_SERVER_URL,
					);
					const apiKey = (
						await interaction.prompt({
							type: "secret",
							message: "API key (optional)",
						})
					).trim();
					await new LlamaClient(serverUrl, apiKey || undefined).list({ signal: interaction.signal });
					return {
						type: "api_key",
						key: apiKey || undefined,
						env: { LLAMA_BASE_URL: serverUrl },
					};
				},
				check: async ({ ctx, credential }) => {
					const serverUrl = await resolveServerUrl(ctx, credential);
					return serverUrl
						? { type: "api_key", source: credential ? "stored credential" : "LLAMA_BASE_URL" }
						: undefined;
				},
				resolve: async ({ ctx, credential }): Promise<AuthResult | undefined> => {
					const serverUrl = await resolveServerUrl(ctx, credential);
					if (!serverUrl) return undefined;
					const apiKey = credential?.key ?? (await ctx.env("LLAMA_API_KEY")) ?? "local";
					return {
						auth: { apiKey, baseUrl: llamaInferenceUrl(serverUrl) },
						env: { ...credential?.env, LLAMA_BASE_URL: serverUrl },
						source: credential ? "stored credential" : "LLAMA_BASE_URL",
					};
				},
			},
		},
		getModels: () => models,
		refreshModels: async (context: RefreshModelsContext): Promise<void> => {
			if (context.stored) {
				const restored = context.stored.models.filter(
					(model): model is Model<"openai-completions"> =>
						model.provider === LLAMA_PROVIDER_ID && model.api === "openai-completions",
				);
				if (
					!(await context.publish({
						update: () => {
							models = restored;
						},
					}))
				) {
					return;
				}
			}

			if (!context.allowNetwork || context.signal.aborted || context.credential?.type !== "api_key") return;
			const serverUrl = credentialServerUrl(context.credential);
			if (!serverUrl) return;
			const client = new LlamaClient(serverUrl, context.credential.key);
			const catalog = await client.list({ signal: context.signal });
			if (context.signal.aborted) return;
			const routerAutoload = await routerAutoloadEnabled(client, catalog, context.signal);
			if (context.signal.aborted) return;
			const refreshed = catalog
				.filter((model) => modelIsSelectable(model, routerAutoload))
				.map((model) => toPiModel(model, serverUrl));
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now() },
				update: () => {
					models = refreshed;
				},
			});
		},
		stream: (model, context, options) => stream(model, context, options as ProviderStreamOptions | undefined),
		streamSimple: (model, context, options) => streamSimple(model, context, options),
	};

	return { provider, setCatalog };
}

