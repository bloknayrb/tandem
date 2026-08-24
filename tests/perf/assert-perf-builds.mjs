#!/usr/bin/env node
/**
 * Preflight for the perf gate: refuse to measure when there is nothing to
 * measure. A perf gate that silently measured the wrong artifact is worse than
 * one that refuses to run.
 *
 * WHY THIS IS NOT IN playwright.config.ts, where it used to live as a
 * top-level `for` loop that threw at module load:
 *
 * Knip's playwright plugin globs `playwright.config.{js,ts,mjs}` at ANY depth
 * and LOADS every match during plugin-config discovery, before its own
 * `ignore`/`project` filtering applies. So a config that throws on load takes
 * the whole dead-code audit down with it -- `npm run audit:dead-code` exited 2
 * on this file's throw and could not run at all without a prior perf build.
 * That is not fixable from `knip.json`: adding this file, or all of
 * `tests/perf/**`, to `ignore` was measured and changes nothing, because
 * discovery happens first.
 *
 * WHY IT IS NOT IN globalSetup, the obvious lazy home: Playwright starts every
 * webServer BEFORE it runs globalSetup (see global-setup.ts for the receipt).
 * On a missing build, `vite preview --outDir dist/perf-client` would boot
 * against a directory that does not exist and the operator would get a
 * 120-second webServer health-check timeout instead of the one-line message
 * below. That trades a good error for a bad one, silently, and only for the
 * person who hits it.
 *
 * So it runs as a preflight in the command of the FIRST webServer entry --
 * early enough to precede every server start, late enough that merely loading
 * the config is free. Paths arrive as argv from the config so the two files
 * cannot drift apart.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const [clientDist, serverDist] = process.argv.slice(2);

if (!clientDist || !serverDist) {
  console.error(
    "assert-perf-builds: expected two arguments (client index.html, server index.js).\n" +
      "This script is invoked from tests/perf/playwright.config.ts's first webServer command.",
  );
  process.exit(2);
}

for (const [label, p] of [
  ["client", clientDist],
  ["server", serverDist],
]) {
  if (!existsSync(p)) {
    console.error(
      `Performance gate: no production ${label} build at ${p}.\n` +
        "Run `npm run perf:gate`, which builds before measuring.",
    );
    process.exit(1);
  }
}

/** Newest mtime under a directory tree, skipping node_modules and dot-dirs. */
function newestMtimeMs(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtimeMs(full));
    else if (entry.isFile()) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

// Provenance, printed unconditionally: a recorded run should carry the
// timestamp of the artifact it measured, so the table in
// docs/perf-gate-results.md can be audited after the fact. `console.error`
// keeps it off stdout, where the Playwright reporter lives.
// The LABELS are derived from the same argv paths the timestamps come from,
// never hardcoded. The perf outDir has already moved once (#1492); a hardcoded
// "dist/perf-client" would keep printing after the next move and name a path
// the run did not measure -- in a line whose whole purpose is to be auditable
// against docs/perf-gate-results.md after the fact.
const clientBuiltAt = statSync(clientDist).mtimeMs;
const serverBuiltAt = statSync(serverDist).mtimeMs;
const label = (p) => path.relative(REPO_ROOT, path.dirname(p)).replace(/\\/g, "/");
console.error(
  `[perf-gate] ${label(clientDist)} built ${new Date(clientBuiltAt).toISOString()}, ` +
    `${label(serverDist)} built ${new Date(serverBuiltAt).toISOString()}`,
);

// STALENESS is a warning, not a failure. It is a real hazard -- `npm run
// perf:gate` builds first, but the config is also directly runnable with
// `playwright test --config=...`, which is exactly how someone iterating skips
// a two-minute rebuild. It is NOT reliable enough to block on: a formatter
// hook, or a fresh `git worktree`/checkout, restamps every file under `src/`
// without changing a byte of what would be built. So: say it loudly, measure
// anyway, and let the operator decide.
const srcNewest = newestMtimeMs(path.join(REPO_ROOT, "src"));
if (srcNewest > Math.min(clientBuiltAt, serverBuiltAt)) {
  console.error(
    `[perf-gate] WARNING: a file under src/ (mtime ${new Date(srcNewest).toISOString()}) is ` +
      "newer than the dist artifacts above -- this run may measure a stale build. " +
      "Run `npm run perf:gate` to rebuild first.",
  );
}
