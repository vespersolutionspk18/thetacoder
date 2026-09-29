#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isBuiltin } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";

const failures = [];

function listWorkspacePackages() {
	const packages = [];
	for (const group of ["packages", "packages/session-backends"]) {
		if (!existsSync(group)) continue;
		for (const entry of readdirSync(group, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const directory = join(group, entry.name);
			if (existsSync(join(directory, "package.json"))) {
				packages.push({ directory });
			}
		}
	}
	return packages;
}

function checkSource(source, manifest) {
	const file = source.fileName;
	const declared = new Set([
		manifest.name,
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.optionalDependencies ?? {}),
		...Object.keys(manifest.peerDependencies ?? {}),
	]);

	function checkSpecifier(node) {
		if (!node || !ts.isStringLiteralLike(node)) return;
		const specifier = node.text;
		if (specifier.startsWith(".") || specifier.startsWith("/") || isBuiltin(specifier)) return;
		const name = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
		if (declared.has(name)) return;
		const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
		failures.push(`${file}:${line + 1}: ${specifier} is not declared in ${manifest.name}'s runtime dependencies`);
	}

	function visit(node) {
		if (ts.isImportDeclaration(node)) {
			const clause = node.importClause;
			const bindings = clause?.namedBindings;
			if (
				!clause ||
				(!clause.isTypeOnly &&
					(clause.name || !bindings || !ts.isNamedImports(bindings) ||
						bindings.elements.length === 0 || bindings.elements.some((element) => !element.isTypeOnly)))
			) {
				checkSpecifier(node.moduleSpecifier);
			}
		} else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
			const clause = node.exportClause;
			if (!clause || !ts.isNamedExports(clause) || clause.elements.length === 0 || clause.elements.some((element) => !element.isTypeOnly)) {
				checkSpecifier(node.moduleSpecifier);
			}
		} else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === "require") ||
				(ts.isPropertyAccessExpression(node.expression) && node.expression.getText(source) === "require.resolve"))
		) {
			checkSpecifier(node.arguments[0]);
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
}

for (const { directory } of listWorkspacePackages()) {
	const sourceDirectory = resolve(directory, "src");
	if (!existsSync(sourceDirectory)) continue;
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	const configPath = join(directory, "tsconfig.build.json");
	const config = existsSync(configPath)
		? ts.readConfigFile(configPath, ts.sys.readFile)
		: { config: { include: ["src/**/*"] } };
	if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(directory));
	if (parsed.errors.length > 0) {
		throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
	}
	const roots = new Set(parsed.fileNames.map((file) => resolve(file)));
	const program = ts.createProgram(parsed.fileNames, parsed.options);
	for (const source of program.getSourceFiles()) {
		if (source.isDeclarationFile || source.fileName.endsWith(".json")) continue;
		const path = relative(sourceDirectory, resolve(source.fileName));
		if (path.startsWith("..") || isAbsolute(path)) continue;
		// TypeScript's exclude only filters roots: imports can pull excluded files
		// back into the build. Reject that too, including type-only imports.
		if (!roots.has(resolve(source.fileName))) {
			failures.push(`${source.fileName} is excluded from ${manifest.name}'s build but imported by it`);
		}
		checkSource(source, manifest);
	}
}

if (failures.length > 0) {
	console.error("Undeclared runtime imports in workspace packages:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
console.log("Workspace package runtime imports have declared dependencies.");

