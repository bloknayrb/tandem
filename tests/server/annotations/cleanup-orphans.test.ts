/**
 * Coverage for `cleanupOrphanedAnnotationFiles` — the GC helper invoked on
 * server startup to prune durable annotation envelopes older than
 * `SESSION_MAX_AGE` (30 days).
 *
 * Issue #334 made this function a blocking step on the boot path, so we lock
 * down the envelope-filter regex and mtime cutoff. The race-safety guarantee
 * itself is enforced structurally by the `await` in `src/server/index.ts`
 * and isn't observable in isolation.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupOrphanedAnnotationFiles } from "../../../src/server/session/manager.js";
import { SESSION_MAX_AGE } from "../../../src/shared/constants.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

let tmpRoot: string;
let annotationsDir: string;
let prevAppDataDir: string | undefined;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-cleanup-test-"));
  prevAppDataDir = process.env.TANDEM_APP_DATA_DIR;
  process.env.TANDEM_APP_DATA_DIR = tmpRoot;
  annotationsDir = path.join(tmpRoot, "annotations");
  await fs.mkdir(annotationsDir, { recursive: true });
});

afterEach(async () => {
  if (prevAppDataDir === undefined) delete process.env.TANDEM_APP_DATA_DIR;
  else process.env.TANDEM_APP_DATA_DIR = prevAppDataDir;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeWithMtime(file: string, ageMs: number): Promise<void> {
  const filePath = path.join(annotationsDir, file);
  await fs.writeFile(filePath, "{}", "utf-8");
  const mtime = new Date(Date.now() - ageMs);
  await fs.utimes(filePath, mtime, mtime);
}

describe("cleanupOrphanedAnnotationFiles", () => {
  it("removes doc-hash envelopes older than SESSION_MAX_AGE", async () => {
    await writeWithMtime(`${HASH_A}.json`, SESSION_MAX_AGE + 60_000);

    const cleaned = await cleanupOrphanedAnnotationFiles();

    expect(cleaned).toBe(1);
    await expect(fs.access(path.join(annotationsDir, `${HASH_A}.json`))).rejects.toThrow();
  });

  it("preserves fresh envelopes", async () => {
    await writeWithMtime(`${HASH_A}.json`, 60_000);

    const cleaned = await cleanupOrphanedAnnotationFiles();

    expect(cleaned).toBe(0);
    await expect(fs.access(path.join(annotationsDir, `${HASH_A}.json`))).resolves.toBeUndefined();
  });

  it("removes upload_ envelopes older than SESSION_MAX_AGE", async () => {
    await writeWithMtime("upload_abc123.json", SESSION_MAX_AGE + 60_000);

    const cleaned = await cleanupOrphanedAnnotationFiles();

    expect(cleaned).toBe(1);
  });

  it("skips quarantine, parked, lock, and non-envelope files", async () => {
    const old = SESSION_MAX_AGE + 60_000;
    await writeWithMtime(`${HASH_A}.json.corrupt.1700000000`, old);
    await writeWithMtime(`${HASH_B}.json.future`, old);
    await writeWithMtime("store.lock", old);
    await writeWithMtime("README.md", old);

    const cleaned = await cleanupOrphanedAnnotationFiles();

    expect(cleaned).toBe(0);
    await expect(
      fs.access(path.join(annotationsDir, `${HASH_A}.json.corrupt.1700000000`)),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(annotationsDir, `${HASH_B}.json.future`)),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(annotationsDir, "store.lock"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(annotationsDir, "README.md"))).resolves.toBeUndefined();
  });

  it("returns 0 when the annotations directory does not exist", async () => {
    await fs.rm(annotationsDir, { recursive: true, force: true });

    const cleaned = await cleanupOrphanedAnnotationFiles();

    expect(cleaned).toBe(0);
  });
});
