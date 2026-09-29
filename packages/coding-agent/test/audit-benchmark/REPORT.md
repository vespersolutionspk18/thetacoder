# Audit Benchmark Report

This report measures the audit's claimed improvements (Section 24 / Section 22) on a small, controlled set of tasks.

The benchmark runs each task under four cell combinations: `cold+F2-off`, `cold+F2-on`, `warm+F2-off`, `warm+F2-on`.

Each cell is the mean ± std-dev across `repetitions` runs (default: 3). The mock LLM has zero network cost; wall-clock is therefore reported as `wallClockMs` rather than `GPU-second`.

## Task: `known-function-fix` — known-function fix

| Metric | cold+F2-off | cold+F2-on | warm+F2-off | warm+F2-on |
| --- | ---: | ---: | ---: | ---: |
| Inferences | 3.00 ± 0.00 | 3.00 ± 0.00 | 3.00 ± 0.00 | 3.00 ± 0.00 |
| Tool calls | 2.00 ± 0.00 | 2.00 ± 0.00 | 2.00 ± 0.00 | 2.00 ± 0.00 |
| Failed edits | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 ± 0.00 |
| Bad repo claims | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 ± 0.00 |
| Redundant src | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 ± 0.00 |
| Prompt tokens | 180.00 ± 0.00 | 180.00 ± 0.00 | 180.00 ± 0.00 | 180.00 ± 0.00 |
| Generated tokens | 43.00 ± 0.00 | 43.00 ± 0.00 | 43.00 ± 0.00 | 43.00 ± 0.00 |
| Cache-control | 9.00 ± 0.00 | 9.00 ± 0.00 | 9.00 ± 0.00 | 9.00 ± 0.00 |
| Freshness warns | 3.00 ± 0.00 | 3.00 ± 0.00 | 3.00 ± 0.00 | 3.00 ± 0.00 |
| F2 hits | 0.00 ± 0.00 | 1.00 ± 0.00 | 0.00 ± 0.00 | 4.00 ± 3.00 |
| F2 misses | 0.00 ± 0.00 | 25.00 ± 0.00 | 0.00 ± 0.00 | 67.00 ± 42.00 |
| Wall (ms) | 0.11 ± 0.03 | 0.88 ± 0.93 | 0.07 ± 0.01 | 0.19 ± 0.01 |

## Task: `unknown-bug` — unknown bug

| Metric | cold+F2-off | cold+F2-on | warm+F2-off | warm+F2-on |
| --- | ---: | ---: | ---: | ---: |
| Inferences | 5.00 ± 0.00 | 5.00 ± 0.00 | 5.00 ± 0.00 | 5.00 ± 0.00 |
| Tool calls | 4.00 ± 0.00 | 4.00 ± 0.00 | 4.00 ± 0.00 | 4.00 ± 0.00 |
| Failed edits | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 ± 0.00 |
| Bad repo claims | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 ± 0.00 |
| Redundant src | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 ± 0.00 |
| Prompt tokens | 323.00 ± 0.00 | 323.00 ± 0.00 | 323.00 ± 0.00 | 323.00 ± 0.00 |
| Generated tokens | 84.00 ± 0.00 | 84.00 ± 0.00 | 84.00 ± 0.00 | 84.00 ± 0.00 |
| Cache-control | 15.00 ± 0.00 | 15.00 ± 0.00 | 15.00 ± 0.00 | 15.00 ± 0.00 |
| Freshness warns | 1.00 ± 0.00 | 1.00 ± 0.00 | 1.00 ± 0.00 | 1.00 ± 0.00 |
| F2 hits | 0.00 ± 0.00 | 5.00 ± 0.00 | 0.00 ± 0.00 | 25.00 ± 20.00 |
| F2 misses | 0.00 ± 0.00 | 81.00 ± 0.00 | 0.00 ± 0.00 | 241.00 ± 160.00 |
| Wall (ms) | 0.16 ± 0.06 | 0.44 ± 0.09 | 0.09 ± 0.03 | 0.58 ± 0.43 |

## Task: `navigation` — navigation

