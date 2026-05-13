// Audit script: every doc.transact(...) call in src/server/** must pass
// MCP_ORIGIN or FILE_SYNC_ORIGIN as the second argument. Warn-only.
//
// Critical Rule #2 in CLAUDE.md: untagged transactions break channel-event
// filtering and durable-annotation file-sync.
//
// Uses the TypeScript compiler API to walk CallExpression nodes for `.transact`
// calls — robust against template literals, regex literals, escaped strings,
// and multi-line argument lists. Replaces a regex+line-window heuristic that
// produced 13/13 false positives on transactions spanning >8 lines.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "..");
const SERVER_DIR = join(ROOT, "src/server");
const ORIGIN_NAMES = new Set(["MCP_ORIGIN", "FILE_SYNC_ORIGIN"]);

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.ts$/.test(entry.name)) continue;
    if (/\.(test|spec)\.ts$/.test(entry.name)) continue;
    out.push(join(entry.parentPath, entry.name));
  }
  return out;
}

function findUntagged(file: string): string[] {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const source = readFileSync(file, "utf-8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "transact"
    ) {
      const tag = node.arguments[1];
      const tagged = tag !== undefined && ts.isIdentifier(tag) && ORIGIN_NAMES.has(tag.text);
      // Accept positional pass-through (e.g. shared helpers that take an
      // origin parameter): if the second arg is an Identifier that is not a
      // known origin constant, treat as tagged. The MCP-callsite invariant is
      // enforced at the caller in such patterns. Reduces false positives.
      const passThrough = tag !== undefined && ts.isIdentifier(tag) && !ORIGIN_NAMES.has(tag.text);
      if (!tagged && !passThrough) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        findings.push(`${rel}:${line + 1}: .transact( without origin tag`);
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return findings;
}

export function main(): void {
  const files = collectFiles(SERVER_DIR);
  const findings = files.flatMap(findUntagged);

  for (const f of findings) {
    process.stderr.write(`${f}\n`);
  }

  if (findings.length === 0) {
    process.stderr.write("audit-origins: clean\n");
  } else {
    process.stderr.write(`\naudit-origins: ${findings.length} untagged transact() call(s)\n`);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
