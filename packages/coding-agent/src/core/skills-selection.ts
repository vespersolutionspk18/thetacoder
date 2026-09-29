/**
 * F9 selective skills catalog layer.
 *
 * `formatSkillsForPrompt` exposes the full skill metadata for every request.
 * For callers that want a token-budgeted, relevance-ranked subset, this module
 * provides `selectSkillsForPrompt` — a pure sibling that callers can opt into
 * without changing `formatSkillsForPrompt`'s contract.
 *
 * Selection algorithm:
 *   1. Drop `blockedNames` (blocked takes precedence over pinned).
 *   2. Pin `alwaysIncludeNames` — they bypass scoring and the budget.
 *   3. Score remaining skills: +10 per `preferredNames` match, then a small
 *      compactness bonus/penalty based on description length.
 *   4. Sort by score descending (stable).
 *   5. Walk the sorted list; include each skill while it fits the remaining
 *      budget. The first `minSkills` skills of the post-pin pool are always
 *      included even if they overflow the budget.
 */

import type { Skill } from "./skills.ts";

export type { Skill } from "./skills.ts";

export type SkillSelectionReason = "all" | "budget-capped" | "relevance-filtered" | "budget-and-relevance";

export interface SkillSelection {
	skills: Skill[];
	totalAvailable: number;
	selectedCount: number;
	budget: number;
	usedTokens: number;
	droppedCount: number;
	selectionReason: SkillSelectionReason;
}

export interface SelectSkillsOptions {
	/** Maximum estimated tokens allowed for the selected subset. */
	budget: number;
	/** Minimum number of skills to include from the post-pin pool. Default 1. */
	minSkills?: number;
	/** Names that get a relevance boost. */
	preferredNames?: string[];
	/** Names that are always excluded. */
	blockedNames?: string[];
	/** Token estimator. Default: `Math.ceil(text.length / 4)`. */
	estimator?: (text: string) => number;
	/** Names that are always included regardless of budget or score. */
	alwaysIncludeNames?: string[];
}

const defaultEstimator = (text: string): number => Math.ceil(text.length / 4);

/** Stable sort by `score` descending, preserving input order for ties. */
function stableSortByScoreDesc<T extends { score: number }>(items: T[]): T[] {
	const indexed = items.map((item, index) => ({ item, index }));
	indexed.sort((a, b) => {
		if (b.item.score !== a.item.score) return b.item.score - a.item.score;
		return a.index - b.index;
	});
	return indexed.map((entry) => entry.item);
}

/** Score a skill: +10 per preferred-name match, then a compactness adjustment. */
function scoreSkill(skill: Skill, preferred: Set<string> | undefined): number {
	let score = 0;
	if (preferred?.has(skill.name)) {
		score += 10;
	}
	const len = skill.description.length;
	if (len < 100) score += 1;
	else if (len > 300) score -= 1;
	return score;
}

function estimateSkillTokens(skill: Skill, estimator: (text: string) => number): number {
	return estimator(skill.name) + estimator(skill.description);
}

/**
 * Select a relevance-ranked, token-budgeted subset of skills.
 *
 * Always-include and blocked names are applied first; the rest are scored and
 * walked in score order until the budget is exhausted. The first `minSkills`
 * skills of the post-pin pool are always included even if they overflow.
 */
export function selectSkillsForPrompt(skills: Skill[], options: SelectSkillsOptions): SkillSelection {
	const totalAvailable = skills.length;
	const budget = options.budget;
	const minSkills = options.minSkills ?? 1;
	const estimator = options.estimator ?? defaultEstimator;
	const blocked = new Set(options.blockedNames ?? []);
	const preferred = options.preferredNames ? new Set(options.preferredNames) : undefined;
	const alwaysIncludeSet = new Set(options.alwaysIncludeNames ?? []);

	// Step 1: drop blocked names. Blocked takes priority over pinned.
	const afterBlocked = skills.filter((s) => !blocked.has(s.name));

	// Step 2: split into pinned and pool.
	const pinned: Skill[] = [];
	const pool: Skill[] = [];
	for (const skill of afterBlocked) {
		if (alwaysIncludeSet.has(skill.name)) {
			pinned.push(skill);
		} else {
			pool.push(skill);
		}
	}

	// Step 3: score the pool.
	const scored = pool.map((skill) => ({ skill, score: scoreSkill(skill, preferred) }));

	// Step 4: sort by score desc, stable.
	const sorted = stableSortByScoreDesc(scored);

	// Step 5: walk the sorted list, fitting into the remaining budget.
	const usedFromPinned = pinned.reduce((sum, s) => sum + estimateSkillTokens(s, estimator), 0);
	const remainingBudget = budget - usedFromPinned;
	const minIncludedFromPool = Math.min(minSkills, sorted.length);
	const selectedFromPool: Skill[] = [];
	let used = usedFromPinned;
	let remaining = remainingBudget;

	for (let i = 0; i < sorted.length; i++) {
		const entry = sorted[i];
		if (!entry) continue;
		const cost = estimateSkillTokens(entry.skill, estimator);

		// Honor the floor: always include up to `minIncludedFromPool` from the pool.
		if (i < minIncludedFromPool) {
			selectedFromPool.push(entry.skill);
			used += cost;
			remaining -= cost;
			continue;
		}

		if (cost <= remaining) {
			selectedFromPool.push(entry.skill);
			remaining -= cost;
			used += cost;
		}
	}

	const selected = [...pinned, ...selectedFromPool];
	const selectedCount = selected.length;
	const droppedCount = totalAvailable - selectedCount;

	const poolTotalCost = pool.reduce((sum, s) => sum + estimateSkillTokens(s, estimator), 0);
	const hitBudget = poolTotalCost > remainingBudget;
	const hadBlocked = (options.blockedNames?.length ?? 0) > 0;
	const hadPreference = preferred !== undefined && preferred.size > 0;
	const relevanceFiltered = hadBlocked || hadPreference;
	const droppedAny = droppedCount > 0;

	const selectionReason = pickReason({
		droppedAny,
		relevanceFiltered,
		hitBudget,
	});

	return {
		skills: selected,
		totalAvailable,
		selectedCount,
		budget,
		usedTokens: used,
		droppedCount,
		selectionReason,
	};
}

function pickReason(params: {
	droppedAny: boolean;
	relevanceFiltered: boolean;
	hitBudget: boolean;
}): SkillSelectionReason {
	const { droppedAny, relevanceFiltered, hitBudget } = params;
	if (!droppedAny && !relevanceFiltered) return "all";
	if (hitBudget && relevanceFiltered) return "budget-and-relevance";
	if (hitBudget) return "budget-capped";
	return "relevance-filtered";
}

