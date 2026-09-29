/**
 * F9 selective skills catalog — blocked names filter.
 *
 * Blocked skills are removed before scoring and budgeting. They never appear
 * in the result, even if pinned.
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

const skills: Skill[] = [
	makeSkill("alpha", "First skill with a short description."),
	makeSkill("bravo", "Second skill with a short description."),
	makeSkill("charlie", "Third skill with a short description."),
	makeSkill("delta", "Fourth skill with a short description."),
	makeSkill("echo", "Fifth skill with a short description."),
	makeSkill("foxtrot", "Sixth skill with a short description."),
	makeSkill("golf", "Seventh skill with a short description."),
	makeSkill("hotel", "Eighth skill with a short description."),
	makeSkill("india", "Ninth skill with a short description."),
	makeSkill("juliet", "Tenth skill with a short description."),
];

describe("selectSkillsForPrompt — blockedNames", () => {
	it("removes blocked skills from the result", () => {
		const result = selectSkillsForPrompt(skills, {
			budget: 200,
			blockedNames: ["bravo"],
		});
		const names = result.skills.map((s) => s.name);
		expect(names).not.toContain("bravo");
	});

	it("reduces totalAvailable accounting by the blocked count", () => {
		const result = selectSkillsForPrompt(skills, {
			budget: 200,
			blockedNames: ["alpha", "bravo", "charlie"],
		});
		// totalAvailable is the original input size, droppedCount reflects removals.
		expect(result.totalAvailable).toBe(10);
		expect(result.droppedCount).toBeGreaterThanOrEqual(3);
	});

	it("never lets a blocked skill back in even when pinned", () => {
		const result = selectSkillsForPrompt(skills, {
			budget: 200,
			blockedNames: ["alpha"],
			alwaysIncludeNames: ["alpha"],
		});
		const names = result.skills.map((s) => s.name);
		expect(names).not.toContain("alpha");
	});

	it("block list with no matches leaves the selection unchanged", () => {
		const all = selectSkillsForPrompt(skills, { budget: 200 });
		const none = selectSkillsForPrompt(skills, {
			budget: 200,
			blockedNames: ["unknown-skill"],
		});
		expect(none.selectedCount).toBe(all.selectedCount);
	});
});

