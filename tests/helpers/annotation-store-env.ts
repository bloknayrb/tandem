/**
 * Shared tmpdir + env setup for durable annotation store tests.
 *
 * Two helpers: one that saves/restores only TANDEM_APP_DATA_DIR (for tests
 * that do not touch TANDEM_ANNOTATION_STORE), and one that also saves/restores
 * the feature flag and deletes it in beforeEach so the store defaults to "on".
 *
 * Neither helper runs resetForTesting() — each test file is responsible for
 * its own module-level state resets, as the required reset functions vary per
 * file (store only, sync only, or both).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";

/**
 * Registers beforeEach/afterEach hooks that create a fresh tmpdir, point
 * TANDEM_APP_DATA_DIR at it, and clean up afterwards.
 *
 * For tests that do NOT need TANDEM_ANNOTATION_STORE save/restore
 * (cleanup-orphans.test.ts, perf.test.ts).
 *
 * Returns a ref whose `tmpRoot` property is updated in beforeEach so callers
 * can access the current temp directory.
 */
export function useTmpAnnotationsEnv(prefix = "tandem-test-"): { tmpRoot: string } {
  const ref = { tmpRoot: "" };
  let prevAppDataDir: string | undefined;

  beforeEach(async () => {
    ref.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    prevAppDataDir = process.env.TANDEM_APP_DATA_DIR;
    process.env.TANDEM_APP_DATA_DIR = ref.tmpRoot;
  });

  afterEach(async () => {
    if (prevAppDataDir === undefined) delete process.env.TANDEM_APP_DATA_DIR;
    else process.env.TANDEM_APP_DATA_DIR = prevAppDataDir;
    if (ref.tmpRoot) await fs.rm(ref.tmpRoot, { recursive: true, force: true });
    ref.tmpRoot = "";
  });

  return ref;
}

/**
 * Like `useTmpAnnotationsEnv` but also saves/restores TANDEM_ANNOTATION_STORE
 * and deletes it in beforeEach so the store defaults to "on".
 *
 * For tests that set TANDEM_ANNOTATION_STORE within individual test bodies
 * (store.test.ts, sync.test.ts).
 */
export function useTmpAnnotationsEnvWithFlag(prefix = "tandem-test-"): { tmpRoot: string } {
  const ref = { tmpRoot: "" };
  let prevAppDataDir: string | undefined;
  let prevFeatureFlag: string | undefined;

  beforeEach(async () => {
    ref.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    prevAppDataDir = process.env.TANDEM_APP_DATA_DIR;
    prevFeatureFlag = process.env.TANDEM_ANNOTATION_STORE;
    process.env.TANDEM_APP_DATA_DIR = ref.tmpRoot;
    delete process.env.TANDEM_ANNOTATION_STORE; // default = on
  });

  afterEach(async () => {
    if (prevAppDataDir === undefined) delete process.env.TANDEM_APP_DATA_DIR;
    else process.env.TANDEM_APP_DATA_DIR = prevAppDataDir;
    if (prevFeatureFlag === undefined) delete process.env.TANDEM_ANNOTATION_STORE;
    else process.env.TANDEM_ANNOTATION_STORE = prevFeatureFlag;
    if (ref.tmpRoot) await fs.rm(ref.tmpRoot, { recursive: true, force: true });
    ref.tmpRoot = "";
  });

  return ref;
}
