/**
 * F9 selective skills catalog — system-prompt wiring.
 *
 * `buildSystemPrompt` must thread `skillsBudgetTokens` into
 * `selectSkillsForPrompt` so large installed catalogs stop growing the
 * stable prompt prefix. Without a budget the full visible catalog is
 * injected byte-for-byte (the existing `formatSkillsForPrompt` contract).
 */
import { describe, expect, it } from "vitest";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

function makeSkill(name: string, description: string): Skill {
	return {
		name,
		description,
		filePath: `skills/${name}/SKILL.md`,
		baseDir: `skills/${name}`,
		sourceInfo: createSyntheticSourceInfo(`skills/${name}/SKILL.md`, {
			source: "test",
		}),
		disableModelInvocation: false,
	};
}

const tools = ["read", "bash", "edit", "write"];

describe("buildSystemPrompt — skills catalog budget (F9)", () => {
	it("includes every visible skill when no budget is set", () => {
		const skills = [makeSkill("alpha", "a".repeat(200)), makeSkill("beta", "b".repeat(200))];
		const prompt = buildSystemPrompt({ cwd: "/tmp/x", selectedTools: tools, skills });
		expect(prompt).toContain("alpha");
		expect(prompt).toContain("beta");
	});

	it("drops the lowest-ranked skills when the budget is small", () => {
		const skills = [
			makeSkill("alpha", "short"),
			makeSkill("beta", "short"),
			makeSkill("gamma", "short"),
			makeSkill("delta", "long description ".repeat(30)),
		];
		const prompt = buildSystemPrompt({
			cwd: "/tmp/x",
			selectedTools: tools,
			skills,
			skillsBudgetTokens: 20,
		});
		// `alpha` (first compact skill) survives the budget; the verbose
		// `delta` must be dropped. The exact cut depends on the estimator,
		// so assert the invariant: not every skill is present.
		expect(prompt).toContain("alpha");
		expect(prompt).not.toContain("delta");
		// The dropped-count note must tell the model the catalog is partial.
		expect(prompt).toMatch(/more skills are installed but not shown/);
	});

	it("excludes disableModelInvocation skills regardless of budget", () => {
		const hidden: Skill = { ...makeSkill("hidden", "should never appear"), disableModelInvocation: true };
		const visible = makeSkill("visible", "shown");
		const prompt = buildSystemPrompt({
			cwd: "/tmp/x",
			selectedTools: tools,
			skills: [hidden, visible],
			skillsBudgetTokens: 1000,
		});
		expect(prompt).toContain("visible");
		expect(prompt).not.toContain("hidden");
	});

	it("keeps the custom-prompt path under the budget too", () => {
		const skills = [makeSkill("alpha", "short"), makeSkill("delta", "long description ".repeat(30))];
		const prompt = buildSystemPrompt({
			cwd: "/tmp/x",
			selectedTools: tools,
			customPrompt: "Custom prompt.",
			skills,
			skillsBudgetTokens: 20,
		});
		expect(prompt).toContain("alpha");
		expect(prompt).not.toContain("delta");
		expect(prompt).toMatch(/more skills are installed but not shown/);
	});
});

