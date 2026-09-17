/**
 * `atomicWrite` / `atomicWriteBuffer` must not leave a partial `.tandem-tmp-*`
 * sibling in the USER's document directory when the temp-file write itself
 * fails (#1850).
 *
 * The rename half already unlinks on terminal failure; the write half did not,
 * and the boot reaper deliberately never sweeps user document directories, so
 * nothing else would ever remove it.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicWrite, atomicWriteBuffer } from "../../../src/server/file-io/index.js";
import { ATOMIC_TEMP_RE } from "../../../src/server/file-io/reaper.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-atomic-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

function enospc(): Error {
  return Object.assign(new Error("no space"), { code: "ENOSPC" });
}

/** Temp siblings left in `dir`, matched by the reaper's OWN regex. */
async function leakedTemps(): Promise<string[]> {
  return (await fs.readdir(dir)).filter((n) => ATOMIC_TEMP_RE.test(n));
}

describe("atomicWrite temp-sibling cleanup (#1850)", () => {
  it("unlinks a PARTIAL temp file when the write fails, and rethrows the original error", async () => {
    const target = path.join(dir, "doc.md");
    const real = fs.writeFile;
    // Write some bytes first, so the cleanup has a real file to remove rather
    // than passing vacuously against a write that created nothing.
    vi.spyOn(fs, "writeFile").mockImplementation(async (p, _content, opts) => {
      await real.call(fs, p, "partial", opts as never);
      throw enospc();
    });

    await expect(atomicWrite(target, "full content")).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await leakedTemps()).toEqual([]);
  });

  it("does the same for atomicWriteBuffer — the .docx path", async () => {
    // The discriminating spec: a fix applied to `atomicWrite` alone leaves the
    // binary path leaking the largest files Tandem writes.
    const target = path.join(dir, "doc.docx");
    const real = fs.writeFile;
    vi.spyOn(fs, "writeFile").mockImplementation(async (p, _content) => {
      await real.call(fs, p, Buffer.from("partial") as never);
      throw enospc();
    });

    await expect(atomicWriteBuffer(target, Buffer.from("full"))).rejects.toMatchObject({
      code: "ENOSPC",
    });
    expect(await leakedTemps()).toEqual([]);
  });

  it("an unlink failure does not mask the write error", async () => {
    // Kills a `catch { await fs.unlink(tempPath); throw err; }` written without
    // the `.catch(() => {})`.
    const target = path.join(dir, "doc.md");
    vi.spyOn(fs, "writeFile").mockRejectedValue(enospc());
    vi.spyOn(fs, "unlink").mockRejectedValue(Object.assign(new Error("denied"), { code: "EPERM" }));

    await expect(atomicWrite(target, "content")).rejects.toMatchObject({ code: "ENOSPC" });
  });

  it("the happy path still lands the content and leaves no temp sibling", async () => {
    // Kills a cleanup accidentally moved outside the catch.
    const target = path.join(dir, "doc.md");
    await atomicWrite(target, "hello\n");
    expect(await fs.readFile(target, "utf-8")).toBe("hello\n");
    expect(await leakedTemps()).toEqual([]);
  });
});