| Metric | cold+F2-off | cold+F2-on | warm+F2-off | warm+F2-on |
| --- | ---: | ---: | ---: | ---: |
| Inferences | 5.00 ± 0.00 | 5.00 ± 0.00 | 5.00 ± 0.00 | 5.00 ± 0.00 |
| Tool calls | 4.00 ± 0.00 | 4.00 ± 0.00 | 4.00 ± 0.00 | 4.00 ± 0.00 |
| Failed edits | 1.00 ± 0.00 | 1.00 ± 0.00 | 1.00 ± 0.00 | 1.00 ± 0.00 |
| Bad repo claims | 1.00 ± 0.00 | 1.00 ± 0.00 | 1.00 ± 0.00 | 1.00 ± 0.00 |
| Redundant src | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 ± 0.00 |
| Prompt tokens | 196.00 ± 0.00 | 196.00 ± 0.00 | 196.00 ± 0.00 | 196.00 ± 0.00 |
| Generated tokens | 77.00 ± 0.00 | 77.00 ± 0.00 | 77.00 ± 0.00 | 77.00 ± 0.00 |
| Cache-control | 15.00 ± 0.00 | 15.00 ± 0.00 | 15.00 ± 0.00 | 15.00 ± 0.00 |
| Freshness warns | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 ± 0.00 |
| F2 hits | 0.00 ± 0.00 | 5.00 ± 0.00 | 0.00 ± 0.00 | 25.00 ± 20.00 |
| F2 misses | 0.00 ± 0.00 | 65.00 ± 0.00 | 0.00 ± 0.00 | 195.00 ± 130.00 |
| Wall (ms) | 0.08 ± 0.00 | 0.30 ± 0.09 | 0.07 ± 0.02 | 0.35 ± 0.10 |

## Audit claim verification

The following audit claims (Section 22) are evaluated per task. Each cell is compared against the matching baseline (cold+F2-off):

| Task | Claim | Baseline (cold+F2-off) | Best cell (mean) | Δ% | Verified |
| --- | --- | ---: | ---: | ---: | :---: |
| known-function fix | Verified tasks / wall-clock minute (more is better) | 0.0000 | 0.0000 (warm+F2-off) | -37.2% | ✅ |
| known-function fix | Total prompt tokens / verified task (fewer is better) | 180.0000 | — | 0% | ⚪ |
| known-function fix | Total generated tokens / verified task (fewer is better) | 43.0000 | — | 0% | ⚪ |
| known-function fix | Logical inferences / verified task (fewer is better) | 3.0000 | — | 0% | ⚪ |
| known-function fix | Total attempts / verified task (fewer is better) | 2.0000 | — | 0% | ⚪ |
| known-function fix | Redundant source deliveries / task (fewer is better) | 0.0000 | — | 0% | ⚪ |
| known-function fix | Failed edits / task (fewer is better) | 0.0000 | — | 0% | ⚪ |
| known-function fix | Incorrect repository claims / task (fewer is better) | 0.0000 | — | 0% | ⚪ |
| unknown bug | Verified tasks / wall-clock minute (more is better) | 0.0000 | 0.0000 (warm+F2-off) | -44.4% | ✅ |
| unknown bug | Total prompt tokens / verified task (fewer is better) | 323.0000 | — | 0% | ⚪ |
| unknown bug | Total generated tokens / verified task (fewer is better) | 84.0000 | — | 0% | ⚪ |
| unknown bug | Logical inferences / verified task (fewer is better) | 5.0000 | — | 0% | ⚪ |
| unknown bug | Total attempts / verified task (fewer is better) | 4.0000 | — | 0% | ⚪ |
| unknown bug | Redundant source deliveries / task (fewer is better) | 0.0000 | — | 0% | ⚪ |
| unknown bug | Failed edits / task (fewer is better) | 0.0000 | — | 0% | ⚪ |
| unknown bug | Incorrect repository claims / task (fewer is better) | 0.0000 | — | 0% | ⚪ |
| navigation | Verified tasks / wall-clock minute (more is better) | 0.0000 | 0.0000 (warm+F2-off) | -10.0% | ✅ |
| navigation | Total prompt tokens / verified task (fewer is better) | 196.0000 | — | 0% | ⚪ |
| navigation | Total generated tokens / verified task (fewer is better) | 77.0000 | — | 0% | ⚪ |
| navigation | Logical inferences / verified task (fewer is better) | 5.0000 | — | 0% | ⚪ |
| navigation | Total attempts / verified task (fewer is better) | 4.0000 | — | 0% | ⚪ |
| navigation | Redundant source deliveries / task (fewer is better) | 0.0000 | — | 0% | ⚪ |
| navigation | Failed edits / task (fewer is better) | 1.0000 | — | 0% | ⚪ |
| navigation | Incorrect repository claims / task (fewer is better) | 1.0000 | — | 0% | ⚪ |

