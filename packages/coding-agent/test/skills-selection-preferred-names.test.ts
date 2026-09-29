/**
 * F9 selective skills catalog — preferred names boost.
 *
 * Preferred names get a +10 score boost, so they sort above non-preferred
 * skills and are picked first when the budget is tight.
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

describe("selectSkillsForPrompt — preferredNames", () => {
	it("places the preferred skill first when budget allows one", () => {
		const skills: Skill[] = [
			makeSkill("zulu", "Last alphabetically, no preference."),
			makeSkill("yankee", "Second-to-last alphabetically, no preference."),
			makeSkill("alpha", "Preferred — gets the +10 boost."),
		];
		const result = selectSkillsForPrompt(skills, {
			budget: 20,
			preferredNames: ["alpha"],
		});
		expect(result.skills[0]?.name).toBe("alpha");
	});

	it("preferred skills survive a tight budget over non-preferred skills", () => {
		const skills: Skill[] = Array.from({ length: 10 }, (_, i) =>
			makeSkill(`skill-${i}`, `Description for skill number ${i} that consumes tokens.`),
		);
		// budget 20: only one skill fits; we want the preferred one to be it.
		const result = selectSkillsForPrompt(skills, {
			budget: 20,
			preferredNames: ["skill-7"],
		});
		// Either the first floor skill or the preferred one — depends on minSkills=1.
		// The preferred one must at least be in the candidates that the budget
		// would consider; here we verify it appears in the result.
		const names = result.skills.map((s) => s.name);
		// With minSkills=1, the first sorted skill wins. Stable sort keeps the
		// preferred one (score 10+1=11) ahead of un-preferred (score 1), so the
		// preferred skill should be selected.
		expect(names[0]).toBe("skill-7");
	});

	it("preferred does not change the result when budget fits everything", () => {
		const skills: Skill[] = [makeSkill("a", "x"), makeSkill("b", "y"), makeSkill("c", "z")];
		const result = selectSkillsForPrompt(skills, {
			budget: 1000,
			preferredNames: ["a"],
		});
		expect(result.selectedCount).toBe(3);
	});
});

