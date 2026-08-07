// Playwright webServer launcher for the performance-gate backend.
//
// ## Why this exists at all
//
// The isolated app-data dir (TANDEM_APP_DATA_DIR) must be EMPTY when the
// server boots, and "when the server boots" is the only moment that works.
// `src/server/index.ts` restores the previous session — `restoreCtrlSession()`
// / `restoreOpenDocuments()` — during startup, so anything still on disk at
// that instant is rehydrated into the run: the previous run's open tabs and
// its durable annotation envelopes. A perf run that started with 50 seeded
// annotations plus N restored ones would measure a margin load nobody chose,
// and would drift upward every run.
//
// globalSetup cannot do it. Playwright's runner pushes
// `createPluginSetupTasks(config)` — which starts and health-checks every
// webServer — BEFORE `...config.globalSetups`
// (node_modules/playwright/lib/runner/tasks.js, `createGlobalSetupTasks`). A
// wipe in global-setup.ts therefore lands under an already-running server that
// has already restored.
//
// The config itself cannot do it either: Playwright re-imports
// playwright.config.ts in every worker process (and on --list / UI-mode
// refreshes), so a config-level rmSync would re-fire mid-run underneath the
// live server.
//
// ## Why this is not scripts/e2e-server.mjs
//
// That script is the same shape, but its recursive-delete guard is the E2E
// suite's safety boundary and the whole E2E suite depends on it. Widening it
// for a second caller makes a shared destructive guard permissive for a
// benefit local to this harness. This file owns its own guard, hard-coded to
// exactly one basename, and nothing outside tests/perf/ imports it.
//
// Usage: node tests/perf/perf-server.mjs <server-entry> [args...]
// The remaining argv is run under this same Node binary.
import { spawn } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Block the thread for `ms` without a dependency or an async hop. The wipe has
 * to finish before `spawn` below, so the retry loop cannot be a promise.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Recursive delete with a retry loop we own.
 *
 * `rmSync`'s own `maxRetries` / `retryDelay` were tried here first and are
 * INERT for this failure. Measured on Node v24.14.1 / Windows 11, against two
 * separately constructed holds — an un-traversable directory (`readdirSync`
 * throws EPERM) and a file held open exclusively by another process — both
 * `{recursive, force}` and `{recursive, force, maxRetries: 20, retryDelay:
 * 250}` returned the same EPERM in 0–1ms. Node's retry only covers some of the
 * syscalls a recursive delete makes, and not the ones that fail here. So a
 * comment claiming a bounded wait, sitting above options that produce none, is
 * worse than no retry at all: the operator is told the harness already waited.
 */
function wipeWithRetry(target, attempts, delayMs) {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      sleepSync(delayMs);
    }
  }
}

/**
 * Paths under `root` whose contents cannot be listed — the descendants that
 * make a recursive delete fail. Diagnostic only, so its own errors are the
 * answer rather than a problem: a directory that throws on `readdirSync` IS the
 * thing being looked for. Does NOT see a listable-but-undeletable file; the
 * caller reports an empty result rather than printing nothing.
 */
function findUnreadable(root) {
  const stuck = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      stuck.push(dir);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
    }
  };
  walk(root);
  return stuck;
}

/** The one directory this script is ever allowed to delete. Must match
 *  `PERF_APP_DATA_DIR` in tests/perf/playwright.config.ts. */
const PERF_APP_DATA_BASENAME = "tandem-perf-data";

// Refuse to recursively delete anything that isn't the perf-scoped dir.
// Resolve before checking so `..` segments or a coincidental substring
// elsewhere in the path can't smuggle the wipe outside its scope.
const dir = process.env.TANDEM_APP_DATA_DIR;
const resolved = dir ? path.resolve(dir) : null;
if (!resolved || path.basename(resolved) !== PERF_APP_DATA_BASENAME) {
  console.error(
    `[perf-server] refusing to wipe unexpected TANDEM_APP_DATA_DIR: ${dir ?? "(unset)"}\n` +
      `[perf-server] expected a directory named ${PERF_APP_DATA_BASENAME}`,
  );
  process.exit(1);
}
// ## Why the wipe is retried, and why it also reports the offending child
//
// Observed 2026-08-07, Windows 11: after a normal `perf:gate` run, the next
// four consecutive runs all died here and the gate became un-runnable for
// roughly ten minutes:
//
//   Error: EPERM, Permission denied: \\?\...\Temp\tandem-perf-data
//   Error: Process from config.webServer was not able to start. Exit code: 1
//
// Both of those messages name the app-data ROOT, and neither names the wipe as
// the failing step — so from the operator's seat the harness has simply stopped
// working. It had not. The actual blocker was ONE child:
// `doc-backups/<docHash>/`, left un-traversable and un-deletable by whatever
// still held it (an `icacls` on it listed no ACEs at all and `dir` reported its
// contents as not found — the shape of a Windows delete-pending entry). It
// cleared on its own later, and a plain `rmdir` then removed it instantly.
//
// So there are two separate failures to fix, and only the first is a wait:
//
//  1. RETRY covers the short window. `force: true` only suppresses ENOENT, so
//     it does nothing here, and neither does `rmSync`'s own `maxRetries` — see
//     `wipeWithRetry` above, which is why the loop is hand-rolled. 20 x 250ms
//     bounds the wait at ~5s, well inside the 120s webServer timeout, and costs
//     nothing on first-try success.
//
//  2. When the retries are NOT enough — and in the observed case they were
//     not, by two orders of magnitude — the operator must at least be told
//     which path is stuck, because that is the whole difference between "wait
//     and re-run" and "the perf gate is broken". Node reports the root it was
//     asked to delete, not the descendant that refused, so the walk below
//     recovers the offender WHEN it is un-listable, which is the observed
//     shape. It does not catch a plain held-open file (a locked `sessions/*.json`
//     lists fine and still refuses to unlink), so the walk finding nothing is
//     itself reported rather than left as silence. Deliberately still FATAL: booting the server
//     over a surviving `sessions/` dir would silently restore the previous
//     run's tabs and annotation envelopes and measure a load nobody chose,
//     which is the exact defect this file exists to prevent (run 1, see
//     docs/perf-gate-results.md). A wrong number is worse than no number.
try {
  wipeWithRetry(resolved, 20, 250);
} catch (err) {
  console.error(
    `[perf-server] could not wipe app-data at ${resolved}\n` +
      `[perf-server] ${err?.code ?? "error"}: ${err?.message ?? err}`,
  );
  const stuckPaths = findUnreadable(resolved);
  for (const stuck of stuckPaths) {
    console.error(`[perf-server]   still held: ${stuck}`);
  }
  console.error(
    stuckPaths.length > 0
      ? `[perf-server] On Windows this is usually a delete-pending directory left by the\n` +
          `[perf-server] previous run; it clears on its own. Wait, or remove the path above by hand.`
      : `[perf-server]   no un-listable descendant — the blocker lists fine but refuses to\n` +
          `[perf-server]   unlink, most likely a file still held open by a surviving process.\n` +
          `[perf-server] Look for a stray node/chromium from the previous run before re-running.`,
  );
  process.exit(1);
}
console.error(`[perf-server] wiped app-data at ${resolved} before server start`);

const child = spawn(process.execPath, process.argv.slice(2), { stdio: "inherit" });
child.on("error", (err) => {
  console.error("[perf-server] failed to spawn server:", err);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
