/**
 * F9 selective skills catalog — empty input handling.
 *
 * Empty input produces an empty selection with reason "all" (no filter
 * was needed because there was nothing to filter).
 */

import { describe, expect, it } from "vitest";
import { selectSkillsForPrompt } from "../src/core/skills-selection.ts";

describe("selectSkillsForPrompt — empty input", () => {
	it("returns an empty skills array", () => {
		const result = selectSkillsForPrompt([], { budget: 100 });
		expect(result.skills).toEqual([]);
	});

	it("reports zero totalAvailable and zero selectedCount", () => {
		const result = selectSkillsForPrompt([], { budget: 100 });
		expect(result.totalAvailable).toBe(0);
		expect(result.selectedCount).toBe(0);
	});

	it("reports zero droppedCount and zero usedTokens", () => {
		const result = selectSkillsForPrompt([], { budget: 100 });
		expect(result.droppedCount).toBe(0);
		expect(result.usedTokens).toBe(0);
	});

	it("reports reason 'all' (no filtering was needed)", () => {
		const result = selectSkillsForPrompt([], { budget: 100 });
		expect(result.selectionReason).toBe("all");
	});

	it("still preserves the budget field", () => {
		const result = selectSkillsForPrompt([], { budget: 42 });
		expect(result.budget).toBe(42);
	});

	it("handles budget=0 with empty input", () => {
		const result = selectSkillsForPrompt([], { budget: 0, minSkills: 3 });
		expect(result.skills).toEqual([]);
		expect(result.selectedCount).toBe(0);
		expect(result.selectionReason).toBe("all");
	});
});

