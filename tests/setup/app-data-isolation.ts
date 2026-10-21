/**
 * Give every vitest worker its own app-data directory, before any source
 * module is imported.
 *
 * **Why this file exists rather than a `beforeEach`.** `src/server/platform.ts`
 * computes `const APP_DATA_DIR = resolveAppDataDir()` at MODULE SCOPE, and
 * `SESSION_DIR` / `LAST_SEEN_VERSION_FILE` are derived from it there. A test
 * that sets `TANDEM_APP_DATA_DIR` in `beforeEach` — the existing
 * `tests/helpers/annotation-store-env.ts` pattern — is already too late for
 * those two: measured, `SESSION_DIR` resolved to the developer's real
 * `C:\Users\…\AppData\Local\tandem\Data\sessions` under exactly that pattern.
 * That is how ~40 test fixtures ended up in a real user's session store and got
 * reopened as tabs by the next restart. `setupFiles` runs before the importing
 * test file's static imports evaluate, which is early enough.
 *
 * **The derivation is from the ROOT, never from the current value.** Appending
 * to `process.env.TANDEM_APP_DATA_DIR` in place would be idempotent only
 * because `isolate: true` (the vitest default) hands every test file a fresh
 * process, so the config's `env` is reapplied each time. Under
 * `isolate: false` — an ordinary performance knob — one process runs many
 * files, the append compounds, and the path grows a segment per file until it
 * blows `MAX_PATH` with nothing pointing at the cause. Reading the immutable
 * root out of its own variable makes that impossible to reintroduce.
 *
 * **Scope of the isolation: per worker PROCESS, not per test file.** Under the
 * default `forks` pool with `isolate: true` each file does get its own process,
 * so today it is effectively per-file — but do not rely on that. Files sharing
 * a process run sequentially, so what remains is leftover state between files
 * in one worker, never a race between them.
 */

import fs from "node:fs";
import { afterAll } from "vitest";
import { workerAppDataDir } from "../helpers/worker-app-data-dir.js";

const dir = workerAppDataDir();
fs.mkdirSync(dir, { recursive: true });
process.env.TANDEM_APP_DATA_DIR = dir;

// Safety net for a test file that deletes or repoints `TANDEM_APP_DATA_DIR`
// and does not put it back: the annotation store re-reads the variable on every
// debounced write, so a write landing after the file's own teardown would
// otherwise resolve to the REAL app-data directory. Registered here, before the
// test file's own hooks, so it runs after them (vitest runs `afterAll` hooks in
// reverse registration order). `tests/helpers/app-data-teardown.ts` is the
// primary fix; this only narrows what a file that skips it can reach.
afterAll(() => {
  process.env.TANDEM_APP_DATA_DIR = dir;
});
