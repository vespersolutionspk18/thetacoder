/**
 * F1 getRelevantContext — keywords hint (lexical matching).
 *
 * Keywords should drive a soft lexical match: any file whose path
 * contains the keyword, and any symbol whose name contains the
 * keyword, is included with a low score.
 */

import { describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { getRelevantContext } from "../src/core/repository/relevant-context.ts";
import type { SymbolEntry } from "../src/core/repository/syntax-index.ts";

function makeManifest(): FileManifestEntry[] {
	return [
		{
			path: "src/auth/login.ts",
			absolutePath: "/abs/src/auth/login.ts",
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		},
		{
			path: "src/auth/session.ts",
			absolutePath: "/abs/src/auth/session.ts",
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		},
		{
			path: "src/user/profile.ts",
			absolutePath: "/abs/src/user/profile.ts",
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		},
		{
			path: "src/utils.ts",
			absolutePath: "/abs/src/utils.ts",
			byteLength: 0,
			language: "typescript",
			generated: false,
			ignored: false,
		},
	];
}

function makeIndex(): SymbolEntry[] {
	return [
		{
			kind: "function",
			name: "authenticateUser",
			path: "src/auth/login.ts",
			startLine: 1,
			endLine: 5,
			language: "typescript",
		},
		{
			kind: "function",
			name: "getUser",
			path: "src/user/profile.ts",
			startLine: 3,
			endLine: 3,
			language: "typescript",
		},
	];
}

describe("getRelevantContext — keywords", () => {
	it("matches files whose path contains any keyword", async () => {
		const result = await getRelevantContext(
			{ task: "auth related", hints: { keywords: ["auth"] } },
			makeManifest(),
			makeIndex(),
		);
		const files = result.items.filter((i) => i.kind === "file");
		const filePaths = files.map((f) => (f as { path: string }).path).sort();
		expect(filePaths).toContain("src/auth/login.ts");
		expect(filePaths).toContain("src/auth/session.ts");
		expect(filePaths).not.toContain("src/utils.ts");
	});

	it("matches symbols whose name contains the keyword", async () => {
		const result = await getRelevantContext(
			{ task: "user authentication", hints: { keywords: ["User"] } },
			makeManifest(),
			makeIndex(),
		);
		const symbols = result.items.filter((i) => i.kind === "symbol");
		const names = symbols.map((s) => (s as { name: string }).name);
		expect(names).toContain("authenticateUser");
		expect(names).toContain("getUser");
	});

	it("marks lexical matches as lexical coverage / certainty", async () => {
		const result = await getRelevantContext(
			{ task: "auth", hints: { keywords: ["auth"] } },
			makeManifest(),
			makeIndex(),
		);

		const files = result.items.filter((i) => i.kind === "file");
		for (const f of files) {
			if (f.kind !== "file") continue;
			expect(f.coverage).toBe("lexical");
			expect(f.reasons).toContain("keyword");
		}

		const symbols = result.items.filter((i) => i.kind === "symbol");
		for (const s of symbols) {
			if (s.kind !== "symbol") continue;
			expect(s.certainty).toBe("lexical");
			expect(s.reasons).toContain("keyword");
		}
	});
});

