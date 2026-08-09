#!/usr/bin/env node
// Relative-link checker for the repo's Markdown.
//
// Exists because a docs reorganisation moves files, and a moved file with a
// dangling inbound link is worse than one left where it was. "Verify with a
// sweep" is a wish; this is the gate. Run it before and after any move.
//
// Checks two things per link:
//   1. the target path resolves to a file that exists
//   2. the `#anchor`, if present, matches a heading in that file
//
// Anchor slugs follow GitHub's rules: lowercase, strip anything that isn't a
// word character/space/hyphen, spaces to hyphens. Duplicate headings get the
// -1, -2 suffixes GitHub appends, so a link to the second "## Notes" resolves.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * Directories with no prose worth checking, or not ours to fix.
 *
 * `worktrees` is the load-bearing one. `.claude/worktrees/` is gitignored, and
 * the checked-out branches inside it are frozen at whatever `docs/` layout they
 * were cut from — so every doc move since then reads as a broken link there.
 * Scanning them reported **171 broken links, none of them real**, which is worse
 * than not running: a checker whose output is entirely noise trains you to skip
 * it, and then it cannot report the one link that does matter. The rule this
 * file already states about `#anchor` noise applies to its own file selection.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "worktrees",
  "dist",
  "target",
  "playwright-report",
  "test-results",
  "coverage",
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".claude") continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** GitHub's heading-to-anchor slug, including its duplicate-suffix rule. */
function headingSlugs(markdown) {
  const seen = new Map();
  const slugs = new Set();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!m) continue;
    const base = m[2]
      .replace(/`/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // link text only
      .trim()
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    slugs.add(n === 0 ? base : `${base}-${n}`);
  }
  return slugs;
}

/**
 * Strip fenced blocks AND inline code spans. Both routinely contain Markdown
 * examples (`![alt](url)`) that are illustrations, not links — treating them as
 * links produces noise that trains you to ignore the checker.
 */
function stripCode(markdown) {
  return markdown.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1\s*$/gm, "").replace(/`[^`\n]*`/g, "");
}

/**
 * Fixture files are excluded deliberately: several exist to carry hostile or
 * malformed URLs (`javascript:`, UNC paths, `file:///etc/passwd`) that the
 * product must reject. A checker that flags them is flagging the fixture for
 * doing its job.
 */
function isFixture(path) {
  return /[/\\](fixtures|__snapshots__)[/\\]/.test(path);
}

const files = walk(ROOT).filter((f) => !isFixture(f));
const anchorCache = new Map();
const problems = [];
let checked = 0;

for (const file of files) {
  const text = stripCode(readFileSync(file, "utf-8"));
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|tel:|#)/.test(target)) continue;

    const [rawPath, anchor] = target.split("#");
    if (!rawPath) continue;

    checked += 1;
    const resolved = normalize(join(dirname(file), decodeURIComponent(rawPath)));
    const where = relative(ROOT, file);

    let stat;
    try {
      stat = statSync(resolved);
    } catch {
      problems.push(`${where}: target does not exist -> ${target}`);
      continue;
    }
    if (!anchor || !stat.isFile() || !resolved.endsWith(".md")) continue;

    if (!anchorCache.has(resolved)) {
      anchorCache.set(resolved, headingSlugs(readFileSync(resolved, "utf-8")));
    }
    if (!anchorCache.get(resolved).has(anchor.toLowerCase())) {
      problems.push(`${where}: no such heading -> ${target}`);
    }
  }
}

console.log(`Checked ${checked} relative links across ${files.length} markdown files.`);
if (problems.length > 0) {
  console.error(`\n${problems.length} broken:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("All resolve.");
