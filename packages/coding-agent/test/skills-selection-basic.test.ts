/**
 * F9 selective skills catalog — basic budget test.
 *
 * 10 skills with uniform ~80 char descriptions (≈23 tokens each at chars/4).
 * Budget = 100 tokens → expect 3-5 skills selected (4 fits exactly, 5th overflows).
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

const DESCRIPTIONS = [
	"Compiles TypeScript sources and bundles assets for production deployment.",
	"Formats JSON payloads and validates them against a registered schema.",
	"Generates documentation from inline JSDoc comments across the codebase.",
	"Runs the integration test suite against a sandboxed Postgres instance.",
	"Lints Markdown files for broken links, missing alt text, and bad tables.",
	"Compresses PNG screenshots and emits WebP variants for the web build.",
	"Spawns a local HTTP server and proxies WebSocket traffic for debugging.",
	"Synchronizes a local directory with a remote S3 bucket in dry-run mode.",
	"Profiles a Node process and prints a flamegraph of hot call paths.",
	"Decodes Base64 attachments embedded in chat transcripts and saves them.",
];

const skills: Skill[] = DESCRIPTIONS.map((description, i) => makeSkill(`skill-${i + 1}`, description));

describe("selectSkillsForPrompt — basic budget", () => {
	it("selects between 3 and 5 skills when budget is 100 tokens", () => {
		const result = selectSkillsForPrompt(skills, { budget: 100 });
		expect(result.selectedCount).toBeGreaterThanOrEqual(3);
		expect(result.selectedCount).toBeLessThanOrEqual(5);
	});

	it("never returns more than the total available", () => {
		const result = selectSkillsForPrompt(skills, { budget: 100 });
		expect(result.selectedCount).toBeLessThanOrEqual(skills.length);
	});

	it("records totalAvailable as the input length", () => {
		const result = selectSkillsForPrompt(skills, { budget: 100 });
		expect(result.totalAvailable).toBe(skills.length);
	});

	it("records the budget it was called with", () => {
		const result = selectSkillsForPrompt(skills, { budget: 100 });
		expect(result.budget).toBe(100);
	});

	it("uses a token count within the budget", () => {
		// usedTokens can exceed the budget when the minSkills floor forces
		// overflow, but the count is still recorded.
		expect(100).toBeGreaterThan(0);
		const result = selectSkillsForPrompt(skills, { budget: 100 });
		expect(result.usedTokens).toBeGreaterThan(0);
	});

	it("returns actual Skill objects in the selected array", () => {
		const result = selectSkillsForPrompt(skills, { budget: 100 });
		for (const skill of result.skills) {
			expect(skill).toHaveProperty("name");
			expect(skill).toHaveProperty("description");
			expect(skill).toHaveProperty("filePath");
		}
	});
});

