/**
 * Teardown for a test file that points `TANDEM_APP_DATA_DIR` at its own
 * directory (from a `vi.mock` factory of `src/server/platform`) and removes it
 * in `afterAll`.
 *
 * The order is the contract. The annotation store debounces its writes and
 * re-reads `TANDEM_APP_DATA_DIR` on every one, so a write still pending when
 * the last test returns fires after `afterAll`:
 *
 *   - with the variable deleted (the old teardown), it resolved to the REAL
 *     app-data directory — envelopes for temp test documents accumulated in
 *     `~/.local/share/tandem/annotations/`;
 *   - with the directory removed, it fails `ENOENT` and logs, and a log still
 *     in flight while vitest closes the worker is reported as an unhandled
 *     `EnvironmentTeardownError` — which fails the `coverage` job with every
 *     test green.
 *
 * So pending work is cancelled first, then the directory goes, then the
 * variable is restored to the worker's isolated directory — never deleted.
 */

import fs from "node:fs/promises";
import { resetForTesting as resetAnnotationStore } from "../../src/server/annotations/store.js";
import { stopAutoSave } from "../../src/server/session/manager.js";
import { workerAppDataDir } from "./worker-app-data-dir.js";

export async function teardownFileAppDataDir(): Promise<void> {
  resetAnnotationStore();
  stopAutoSave();
  const appDataDir = process.env.TANDEM_APP_DATA_DIR;
  if (appDataDir) await fs.rm(appDataDir, { recursive: true, force: true }).catch(() => {});
  process.env.TANDEM_APP_DATA_DIR = workerAppDataDir();
}
