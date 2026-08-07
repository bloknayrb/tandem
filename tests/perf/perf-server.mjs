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
import { rmSync } from "node:fs";
import path from "node:path";

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
rmSync(resolved, { recursive: true, force: true });
console.error(`[perf-server] wiped app-data at ${resolved} before server start`);

const child = spawn(process.execPath, process.argv.slice(2), { stdio: "inherit" });
child.on("error", (err) => {
  console.error("[perf-server] failed to spawn server:", err);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
