/**
 * F9 selective skills catalog — budget zero with minSkills floor.
 *
 * Even when the budget is 0, `minSkills` forces at least that many skills
 * to be returned so the caller never gets an empty list by accident.
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

const skills: Skill[] = Array.from({ length: 6 }, (_, i) =>
	makeSkill(`s${i}`, `Description ${i} that costs some tokens.`),
);

describe("selectSkillsForPrompt — budget=0, minSkills floor", () => {
	it("returns exactly minSkills skills when budget is zero", () => {
		const result = selectSkillsForPrompt(skills, { budget: 0, minSkills: 2 });
		expect(result.selectedCount).toBe(2);
	});

	it("the floor never exceeds the available pool", () => {
		const tiny: Skill[] = [makeSkill("only", "only skill")];
		const result = selectSkillsForPrompt(tiny, { budget: 0, minSkills: 5 });
		expect(result.selectedCount).toBe(1);
	});

	it("floor defaults to 1 when minSkills is omitted", () => {
		const result = selectSkillsForPrompt(skills, { budget: 0 });
		expect(result.selectedCount).toBe(1);
	});

	it("budget value of zero is recorded as-is on the selection", () => {
		const result = selectSkillsForPrompt(skills, { budget: 0, minSkills: 1 });
		expect(result.budget).toBe(0);
	});

	it("usedTokens reflects the floor overflow", () => {
		const result = selectSkillsForPrompt(skills, { budget: 0, minSkills: 2 });
		// Cost is non-zero, so usedTokens must be > 0 (the floor overflows).
		expect(result.usedTokens).toBeGreaterThan(0);
	});
});

