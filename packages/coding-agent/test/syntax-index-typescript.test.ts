/**
 * F1 syntax index — TypeScript extractor coverage.
 *
 * Fixture exercises one of every supported declaration kind plus
 * import / export variants. Assertions check kind, name, line range,
 * and modifiers on each entry.
 */

import { describe, expect, it } from "vitest";
import type { FileManifestEntry } from "../src/core/repository/manifest.ts";
import { buildSyntaxIndex, extractTypeScriptSymbols } from "../src/core/repository/syntax-index.ts";

const FIXTURE = [
	"// top of file", // 1
	"import { foo } from './foo';", // 2
	"import bar from './bar';", // 3
	"import * as ns from './ns';", // 4
	"", // 5
	"export function regular() { return 1; }", // 6
	"export async function asyncFn() {}", // 7
	"export class Widget {", // 8
	"  greet(name: string): string { return 'hi ' + name; }", // 9
	"  static create(): Widget { return new Widget(); }", // 10
	"  private count: number = 0;", // 11
	"}", // 12
	"", // 13
	"export interface Shape { area: number }", // 14
	"export type ID = string;", // 15
	"export const answer = 42;", // 16
	"export enum Color { Red, Green, Blue }", // 17
	"export default 99;", // 18
	"", // 19
	"export { regular, asyncFn } from './util';", // 20
	"export * from './other';", // 21
].join("\n");

function makeManifest(path: string, language: string): FileManifestEntry[] {
	return [
		{
			path,
			absolutePath: `/abs/${path}`,
			byteLength: FIXTURE.length,
			language,
			generated: false,
			ignored: false,
		},
	];
}

describe("extractTypeScriptSymbols — declarations", () => {
	const symbols = extractTypeScriptSymbols(FIXTURE, "fixture.ts", "typescript");

	function byName(name: string) {
		return symbols.filter((s) => s.name === name);
	}

	it("extracts the named function with export modifier", () => {
		// `regular` is also re-exported on line 20, so filter to
		// the function declaration explicitly.
		const f = symbols.filter((s) => s.name === "regular" && s.kind === "function");
		expect(f.length).toBe(1);
		expect(f[0]?.kind).toBe("function");
		expect(f[0]?.startLine).toBe(6);
		expect(f[0]?.endLine).toBe(6);
		expect(f[0]?.modifiers).toContain("export");
	});

	it("extracts the async function with async + export modifiers", () => {
		const f = symbols.filter((s) => s.name === "asyncFn" && s.kind === "function");
		expect(f.length).toBe(1);
		expect(f[0]?.kind).toBe("function");
		expect(f[0]?.modifiers).toEqual(expect.arrayContaining(["export", "async"]));
	});

	it("extracts the class with endLine spanning its body", () => {
		const c = byName("Widget");
		expect(c.length).toBe(1);
		expect(c[0]?.kind).toBe("class");
		expect(c[0]?.startLine).toBe(8);
		expect(c[0]?.endLine).toBe(12);
		expect(c[0]?.modifiers).toEqual(expect.arrayContaining(["export"]));
	});

	it("extracts a method inside the class with containerName", () => {
		const m = symbols.filter((s) => s.kind === "method" && s.containerName === "Widget");
		expect(m.length).toBeGreaterThanOrEqual(1);
		const greet = m.find((s) => s.name === "greet");
		expect(greet).toBeDefined();
		expect(greet?.startLine).toBe(9);
	});

	it("extracts a static method with the static modifier", () => {
		const create = symbols.find((s) => s.kind === "method" && s.name === "create");
		expect(create).toBeDefined();
		expect(create?.containerName).toBe("Widget");
		expect(create?.modifiers).toContain("static");
	});

	it("extracts a class property", () => {
		const p = symbols.find((s) => s.kind === "property" && s.name === "count");
		expect(p).toBeDefined();
		expect(p?.containerName).toBe("Widget");
	});

	it("extracts the interface with export modifier", () => {
		const i = byName("Shape");
		expect(i.length).toBe(1);
		expect(i[0]?.kind).toBe("interface");
		expect(i[0]?.modifiers).toContain("export");
	});

	it("extracts the type alias with export modifier", () => {
		const t = byName("ID");
		expect(t.length).toBe(1);
		expect(t[0]?.kind).toBe("type");
		expect(t[0]?.modifiers).toContain("export");
	});

	it("extracts the const declaration with const modifier", () => {
		const v = byName("answer");
		expect(v.length).toBe(1);
		expect(v[0]?.kind).toBe("variable");
		expect(v[0]?.modifiers).toEqual(expect.arrayContaining(["export", "const"]));
	});

	it("extracts the enum with export modifier", () => {
		const e = byName("Color");
		expect(e.length).toBe(1);
		expect(e[0]?.kind).toBe("enum");
		expect(e[0]?.modifiers).toContain("export");
	});
});

describe("extractTypeScriptSymbols — imports / exports", () => {
	const symbols = extractTypeScriptSymbols(FIXTURE, "fixture.ts", "typescript");

	it("extracts a default import with default modifier", () => {
		const i = symbols.find((s) => s.kind === "import" && s.modifiers?.includes("default"));
		expect(i).toBeDefined();
		expect(i?.name).toBe("./bar");
		expect(i?.containerName).toBe("bar");
	});

	it("extracts a namespace import with namespace modifier", () => {
		const i = symbols.find((s) => s.kind === "import" && s.modifiers?.includes("namespace"));
		expect(i).toBeDefined();
		expect(i?.name).toBe("./ns");
		expect(i?.containerName).toBe("ns");
	});

	it("extracts a named import (path-based name)", () => {
		const i = symbols.find((s) => s.kind === "import" && s.name === "./foo");
		expect(i).toBeDefined();
	});

	it("extracts a `export default <expr>` as a default export", () => {
		const e = symbols.find((s) => s.kind === "export" && s.modifiers?.includes("default"));
		expect(e).toBeDefined();
		expect(e?.modifiers).toContain("default");
	});

	it('extracts a `export { a, b } from "..."` as named re-exports', () => {
		const e = symbols.filter((s) => s.kind === "export" && s.modifiers?.includes("named") && s.path === "fixture.ts");
		expect(e.length).toBe(2);
		const names = e.map((s) => s.name).sort();
		expect(names).toEqual(["asyncFn", "regular"]);
	});

	it('extracts a `export * from "..."` as a star re-export', () => {
		const e = symbols.find((s) => s.kind === "export" && s.modifiers?.includes("star"));
		expect(e).toBeDefined();
		expect(e?.name).toBe("./other");
	});
});

describe("buildSyntaxIndex — dispatcher (TypeScript path)", () => {
	it("reads the file and returns extracted symbols", async () => {
		// Point the dispatcher at a real file we just wrote to a tmp path.
		const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = await mkdtemp(join(tmpdir(), "syn-"));
		const file = join(dir, "fixture.ts");
		await writeFile(file, FIXTURE, "utf-8");
		try {
			const manifest: FileManifestEntry[] = [
				{
					path: "fixture.ts",
					absolutePath: file,
					byteLength: FIXTURE.length,
					language: "typescript",
					generated: false,
					ignored: false,
				},
			];
			const idx = await buildSyntaxIndex(manifest);
			expect(idx.length).toBeGreaterThan(5);
			expect(idx.find((s) => s.name === "Widget" && s.kind === "class")).toBeDefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("skips unsupported languages without throwing", async () => {
		const idx = await buildSyntaxIndex(makeManifest("foo.rs", "rust"));
		expect(idx).toEqual([]);
	});
});