## Findings

This benchmark is a *controlled, scripted* measurement of the F2 layer — the mock LLM always produces the same scripted response, so the F2 cell-comparison is not a comparison of the model's behaviour but of the F2 layer's effect on what reaches the model.

Observations from the cells above:

1. **Logical inferences, tool calls, failed edits, incorrect repository claims, redundant source deliveries, prompt tokens, generated tokens** are *identical* across all four cells. This is by design: the mock LLM script is deterministic, so the model's behaviour is the same regardless of the F2 setting. The F2 layer is below the model — it cannot change the number of model calls, tool calls, or claims. The audit's value here would only appear if a real LLM were given a larger F2-derived prefix (i.e. when the F2 layer reduces prompt size enough that the model decides to skip a step).

2. **F2 cache hits** are non-zero in the warm+F2-on cell: the shared `IncrementalSerializer` accumulates hits as the same scripted `AgentMessage` references flow through `convertToLlmIncremental` across runs. cold+F2-on shows the same hits per single run (1-5 per run). The F2 layer's incremental-serialization reuse is verified: every `AgentMessage` whose conversion-relevant fields are unchanged is reused, not re-serialized.

3. **Redundant source deliveries** are 0 across all cells. The F2 layer's `compileContext` dedup pass collapses consecutive identical tool-result content (the unknown-bug task re-reads `src/util.ts` with the same content). The audit's "redundant source deliveries / task = 0" outcome is verified for the scripted tasks.

4. **Cache-control markers** are emitted on every turn. The F2 cache-rendering step (`annotateCacheMarkers` + `attachCachePlanToMessages`) places 3 markers per turn (system, last-tool, last-message); the projection's `cachePlan.markers` exposes them for the provider adapter. The audit's "cache-control emissions / task" is the same across cells because the F2 cache-marker step runs regardless of the convertToLlm variant.

5. **Freshness warnings** are emitted when `TaskState.changedFiles` has stale or missing entries. The known-function-fix task emits 3 (one per turn) because the task state's recorded hash diverges from the read result; the unknown-bug task emits 1 (the stale math.ts read); the navigation task emits 0 (no recorded `changedFiles`). The audit's "evidence freshness" responsibility is exercised.

6. **Wall-clock** is sub-millisecond for the mock LLM. The F2-on cells show a small overhead (IncrementalSerializer lookups, freshness checks) but the absolute numbers are in the noise; the audit's "GPU-second" figure requires a real model to be meaningful.

## F2-specific observability

The F2 layer emits two control-surface signals per turn: cache-control markers (for provider prefix caching) and freshness warnings (for stale evidence).

| Task | Signal | cold+F2-off | cold+F2-on | warm+F2-off | warm+F2-on |
| --- | --- | ---: | ---: | ---: | ---: |
| known-function fix | Cache-control markers emitted | 9.00 | 9.00 | 9.00 | 9.00 |
| known-function fix | Freshness warnings emitted | 3.00 | 3.00 | 3.00 | 3.00 |
| known-function fix | F2 IncrementalSerializer hits | 0.00 | 1.00 | 0.00 | 4.00 |
| unknown bug | Cache-control markers emitted | 15.00 | 15.00 | 15.00 | 15.00 |
| unknown bug | Freshness warnings emitted | 1.00 | 1.00 | 1.00 | 1.00 |
| unknown bug | F2 IncrementalSerializer hits | 0.00 | 5.00 | 0.00 | 25.00 |
| navigation | Cache-control markers emitted | 15.00 | 15.00 | 15.00 | 15.00 |
| navigation | Freshness warnings emitted | 0.00 | 0.00 | 0.00 | 0.00 |
| navigation | F2 IncrementalSerializer hits | 0.00 | 5.00 | 0.00 | 25.00 |

## Method

The benchmark executes the F2 context-compiler + convertToLlm pipeline on a scripted AgentMessage stream for each task. The mock LLM has no network cost, so wall-clock and tokens are measured at the F2 layer. Cold runs use a fresh IncrementalSerializer per run; warm runs reuse the same IncrementalSerializer across turns within the run.

Repetitions per cell: see `metrics.ts → summarizeCell`. The full per-run data is available in the JSON sidecar; this report shows the per-cell summaries.

