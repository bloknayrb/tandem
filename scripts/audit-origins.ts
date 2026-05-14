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
//
// Pass-through handling (PR-F4a, post-#621 review): an Identifier second
// argument that isn't a known origin constant is accepted ONLY if the
// enclosing function's parameter list has a parameter named "origin" /
// "transactionOrigin" / "txnOrigin" or with a type-node text matching
// the origin-union shape (`TransactionOrigin`, `MCP_ORIGIN | FILE_SYNC_ORIGIN`,
// `"mcp" | "file-sync"`). Any other Identifier emits a `pass-through (verify)`
// finding so a human triages.
//
// Known limitation (no TypeChecker): identifier bindings across modules
// or through aliases are not resolved. A helper that re-exports an origin
// under a different name will fall into the `verify` bucket.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "..");
const SERVER_DIR = join(ROOT, "src/server");
const ORIGIN_NAMES = new Set(["MCP_ORIGIN", "FILE_SYNC_ORIGIN"]);
const PARAM_NAMES = new Set(["origin", "transactionOrigin", "txnOrigin"]);
const ORIGIN_TYPE_TEXTS = [
  "TransactionOrigin",
  '"mcp"|"file-sync"',
  '"file-sync"|"mcp"',
  "typeofMCP_ORIGIN|typeofFILE_SYNC_ORIGIN",
];

function normalizeTypeText(s: string): string {
  return s.replace(/\s+/g, "");
}

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

type EnclosingFn =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration
  | ts.ArrowFunction;

function isFunctionLike(n: ts.Node): n is EnclosingFn {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isArrowFunction(n)
  );
}

function isOriginParam(p: ts.ParameterDeclaration): boolean {
  if (ts.isIdentifier(p.name) && PARAM_NAMES.has(p.name.text)) return true;
  const typeText = p.type ? normalizeTypeText(p.type.getText()) : "";
  if (!typeText) return false;
  return ORIGIN_TYPE_TEXTS.some((t) => typeText.includes(normalizeTypeText(t)));
}

function identifierIsForwardedOriginParam(id: ts.Identifier): boolean {
  const fn = ts.findAncestor(id.parent, isFunctionLike);
  if (!fn) return false;
  return fn.parameters.some((p) => isOriginParam(p) && p.name.getText() === id.text);
}

type Finding =
  | { kind: "untagged"; file: string; line: number }
  | { kind: "verify"; file: string; line: number; name: string };

function findFindings(file: string): Finding[] {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const source = readFileSync(file, "utf-8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "transact"
    ) {
      const tag = node.arguments[1];
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());

      if (tag === undefined) {
        findings.push({ kind: "untagged", file: rel, line: line + 1 });
      } else if (ts.isIdentifier(tag)) {
        if (ORIGIN_NAMES.has(tag.text)) {
          // Tagged with a known origin constant — clean.
        } else if (identifierIsForwardedOriginParam(tag)) {
          // Forwarded through a parameter shaped like an origin — clean.
        } else {
          findings.push({ kind: "verify", file: rel, line: line + 1, name: tag.text });
        }
      } else {
        // Non-identifier second argument (e.g., string literal, object) —
        // not a recognized tagging pattern.
        findings.push({ kind: "untagged", file: rel, line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return findings;
}

export function main(): void {
  const files = collectFiles(SERVER_DIR);
  const findings = files.flatMap(findFindings);

  const untagged = findings.filter((f) => f.kind === "untagged");
  const verify = findings.filter((f) => f.kind === "verify");

  for (const f of untagged) {
    process.stderr.write(`${f.file}:${f.line}: .transact( without origin tag\n`);
  }
  for (const f of verify) {
    if (f.kind !== "verify") continue;
    process.stderr.write(`${f.file}:${f.line}: .transact( pass-through (verify): ${f.name}\n`);
  }

  if (findings.length === 0) {
    process.stderr.write("audit-origins: clean\n");
  } else {
    process.stderr.write(
      `\naudit-origins: ${untagged.length} untagged, ${verify.length} pass-through (verify)\n`,
    );
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
