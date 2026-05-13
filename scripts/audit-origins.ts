// Audit script: every doc.transact(...) call in src/server/** must pass
// MCP_ORIGIN or FILE_SYNC_ORIGIN as the second argument. Warn-only.
//
// Critical Rule #2 in CLAUDE.md: untagged transactions break channel-event
// filtering and durable-annotation file-sync.
//
// Heuristic: regex-find each .transact( opening and scan the same logical
// call (until the matching close paren or 8 lines, whichever comes first)
// for an origin keyword. Misses are reported with file:line.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..");
const SERVER_DIR = join(ROOT, "src/server");
const ORIGIN_NAMES = ["MCP_ORIGIN", "FILE_SYNC_ORIGIN"];
const TRANSACT_RE = /\.transact\s*\(/g;
const SCAN_LINES = 8;

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
  const lines = readFileSync(file, "utf-8").split("\n");
  const findings: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    TRANSACT_RE.lastIndex = 0;
    if (!TRANSACT_RE.test(lines[i])) continue;

    const window = lines.slice(i, Math.min(i + SCAN_LINES, lines.length)).join("\n");
    const hasOrigin = ORIGIN_NAMES.some((name) => window.includes(name));
    if (!hasOrigin) {
      findings.push(`${rel}:${i + 1}: .transact( without origin tag`);
    }
  }
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
  // Warn-only: never fail CI from this script. Step into a hook later if
  // findings stay at zero.
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
