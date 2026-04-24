/**
 * Coverage for `cleanupOrphanedAnnotationFiles` — the GC helper invoked on
 * server startup to prune durable annotation envelopes older than
 * `SESSION_MAX_AGE` (30 days).
 *
 * The race-safety guarantee is enforced at the call site (see #334) and is
 * covered by `tests/server/boot-order.test.ts`. This file locks down the
 * envelope-filter regex, mtime cutoff, and the `Promise.all` catch branches.
 */

import * as fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupOrphanedAnnotationFiles } from "../../../src/server/session/manager.js";
import { SESSION_MAX_AGE } from "../../../src/shared/constants.js";
import { HASH_A, HASH_B } from "../../helpers/annotation-fixtures.js";
import { useTmpAnnotationsEnv } from "../../helpers/annotation-store-env.js";

// Hoist the mock so Vitest can intercept the module before any import resolves.
// The factory spreads the real implementation so non-spy tests use real fs.
// The `default` key must also be present for modules using the default import form.
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof fs>();
  const mod = { ...actual };
  return { ...mod, default: mod };
});

const env = useTmpAnnotationsEnv("tandem-cleanup-test-");
let annotationsDir: string;

beforeEach(async () => {
  annotationsDir = path.join(env.tmpRoot, "annotations");
  await fs.mkdir(annotationsDir, { recursive: true });
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

    const { cleaned } = await cleanupOrphanedAnnotationFiles();

    expect(cleaned).toBe(1);
    await expect(fs.access(path.join(annotationsDir, `${HASH_A}.json`))).rejects.toThrow();
  });

  it("preserves fresh envelopes", async () => {
    await writeWithMtime(`${HASH_A}.json`, 60_000);

    const { cleaned } = await cleanupOrphanedAnnotationFiles();

    expect(cleaned).toBe(0);
    await expect(fs.access(path.join(annotationsDir, `${HASH_A}.json`))).resolves.toBeUndefined();
  });

  it("removes upload_ envelopes older than SESSION_MAX_AGE", async () => {
    await writeWithMtime("upload_abc123.json", SESSION_MAX_AGE + 60_000);

    const { cleaned } = await cleanupOrphanedAnnotationFiles();

    expect(cleaned).toBe(1);
  });

  it("skips quarantine, parked, lock, and non-envelope files", async () => {
    const old = SESSION_MAX_AGE + 60_000;
    await writeWithMtime(`${HASH_A}.json.corrupt.1700000000`, old);
    await writeWithMtime(`${HASH_B}.json.future`, old);
    await writeWithMtime("store.lock", old);
    await writeWithMtime("README.md", old);

    const { cleaned } = await cleanupOrphanedAnnotationFiles();

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

    const { cleaned } = await cleanupOrphanedAnnotationFiles();

    expect(cleaned).toBe(0);
  });

  it("swallows ENOENT when a file disappears between stat and unlink", async () => {
    const old = SESSION_MAX_AGE + 60_000;
    await writeWithMtime(`${HASH_A}.json`, old);
    await writeWithMtime(`${HASH_B}.json`, old);

    // The production code uses `import fs from "node:fs/promises"` (default
    // import). With vi.mock the default export is a separate object from the
    // namespace, so we spy on `(fs as any).default` — the same object the SUT
    // holds — while calling through to the real implementation for HASH_A.
    const fsMod = (fs as unknown as { default: typeof fs }).default;
    const realUnlink = fsMod.unlink.bind(fsMod);
    const spy = vi.spyOn(fsMod, "unlink").mockImplementation(async (p) => {
      if (typeof p === "string" && p.includes(HASH_B)) {
        const e = new Error("ENOENT") as NodeJS.ErrnoException;
        e.code = "ENOENT";
        throw e;
      }
      return realUnlink(p as string);
    });

    try {
      const { cleaned, raced, failed } = await cleanupOrphanedAnnotationFiles();
      expect(cleaned).toBe(1); // HASH_A actually deleted
      expect(raced).toBe(1); // HASH_B ENOENT → peer-cleaned
      expect(failed).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("logs non-ENOENT errors with the error code but does not throw", async () => {
    const old = SESSION_MAX_AGE + 60_000;
    await writeWithMtime(`${HASH_A}.json`, old);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Same default-export spy pattern as above.
    const fsMod = (fs as unknown as { default: typeof fs }).default;
    const spy = vi.spyOn(fsMod, "unlink").mockImplementation(async () => {
      const e = new Error("permission denied") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    });

    try {
      const { cleaned, failed } = await cleanupOrphanedAnnotationFiles();
      expect(cleaned).toBe(0);
      expect(failed).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("(EPERM)"), expect.any(Error));
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("rejects hash-shaped filenames with wrong length or wrong case", async () => {
    const old = SESSION_MAX_AGE + 60_000;
    await writeWithMtime(`${"a".repeat(63)}.json`, old);
    await writeWithMtime(`${"a".repeat(65)}.json`, old);
    await writeWithMtime(`${"A".repeat(64)}.json`, old);

    const { cleaned } = await cleanupOrphanedAnnotationFiles();

    expect(cleaned).toBe(0);
  });
});
