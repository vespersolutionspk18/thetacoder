/**
 * F9 selective skills catalog — accounting fields.
 *
 * Verifies that `SkillSelection` fields are populated consistently with the
 * selected subset and the original input.
 */

import { describe, expect, it } from "vitest";
import { type Skill, selectSkillsForPrompt } from "../src/core/skills-selection.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

function makeSkill(name: string, description: string): Skill {
	return {
		name,
		description,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: createSyntheticSourceInfo(`/skills/${name}/SKILL.md`, { source: "test" }),
		disableModelInvocation: false,
	};
}

// Each skill costs ~10 tokens (4-char name + 32-char description).
const skills: Skill[] = [
	makeSkill("aaaa", "x".repeat(32)),
	makeSkill("bbbb", "x".repeat(32)),
	makeSkill("cccc", "x".repeat(32)),
	makeSkill("dddd", "x".repeat(32)),
	makeSkill("eeee", "x".repeat(32)),
	makeSkill("ffff", "x".repeat(32)),
];

describe("selectSkillsForPrompt — accounting", () => {
	it("selectedCount matches the skills array length", () => {
		const result = selectSkillsForPrompt(skills, { budget: 100 });
		expect(result.selectedCount).toBe(result.skills.length);
	});

	it("droppedCount + selectedCount equals totalAvailable", () => {
		const result = selectSkillsForPrompt(skills, { budget: 25 });
		expect(result.droppedCount + result.selectedCount).toBe(result.totalAvailable);
	});

	it("usedTokens is the sum of selected skill costs", () => {
		const estimator = (text: string) => Math.ceil(text.length / 4);
		const result = selectSkillsForPrompt(skills, { budget: 1000, estimator });
		const expected = result.skills.reduce((sum, s) => sum + estimator(s.name) + estimator(s.description), 0);
		expect(result.usedTokens).toBe(expected);
	});

	it("selectionReason is one of the four documented values", () => {
		const valid = new Set(["all", "budget-capped", "relevance-filtered", "budget-and-relevance"]);
		const r1 = selectSkillsForPrompt(skills, { budget: 1000 });
		const r2 = selectSkillsForPrompt(skills, { budget: 10 });
		const r3 = selectSkillsForPrompt(skills, { budget: 1000, blockedNames: ["aaaa"] });
		const r4 = selectSkillsForPrompt(skills, { budget: 10, blockedNames: ["aaaa"] });
		for (const result of [r1, r2, r3, r4]) {
			expect(valid.has(result.selectionReason)).toBe(true);
		}
	});

	it("custom estimator is honored in usedTokens", () => {
		// estimator: (text) => text.length — cost = name.length + description.length.
		const result = selectSkillsForPrompt(skills, {
			budget: 1000,
			estimator: (text: string) => text.length,
		});
		const expected = result.skills.reduce((sum, s) => sum + s.name.length + s.description.length, 0);
		expect(result.usedTokens).toBe(expected);
	});

	it("totalAvailable reflects the input array length, not the post-filter size", () => {
		const result = selectSkillsForPrompt(skills, {
			budget: 100,
			blockedNames: ["aaaa", "bbbb"],
		});
		expect(result.totalAvailable).toBe(skills.length);
	});

	it("budget field echoes the caller's value", () => {
		const result = selectSkillsForPrompt(skills, { budget: 73 });
		expect(result.budget).toBe(73);
	});
});

