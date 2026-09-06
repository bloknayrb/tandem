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
import path from "node:path";

const root = process.env.TANDEM_TEST_APP_DATA_ROOT;
if (!root) {
  // Fail loudly rather than silently falling through to the real directory —
  // the whole point of this file is that a missing override is invisible until
  // it shows up as junk in someone's editor.
  throw new Error(
    "TANDEM_TEST_APP_DATA_ROOT is not set. vitest.config.ts must define it in `test.env`; " +
      "without it this setup file cannot isolate the app-data directory.",
  );
}

const dir = path.join(root, `worker-${process.pid}`);
fs.mkdirSync(dir, { recursive: true });
process.env.TANDEM_APP_DATA_DIR = dir;
