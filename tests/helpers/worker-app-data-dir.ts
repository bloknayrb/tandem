/**
 * The per-worker throwaway app-data directory, derived from the immutable
 * `TANDEM_TEST_APP_DATA_ROOT` (see `tests/setup/app-data-isolation.ts` for why
 * it is derived from the root and never from the current value).
 *
 * No `src/` imports, deliberately: the setup file imports this before any
 * source module may load.
 */

import path from "node:path";

export function workerAppDataDir(): string {
  const root = process.env.TANDEM_TEST_APP_DATA_ROOT;
  if (!root) {
    // Fail loudly rather than silently falling through to the real directory —
    // a missing override is invisible until it shows up as junk in someone's
    // editor.
    throw new Error(
      "TANDEM_TEST_APP_DATA_ROOT is not set. vitest.config.ts must define it in `test.env`; " +
        "without it the app-data directory cannot be isolated.",
    );
  }
  return path.join(root, `worker-${process.pid}`);
}
