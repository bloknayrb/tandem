// Audit script: any call site that constructs or accesses a Y.Map / Y.Array /
// Y.Text / Y.XmlFragment using a string literal that matches a known Y_MAP_*
// constant value should use the corresponding constant from
// `src/shared/constants.ts`.
//
// Critical Rule #1 in CLAUDE.md: raw Y.Map key strings drift over time and
// break observers silently.
//
// Method coverage (PR-F4b, post-#621 review):
//   - `doc.getMap(...)`, `doc.getArray(...)`, `doc.getText(...)`,
//     `doc.getXmlFragment(...)` — origination sites (highest-value coverage).
//   - `map.set(...)`, `map.get(...)`, `map.has(...)`, `map.delete(...)` — access.
//
// Uses the TypeScript compiler API to walk CallExpression nodes — robust
// against multi-line argument lists, escaped quotes, and template literals.
// Replaces a line-by-line regex scan that missed multiline `.set` / `.get`
// calls and entirely missed `.has` / `.delete` / `.getMap` family.
//
// `ElementAccessExpression` (`map["key"]`) is NOT scanned: bracket access on
// a Y.Map is a TypeScript error in this codebase. Reconsider only if a real
// raw-bracket-key site appears.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "..");
const CONSTANTS = join(ROOT, "src/shared/constants.ts");
const DIRS = ["src/server", "src/client", "src/shared"].map((d) => join(ROOT, d));

const ACCESSOR_METHODS = new Set(["set", "get", "has", "delete"]);
const CONSTRUCTOR_METHODS = new Set(["getMap", "getArray", "getText", "getXmlFragment"]);

function loadKnownKeys(): Map<string, string> {
  const src = readFileSync(CONSTANTS, "utf-8");
  const sourceFile = ts.createSourceFile(CONSTANTS, src, ts.ScriptTarget.Latest, true);
  const out = new Map<string, string>();

  function visit(node: ts.Node): void {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          /^Y_MAP_[A-Z_]+$/.test(decl.name.text) &&
          decl.initializer &&
          ts.isStringLiteral(decl.initializer)
        ) {
          out.set(decl.initializer.text, decl.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return out;
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|svelte)$/.test(entry.name)) continue;
    if (/\.(test|spec)\.ts$/.test(entry.name)) continue;
    if (entry.parentPath.includes("node_modules")) continue;
    out.push(join(entry.parentPath, entry.name));
  }
  return out;
}

function findRawKeys(file: string, knownKeys: Map<string, string>): string[] {
  if (file === CONSTANTS) return [];
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const source = readFileSync(file, "utf-8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings: string[] = [];

  function checkLiteralArg(call: ts.CallExpression, methodName: string): void {
    const first = call.arguments[0];
    if (!first || !ts.isStringLiteral(first)) return;
    const constName = knownKeys.get(first.text);
    if (!constName) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(call.getStart());
    findings.push(
      `${rel}:${line + 1}: raw "${first.text}" in .${methodName}(...) — use ${constName}`,
    );
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (CONSTRUCTOR_METHODS.has(method) || ACCESSOR_METHODS.has(method)) {
        checkLiteralArg(node, method);
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return findings;
}

export function main(): void {
  const knownKeys = loadKnownKeys();
  if (knownKeys.size === 0) {
    process.stderr.write(
      "audit-ymap-keys: no Y_MAP_* constants found in src/shared/constants.ts — aborting\n",
    );
    process.exit(0);
  }
  const files = DIRS.flatMap(collectFiles);
  const findings = files.flatMap((f) => findRawKeys(f, knownKeys));

  for (const f of findings) {
    process.stderr.write(`${f}\n`);
  }

  if (findings.length === 0) {
    process.stderr.write("audit-ymap-keys: clean\n");
  } else {
    process.stderr.write(`\naudit-ymap-keys: ${findings.length} candidate raw Y.Map key(s)\n`);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
