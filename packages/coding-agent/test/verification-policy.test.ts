/**
 * F16 verification policy loader tests.
 *
 * Covers the three tiers:
 *   1. Explicit `.theta/verification.json` file
 *   2. Per-package override (`theta.verification` in `package.json`)
 *   3. Project-shape default
 *
 * The loader is pure, so tests pass a `PolicyLoadInputs` directly
 * (no fixture filesystem needed) and assert the resolved policy.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDefaultPolicy, detectDefaultInputs, loadVerificationPolicy } from "../src/core/verification/policy.ts";

describe("loadVerificationPolicy", () => {
	let worktree: string;
	beforeEach(() => {
		worktree = mkdtempSync(join(tmpdir(), "theta-verify-policy-"));
	});
	afterEach(() => {
		rmSync(worktree, { recursive: true, force: true });
	});

	it("returns a disabled policy when enabled = false", () => {
		const policy = loadVerificationPolicy({ worktreeRoot: worktree, enabled: false });
		expect(policy.enabled).toBe(false);
		expect(policy.checks).toEqual([]);
		expect(policy.source).toEqual({ kind: "default", reason: "verification.enabled = false" });
	});

	it("falls back to the project-shape default when no policy file is present", () => {
		// Create a TypeScript project shape so the default resolver adds a check.
		writeFileSync(join(worktree, "tsconfig.json"), "{}");
		writeFileSync(join(worktree, "vitest.config.ts"), "export default {};\n");

		const policy = loadVerificationPolicy({ worktreeRoot: worktree });

		expect(policy.source.kind).toBe("default");
		const ids = policy.checks.map((c) => c.id);
		expect(ids).toContain("tsc-noEmit");
		expect(ids).toContain("vitest-run");
	});

	it("loads from an explicit policy file when one is provided", () => {
		const policyPath = join(worktree, "verification.json");
		writeFileSync(
			policyPath,
			JSON.stringify({
				version: 1,
				checks: [{ id: "my-check", kind: "test", command: "echo hi" }],
			}),
		);

		const policy = loadVerificationPolicy({ worktreeRoot: worktree, explicitPath: policyPath });

		expect(policy.source).toEqual({ kind: "explicit-file", path: policyPath });
		expect(policy.checks).toHaveLength(1);
		expect(policy.checks[0]!.id).toBe("my-check");
		expect(policy.checks[0]!.command).toBe("echo hi");
	});

	it("loads from `.theta/verification.json` in the worktree", () => {
		mkdirSync(join(worktree, ".theta"));
		writeFileSync(
			join(worktree, ".theta", "verification.json"),
			JSON.stringify({
				version: 1,
				checks: [{ id: "theta-check", kind: "lint", command: "eslint ." }],
			}),
		);

		const policy = loadVerificationPolicy({ worktreeRoot: worktree });

		expect(policy.source.kind).toBe("explicit-file");
		if (policy.source.kind === "explicit-file") {
			expect(policy.source.path).toBe(join(worktree, ".theta", "verification.json"));
		}
		expect(policy.checks.map((c) => c.id)).toEqual(["theta-check"]);
	});

	it("loads from a `theta.verification` block in `package.json`", () => {
		writeFileSync(
			join(worktree, "package.json"),
			JSON.stringify({
				theta: {
					verification: {
						version: 1,
						checks: [{ id: "pkg-check", kind: "typecheck", command: "tsc" }],
					},
				},
			}),
		);

		const policy = loadVerificationPolicy({ worktreeRoot: worktree });

		expect(policy.source).toEqual({ kind: "package-json", path: join(worktree, "package.json") });
		expect(policy.checks.map((c) => c.id)).toEqual(["pkg-check"]);
	});

	it("explicit file wins over package.json and the default", () => {
		writeFileSync(
			join(worktree, "package.json"),
			JSON.stringify({
				theta: { verification: { checks: [{ id: "pkg", command: "echo pkg" }] } },
			}),
		);
		writeFileSync(join(worktree, "tsconfig.json"), "{}");
		const explicit = join(worktree, "explicit.json");
		writeFileSync(explicit, JSON.stringify({ checks: [{ id: "explicit", command: "echo explicit" }] }));

		const policy = loadVerificationPolicy({ worktreeRoot: worktree, explicitPath: explicit });
		expect(policy.source.kind).toBe("explicit-file");
		expect(policy.checks.map((c) => c.id)).toEqual(["explicit"]);
	});

	it("package.json wins over the default", () => {
		writeFileSync(join(worktree, "tsconfig.json"), "{}");
		writeFileSync(join(worktree, "vitest.config.ts"), "");
		writeFileSync(
			join(worktree, "package.json"),
			JSON.stringify({
				theta: { verification: { checks: [{ id: "pkg", command: "echo pkg" }] } },
			}),
		);

		const policy = loadVerificationPolicy({ worktreeRoot: worktree });
		expect(policy.source.kind).toBe("package-json");
		expect(policy.checks.map((c) => c.id)).toEqual(["pkg"]);
	});

	it("clamps concurrency to [1, 16]", () => {
		mkdirSync(join(worktree, ".theta"));
		const high = JSON.stringify({ concurrency: 1000, checks: [] });
		writeFileSync(join(worktree, ".theta", "verification.json"), high);
		const policyHigh = loadVerificationPolicy({ worktreeRoot: worktree });
		expect(policyHigh.concurrency).toBe(16);

		const low = JSON.stringify({ concurrency: -5, checks: [] });
		writeFileSync(join(worktree, ".theta", "verification.json"), low);
		const policyLow = loadVerificationPolicy({ worktreeRoot: worktree });
		expect(policyLow.concurrency).toBe(1);
	});

	it("clamps timeoutMs to a minimum of 1000ms", () => {
		mkdirSync(join(worktree, ".theta"));
		writeFileSync(join(worktree, ".theta", "verification.json"), JSON.stringify({ timeoutMs: 10, checks: [] }));
		const policy = loadVerificationPolicy({ worktreeRoot: worktree });
		expect(policy.timeoutMs).toBe(1000);
	});

	it("infers the parser from the check kind when omitted", () => {
		mkdirSync(join(worktree, ".theta"));
		writeFileSync(
			join(worktree, ".theta", "verification.json"),
			JSON.stringify({
				checks: [
					{ id: "t", kind: "test", command: "vitest" },
					{ id: "l", kind: "lint", command: "biome" },
					{ id: "c", kind: "typecheck", command: "tsc" },
					{ id: "m", kind: "manual", command: "true" },
				],
			}),
		);

		const policy = loadVerificationPolicy({ worktreeRoot: worktree });
		const byId = new Map(policy.checks.map((c) => [c.id, c]));
		expect(byId.get("t")!.parser).toBe("vitest");
		expect(byId.get("l")!.parser).toBe("biome");
		expect(byId.get("c")!.parser).toBe("tsc");
		expect(byId.get("m")!.parser).toBe("raw");
	});

	it("fills in defaults for missing fields on a check", () => {
		mkdirSync(join(worktree, ".theta"));
		writeFileSync(
			join(worktree, ".theta", "verification.json"),
			JSON.stringify({
				checks: [{ id: "minimal", command: "echo ok" }],
			}),
		);
		const policy = loadVerificationPolicy({ worktreeRoot: worktree });
		const check = policy.checks[0]!;
		expect(check.kind).toBe("test"); // default kind
		expect(check.parser).toBe("vitest"); // derived from kind
		expect(check.blocking).toBe(true);
		expect(check.trigger).toBe("on-demand");
	});

	it("skips checks that have no command", () => {
		mkdirSync(join(worktree, ".theta"));
		writeFileSync(
			join(worktree, ".theta", "verification.json"),
			JSON.stringify({
				checks: [{ id: "ok", command: "echo ok" }, { id: "broken" }],
			}),
		);
		const policy = loadVerificationPolicy({ worktreeRoot: worktree });
		expect(policy.checks.map((c) => c.id)).toEqual(["ok"]);
	});
});

describe("detectDefaultInputs", () => {
	let worktree: string;
	beforeEach(() => {
		worktree = mkdtempSync(join(tmpdir(), "theta-verify-detect-"));
	});
	afterEach(() => {
		rmSync(worktree, { recursive: true, force: true });
	});

	it("detects a TypeScript project with vitest", () => {
		writeFileSync(join(worktree, "tsconfig.json"), "{}");
		writeFileSync(join(worktree, "vitest.config.ts"), "");
		const inputs = detectDefaultInputs(worktree);
		expect(inputs.hasTypeScript).toBe(true);
		expect(inputs.hasVitest).toBe(true);
		expect(inputs.hasJest).toBe(false);
	});

	it("detects a Python project with pytest", () => {
		writeFileSync(join(worktree, "pyproject.toml"), "[tool.pytest.ini_options]\n");
		const inputs = detectDefaultInputs(worktree);
		expect(inputs.hasPytest).toBe(true);
		expect(inputs.hasTypeScript).toBe(false);
	});

	it("returns all-false for an empty worktree", () => {
		const inputs = detectDefaultInputs(worktree);
		expect(inputs.hasTypeScript).toBe(false);
		expect(inputs.hasVitest).toBe(false);
		expect(inputs.hasJest).toBe(false);
		expect(inputs.hasBiome).toBe(false);
		expect(inputs.hasEslint).toBe(false);
		expect(inputs.hasPytest).toBe(false);
	});
});

describe("buildDefaultPolicy", () => {
	it("returns an empty check list for an empty worktree", () => {
		const policy = buildDefaultPolicy({
			hasTypeScript: false,
			hasVitest: false,
			hasJest: false,
			hasMocha: false,
			hasPytest: false,
			hasBiome: false,
			hasEslint: false,
			hasTscBinary: false,
			hasTestScript: false,
			hasLintScript: false,
			hasTypecheckScript: false,
			hasBuildScript: false,
		});
		expect(policy.checks).toEqual([]);
	});

	it("picks vitest over jest over mocha over pytest over npm test", () => {
		const policy = buildDefaultPolicy({
			hasTypeScript: true,
			hasVitest: true,
			hasJest: true,
			hasMocha: true,
			hasPytest: true,
			hasBiome: true,
			hasEslint: true,
			hasTscBinary: true,
			hasTestScript: true,
			hasLintScript: true,
			hasTypecheckScript: true,
			hasBuildScript: true,
		});
		const ids = (policy.checks ?? []).map((c) => c.id);
		// One test runner wins.
		expect(
			ids.filter(
				(id) =>
					id === "vitest-run" ||
					id === "jest-run" ||
					id === "mocha-run" ||
					id === "pytest-run" ||
					id === "npm-test",
			),
		).toEqual(["vitest-run"]);
		expect(ids).toContain("tsc-noEmit");
	});

	it("falls back to `npm test` when no runner is detected", () => {
		const policy = buildDefaultPolicy({
			hasTypeScript: false,
			hasVitest: false,
			hasJest: false,
			hasMocha: false,
			hasPytest: false,
			hasBiome: false,
			hasEslint: false,
			hasTscBinary: false,
			hasTestScript: true,
			hasLintScript: false,
			hasTypecheckScript: false,
			hasBuildScript: false,
		});
		expect((policy.checks ?? []).map((c) => c.id)).toEqual(["npm-test"]);
	});
});

