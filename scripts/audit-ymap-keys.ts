// Audit script: any .set("LITERAL", ...) or .get("LITERAL") call where
// LITERAL matches a known Y.Map key value should use the corresponding
// Y_MAP_* constant from src/shared/constants.ts.
//
// Critical Rule #1 in CLAUDE.md: raw Y.Map key strings drift over time and
// break observers silently.
//
// Heuristic: extract Y_MAP_* string values from constants.ts, then regex-scan
// for .set("VALUE" / .get("VALUE") across src/{server,client,shared}. Reports
// every hit; humans triage false positives (plain Map<string,X> calls).

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..");
const CONSTANTS = join(ROOT, "src/shared/constants.ts");
const DIRS = ["src/server", "src/client", "src/shared"].map((d) => join(ROOT, d));
const Y_MAP_DECL_RE = /^export const (Y_MAP_[A-Z_]+)\s*=\s*"([^"]+)"/gm;

function loadKnownKeys(): Map<string, string> {
  const src = readFileSync(CONSTANTS, "utf-8");
  const map = new Map<string, string>();
  let m: RegExpExecArray | null;
  Y_MAP_DECL_RE.lastIndex = 0;
  while ((m = Y_MAP_DECL_RE.exec(src)) !== null) {
    map.set(m[2], m[1]);
  }
  return map;
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
  const lines = readFileSync(file, "utf-8").split("\n");
  const findings: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [value, constName] of knownKeys) {
      const setRe = new RegExp(`\\.set\\s*\\(\\s*["']${value}["']`);
      const getRe = new RegExp(`\\.get\\s*\\(\\s*["']${value}["']`);
      if (setRe.test(line) || getRe.test(line)) {
        findings.push(`${rel}:${i + 1}: raw "${value}" — use ${constName}`);
      }
    }
  }
  return findings;
}

export function main(): void {
  const knownKeys = loadKnownKeys();
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
