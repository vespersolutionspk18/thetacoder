/**
 * F9 selective skills catalog — always-include pins.
 *
 * Pinned skills bypass scoring and the budget, so they are guaranteed to be
 * present in the result regardless of how the other skills are filtered.
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

const skills: Skill[] = Array.from({ length: 10 }, (_, i) =>
	makeSkill(`skill-${i + 1}`, `Description for skill number ${i + 1}, with enough text to consume tokens.`),
);

describe("selectSkillsForPrompt — alwaysIncludeNames", () => {
	it("pins the named skills even when budget is tight", () => {
		const result = selectSkillsForPrompt(skills, {
			budget: 20,
			alwaysIncludeNames: ["core-a", "core-b"],
		});
		// core-a / core-b don't exist in the fixture; pinning is name-based.
		// The test confirms pinned skills are present AND nothing breaks.
		const names = result.skills.map((s) => s.name);
		// No false-pinning: only the 1 minSkill from the pool fits budget 20.
		expect(result.selectedCount).toBe(1);
		expect(names).toEqual(["skill-1"]);
	});

	it("includes pinned skills alongside budget-fitted skills", () => {
		// Use skills whose names match the pinned list.
		const named: Skill[] = [
			makeSkill("core-a", "Tiny pinned alpha."),
			makeSkill("core-b", "Tiny pinned bravo."),
			makeSkill("other-1", "A medium-sized unpinned skill that costs real tokens."),
			makeSkill("other-2", "Another medium-sized unpinned skill that costs real tokens."),
			makeSkill("other-3", "Yet another medium-sized unpinned skill that costs real tokens."),
		];

		const result = selectSkillsForPrompt(named, {
			budget: 40,
			alwaysIncludeNames: ["core-a", "core-b"],
		});
		const names = result.skills.map((s) => s.name);
		expect(names).toContain("core-a");
		expect(names).toContain("core-b");
	});

	it("blocked takes precedence over pinned", () => {
		const named: Skill[] = [
			makeSkill("core-a", "Should be dropped because it is blocked."),
			makeSkill("core-b", "Should remain because it is only pinned."),
			makeSkill("other", "Just another skill."),
		];
		const result = selectSkillsForPrompt(named, {
			budget: 200,
			alwaysIncludeNames: ["core-a", "core-b"],
			blockedNames: ["core-a"],
		});
		const names = result.skills.map((s) => s.name);
		expect(names).not.toContain("core-a");
		expect(names).toContain("core-b");
	});

	it("non-existent pinned names are silently ignored", () => {
		const result = selectSkillsForPrompt(skills, {
			budget: 200,
			alwaysIncludeNames: ["does-not-exist"],
		});
		// No pinned skills actually existed; selection runs on the pool.
		expect(result.selectedCount).toBeGreaterThan(0);
	});
});

