import { describe, expect, it, vi } from "vitest";
import type { LlamaModelInfo } from "../src/extensions/llama/client.ts";
import { createLlamaProvider } from "../src/extensions/llama/provider.ts";

// The runtime meta shape returned by llama-server /props includes capability fields that
// the typed `meta` definition does not enumerate. Tests cast through a helper to keep the
// fixture type-checked without expanding the production type surface.
type MetaWithCapabilities = NonNullable<LlamaModelInfo["meta"]> & {
	reasoning?: boolean;
	architectures?: readonly string[];
	qwen3?: { thinking?: boolean };
};

type ModelFixture = Omit<LlamaModelInfo, "meta"> & { meta?: MetaWithCapabilities };

function modelWith(meta: MetaWithCapabilities | undefined): ModelFixture {
	return {
		id: "fixture",
		status: { value: "loaded" },
		...(meta ? { meta: meta as NonNullable<LlamaModelInfo["meta"]> } : {}),
	};
}

function loadModel(
	meta: MetaWithCapabilities | undefined,
): ReturnType<ReturnType<typeof createLlamaProvider>["provider"]["getModels"]>[number] {
	const controller = createLlamaProvider();
	controller.setCatalog([modelWith(meta)], "http://localhost:8080");
	const models = controller.provider.getModels();
	return models[0]!;
}

describe("llama provider capability contract", () => {
	it("toPiModel with n_ctx_train only uses n_ctx_train when n_ctx is missing", () => {
		const model = loadModel({ n_ctx_train: 32_000 });
		expect(model.contextWindow).toBe(32_000);
	});

	it("toPiModel with both n_ctx and n_ctx_train prefers n_ctx", () => {
		const model = loadModel({ n_ctx: 8_192, n_ctx_train: 131_072 });
		expect(model.contextWindow).toBe(8_192);
	});

	it("toPiModel treats n_ctx=0 the same as missing and falls back to n_ctx_train", () => {
		const model = loadModel({ n_ctx: 0, n_ctx_train: 16_384 });
		expect(model.contextWindow).toBe(16_384);
	});

	it("toPiModel warns and falls back to 128000 when both n_ctx and n_ctx_train are missing", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const model = loadModel(undefined);
			expect(model.contextWindow).toBe(128_000);
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0]?.[0]).toContain("n_ctx or n_ctx_train");
			expect(warnSpy.mock.calls[0]?.[0]).toContain("128000");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("toPiModel does not warn when at least one of n_ctx or n_ctx_train is present", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			loadModel({ n_ctx: 4_096 });
			loadModel({ n_ctx_train: 4_096 });
			loadModel({ n_ctx: 0, n_ctx_train: 4_096 });
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("toPiModel with qwen3 architecture enables reasoning and wires thinkingTokenBudgetField", () => {
		const model = loadModel({ n_ctx: 32_768, architectures: ["qwen3moe"] });
		expect(model.reasoning).toBe(true);
		expect(model.compat?.thinkingTokenBudgetField).toBe("thinking_budget_tokens");
	});

	it("toPiModel with explicit meta.reasoning=true enables reasoning", () => {
		const model = loadModel({ n_ctx: 8_192, reasoning: true });
		expect(model.reasoning).toBe(true);
		expect(model.compat?.thinkingTokenBudgetField).toBe("thinking_budget_tokens");
	});

	it("toPiModel with qwen3.thinking=true enables reasoning", () => {
		const model = loadModel({ n_ctx: 8_192, qwen3: { thinking: true } });
		expect(model.reasoning).toBe(true);
		expect(model.compat?.thinkingTokenBudgetField).toBe("thinking_budget_tokens");
	});

	it("toPiModel with gpt-oss architecture enables reasoning", () => {
		const model = loadModel({ n_ctx: 8_192, architectures: ["gpt-oss"] });
		expect(model.reasoning).toBe(true);
	});

	it("toPiModel with deepseek-r1 architecture enables reasoning", () => {
		const model = loadModel({ n_ctx: 8_192, architectures: ["deepseek-r1-distill"] });
		expect(model.reasoning).toBe(true);
	});

	it("toPiModel with no reasoning signals leaves reasoning=false and omits thinkingTokenBudgetField", () => {
		const model = loadModel({ n_ctx: 8_192 });
		expect(model.reasoning).toBe(false);
		expect(model.compat?.thinkingTokenBudgetField).toBeUndefined();
	});

	it("toPiModel with non-reasoning architecture leaves reasoning=false", () => {
		const model = loadModel({ n_ctx: 8_192, architectures: ["llama"] });
		expect(model.reasoning).toBe(false);
		expect(model.compat?.thinkingTokenBudgetField).toBeUndefined();
	});

	it("toPiModel cap of maxTokens for 8K context leaves headroom below the full context", () => {
		const model = loadModel({ n_ctx: 8_192 });
		expect(model.maxTokens).toBeLessThan(8_192);
		expect(model.maxTokens).toBe(4_096);
	});

	it("toPiModel cap of maxTokens for 200K context clamps to the 16K ceiling", () => {
		const model = loadModel({ n_ctx: 200_000 });
		expect(model.maxTokens).toBe(16_384);
	});

	it("toPiModel cap of maxTokens for 32K context uses half the window", () => {
		const model = loadModel({ n_ctx: 32_768 });
		expect(model.maxTokens).toBe(16_384);
	});

	it("toPiModel cap of maxTokens for 4K context uses half the window", () => {
		const model = loadModel({ n_ctx: 4_096 });
		expect(model.maxTokens).toBe(2_048);
	});

	it("toPiModel always sets the local-only compat flags", () => {
		const model = loadModel({ n_ctx: 8_192 });
		expect(model.compat).toEqual(
			expect.objectContaining({
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				supportsLongCacheRetention: false,
				supportsUsageInStreaming: true,
				supportsStrictMode: false,
				maxTokensField: "max_tokens",
			}),
		);
	});
});

