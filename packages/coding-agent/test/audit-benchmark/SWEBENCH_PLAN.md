# SWE-bench Verified Comparison Plan

Goal: measure whether the audit's 11 findings move the needle on real coding tasks.
Compare `theta-on-M3` (with audit features on) against the published M3 SWE-bench Verified
score, and run a 4-cell × 3-rep ablation on a 50-instance subset to measure effect sizes.

## 1. Reference: MiniMax-M3 on SWE-bench Verified

| Source | Score | Methodology |
|---|---|---|
| MiniMax model card (vendor) | **80.5%** | Claude Code scaffold, internal infra, 4 runs averaged, default system prompt overridden |
| vals.ai (independent) | **75.00%** | Official MiniMax API, temp 1, top_p 0.95, 512k max output tokens |
| ofox.ai note (third-party) | unverified | Cites M3 SWE-Bench Verified as 80.5%, but M3's own table omits the score, so treat as vendor-replay |

**Canonical reference: 80.5%** (model card, replicated by 4+ third-party sites).
**Independent floor: 75.0%** (vals.ai).

The 80.5% was scaffolded with Claude Code, not theta. The audit's experimental question
is therefore: **same model (M3), different scaffold (theta vs Claude Code) — does theta
beat the published number?**

The 4-cell ablation measures a different question: **does the audit's scaffolding change
(theta's own features) measurably improve the model's score on the same instances?**

Both questions are answered by one experimental design.

## 2. Experimental design

**50 SWE-bench Verified instances** selected for diversity:

| Axis | Spread |
|---|---|
| Repository | mix of popular Python repos (django, flask, requests, pandas, scikit-learn, sympy, astropy, matplotlib, scrapy, …) |
| Difficulty | instance-level complexity scores from SWE-bench metadata |
| Edit shape | single-file / multi-file / cross-cutting |
| Task type | bug fix / feature add / test addition / refactor |
| Codebase size | small (≤2k LOC) / medium / large (≥50k LOC) |

**4 cells** (theta configuration; same M3 model across all four):

| Cell | Audit features |
|---|---|
| `base` | theta with all F1-F11 OFF (theta without audit scaffolding) |
| `f1-only` | F1 repository intelligence ON, F2-F11 OFF |
| `f2-only` | F2 context compiler + cache control + freshness ON, F1+F3-F11 OFF |
| `all-on` | F1 + F2 + F3 + F4 + F5 + F6 + F7 + F8 + F9 + F10 + F11 ON (full audit scaffolding) |

**3 reps per cell per instance** → 50 × 4 × 3 = **600 runs** total.

Headline metrics per (cell, instance):
- pass/fail against the SWE-bench Verified test suite (binary)
- wall-clock time
- prompt tokens, output tokens, cache-hit tokens, total cost
- F7 telemetry: tool-call count, model-call count, edit-failed count, redundant-source count
- F2 telemetry: cache-control emissions, freshness warnings, IncrementalSerializer hits

Statistical analysis (between cells on matched instances, paired):
- mean pass rate, std-dev
- 95% CI per cell
- paired t-test (cell-A vs cell-B) on per-instance pass rate (1/0 per rep, 3 reps averaged)
- Cohen's d effect size
- 4 cells × 3 pairwise comparisons (base vs f1, base vs f2, base vs all-on, f2 vs all-on)

Headline numbers:
- **`theta-on-M3 all-on pass rate`** vs **80.5%** (M3 model card) — single-shot comparison
- **`base` cell pass rate** vs **80.5%** — sanity check that theta without audit doesn't tank M3
- **Effect size of all-on vs base** — internal theta ablation
- **Per-claim verification** — does each audit claim (50-80% fewer structural discovery,
  20-50% fewer prompt tokens, 15-40% fewer model calls) hold on real instances?

## 3. SWE-bench harness design

The official SWE-bench Verified harness uses Docker. We need:

1. **Instance loader** — read SWE-bench Verified metadata from
   `princeton-nlp/SWE-bench_Verified` on HuggingFace, or the official JSON.
2. **Workspace bootstrap** — for each instance, check out the target repo at the
   pre-PR commit, materialize a working copy.
3. **Theta invocation** — spawn `theta` (or its `coding-agent` programmatic API)
   with a prompt that contains the SWE-bench issue text + repo state.
4. **Patch extraction** — collect theta's edits, format as a unified diff.
5. **Test runner** — apply the patch to the repo, run the SWE-bench test command
   inside a SWE-bench Docker image (`swebench/<repo>:<instance>`), capture pass/fail.
6. **F7 telemetry capture** — theta already emits `theta.ai.request` and `theta.harness.tool`
   spans; the harness just needs to surface them in a per-run metrics file.

Two options for the test runner:

- **Option A (recommended)**: use the official `swebench` Python package with Docker.
  Pros: official, tested, runs the real SWE-bench test command. Cons: requires Python
  env + Docker.
- **Option B**: run the test command directly in the cloned repo after applying the
  patch. Pros: no Docker, faster. Cons: bypasses SWE-bench's environment guarantees
  (dependency pinning, etc.) — results may not match the official number.

The user's machine has Docker installed but the daemon is not running. **Option A
requires starting Docker Desktop; Option B works without it but the scores won't be
strictly comparable to the published 80.5%.**

## 4. Cost & time estimates

Per-instance token usage (real-world agents, not mocks):

| Phase | Input tokens | Output tokens |
|---|---:|---:|
| Repo discovery (read files, grep) | 200k-500k | 5k-15k |
| Editing (multi-turn) | 100k-400k | 10k-30k |
| Test runs + iteration | 50k-200k | 5k-20k |
| **Per instance** | **~500k-1.5M** | **~30k-80k** |

M3 pricing: $0.60/M input, $2.40/M output, $0.06/M cache-read (10% of input).

| Scenario | Per run | 600 runs |
|---|---:|---:|
| Conservative (small instances) | $0.40 | $240 |
| Median | $0.80 | $480 |
| Aggressive (large repos, no cache) | $1.50 | $900 |

With F2 cache control the F2-only and all-on cells should land 30-50% below the
base and F1-only cells. Realistic total: **$300-$700** for the full study.

Wall time per instance: 3-10 min (real agents). Single-threaded = 30-100 hours.
With 4-8 worker parallelism = 4-25 hours.

**Recommended: 8-way parallelism on a multi-core box, target ~8-15 hours wall time.**

## 5. Worker breakdown

| # | Worker | Scope | Time | Cost |
|---|---|---|---|---|
| 1 | **harness** | Build the SWE-bench runner: instance loader, theta invocation, patch extraction, Docker-based test runner, per-run metrics file. Includes a single-instance smoke test against a known SWE-bench instance (e.g. `django__django-11099`) to verify the harness end-to-end. | 1.5 days | — |
| 2 | **selector** | Pick 50 instances from SWE-bench Verified metadata, stratified by repo/difficulty/edit-shape/task-type. Produce a JSON list + a per-instance difficulty estimate. | 0.5 day | — |
| 3 | **provider** | Wire `theta` to call MiniMax M3 via OpenAI-compatible API. Verify the API key + endpoint work end-to-end with a 5-turn test conversation. Add the model to theta's `models.generated.ts` registry if missing. | 0.5 day | — |
| 4 | **harness + ablation** | Glue harness + provider + selector. Run all 600 runs (4 cells × 3 reps × 50 instances) with 8-way parallelism. Capture F7 telemetry per run. | 12-15 hours wall | $300-$700 |
| 5 | **report** | Aggregate per-cell metrics, compute paired t-test + Cohen's d, render `AUDIT_REPORT.md` with per-claim verification table (✅/❌/⚠️), per-cell pass-rate vs 80.5%, audit savings claims vs measured savings. | 1.5 days | — |

Workers 1, 2, 3 can run **in parallel** (they don't depend on each other until step 4).
Worker 4 starts once all three are merged. Worker 5 starts once worker 4 has data.

## 6. Prerequisites (need user confirmation)

1. **Docker Desktop running** — verified required for Option A (official SWE-bench harness).
   The Docker binary is installed but the daemon is not running. User must start it.
   - Command: open Docker Desktop from Start menu, or `Start-Service com.docker.service`
   - If user can't run Docker, fall back to Option B (no-Docker, scores not strictly comparable)

2. **MiniMax M3 API access** — OpenAI-compatible API endpoint + API key. None of the
   standard env vars (`MINIMAX_API_KEY`, `M3_API_KEY`) or theta config paths have
   these set. User must provide:
   - `MINIMAX_API_KEY` env var
   - `MINIMAX_BASE_URL` env var (default: `https://api.MiniMax.com/v1` if unknown, must confirm)
   - The model id (likely `MiniMax-M3` or `MiniMax/MiniMax-M3`)

3. **Network** — outbound HTTPS to GitHub (clone repos), HuggingFace (load SWE-bench
   metadata), and the MiniMax API. Verify before scheduling the run.

4. **Compute budget** — confirm the $300-$700 cost is acceptable. Worker 4 will spend
   the money; it cannot be paused mid-run. If budget is tighter, the user can
   pre-empt the run by killing the harness.

5. **Git permission** — workers will clone the SWE-bench instance repos (django, flask,
   requests, etc.) at specific commits. No commits to them. No worktree changes in the
   main theta repo. (User's standing no-git rule applies to the main repo; SWE-bench
   clones live in a separate scratch dir.)

## 7. Open questions

- **Subset vs full 500**: 50 instances is the recommended subset. If we want tighter
  statistical power, 100 instances × 4 cells × 3 reps = 1200 runs, ~$600-$1400, 24+ hours.
- **Cell choice**: 4 cells is the baseline. If F3-F11 effects are not the headline,
  we could collapse to 3 cells (`base`, `f1-only`, `f2-only`) and add a `f1+f2` cell
  for the cross-effect.
- **Rep count**: 3 reps gives some power but tighter numbers need 5-10 reps. Each extra
  rep is 1/3 to 1/2 of the previous cost.
- **Output format**: the report could be a `AUDIT_REPORT.md` like the mock benchmark's
  `REPORT.md`, or a richer format with per-instance breakdowns and a CSV sidecar.
- **What we do if `base` cell beats `all-on`**: the audit's central claim is that the
  features help, not hurt. If the result goes the other way, the report needs to call
  this out honestly and investigate which feature regresses.

## 8. Plan if prereqs are not met

- **No Docker** → fall back to Option B (no-Docker harness), accept that scores are not
  strictly comparable to 80.5%. Still useful as an internal ablation.
- **No M3 API key** → cannot run. The audit has no other model of comparable capability
  on the same pricing tier. Could substitute a different model (e.g. Claude Sonnet 4.5)
  but the headline number changes — no longer M3 vs M3, becomes Claude-Sonnet vs Claude-Sonnet.
- **Network issues** → diagnose case by case. Most likely culprit is corporate proxy
  blocking Docker pulls or HF downloads.

## 9. Deliverable

`AUDIT_REPORT.md` placed next to this plan, containing:
- 80.5% reference + methodology
- per-cell pass rate with 95% CI
- per-cell mean tokens / cost / wall time
- paired t-test results (cell-A vs cell-B on matched instances)
- Cohen's d effect sizes
- per-claim verification table mapping the original 11 audit claims to measured savings
- ✅/❌/⚠️ verdict per audit claim
- raw per-run data in `AUDIT_REPORT.json` sidecar

