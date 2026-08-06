import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Runs once before the perf spec — but AFTER the webServers are up.
 *
 * That ordering is a Playwright fact, not a choice: `createGlobalSetupTasks`
 * (node_modules/playwright/lib/runner/tasks.js) pushes
 * `...createPluginSetupTasks(config)` — which starts and health-checks every
 * `webServer` entry — before `...config.globalSetups`. This file used to also
 * wipe the isolated app-data dir "before the webServers start"; it never did,
 * and the wipe landed underneath a live server that had ALREADY run
 * `restoreOpenDocuments()` and rehydrated the previous run's tabs and
 * annotation envelopes. The wipe now lives in `tests/perf/perf-server.mjs`,
 * which runs at server start — the only moment that precedes restore.
 *
 * What remains here is the one job that is order-insensitive: regenerate the
 * fixture, so the measured document always matches the checked-in generator
 * rather than whatever an earlier experiment left on disk.
 *
 * PRECONDITION for that being safe: the server booted with a wiped app-data
 * dir and therefore holds no document open on the fixture path. If a future
 * change makes the server open the fixture at boot, regenerating it here would
 * rewrite a watched file underneath a live reload.
 */
export default function globalSetup() {
  execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "fixtures", "make-perf-doc.mjs")],
    { stdio: "inherit" },
  );
}
