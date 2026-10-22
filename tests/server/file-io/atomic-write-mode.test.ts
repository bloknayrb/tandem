/**
 * `atomicWrite` / `atomicWriteBuffer` must not widen the mode of the file they
 * replace (#2266). Before the fix the temp sibling was created at the umask
 * default and renamed over the target, so a `chmod 600` document came back
 * from its first save at 0644.
 *
 * Every spec forces a known umask and restores it: an ambient umask of 077
 * would make "0600 stays 0600" pass against the unfixed code. `process.umask`
 * is settable only because vitest runs these in forks (the default pool); in a
 * worker thread it throws ERR_WORKER_UNSUPPORTED_OPERATION.
 *
 * POSIX only — on Windows mode bits do not carry access control and the
 * helper deliberately keeps today's behaviour there.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  atomicWrite,
  atomicWriteBuffer,
  derivedFileModeCeiling,
} from "../../../src/server/file-io/index.js";
import { ATOMIC_TEMP_RE } from "../../../src/server/file-io/reaper.js";
import { modeOf } from "../../helpers/file-mode.js";

let dir: string;
let savedUmask: number;

describe.skipIf(process.platform === "win32")(
  "atomicWrite preserves the replaced file's mode (#2266)",
  () => {
    beforeEach(async () => {
      savedUmask = process.umask(0o022);
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-atomic-mode-"));
    });

    afterEach(async () => {
      process.umask(savedUmask);
      vi.restoreAllMocks();
      await fs.rm(dir, { recursive: true, force: true });
    });

    it("a 0600 document stays 0600 after a save", async () => {
      const target = path.join(dir, "private.md");
      await fs.writeFile(target, "secret");
      await fs.chmod(target, 0o600);

      await atomicWrite(target, "still secret");

      expect(await fs.readFile(target, "utf-8")).toBe("still secret");
      expect(modeOf(target)).toBe(0o600);
    });

    it("does the same on the binary (.docx) path", async () => {
      const target = path.join(dir, "private.docx");
      await fs.writeFile(target, Buffer.from("old"));
      await fs.chmod(target, 0o600);

      await atomicWriteBuffer(target, Buffer.from("new"));

      expect(modeOf(target)).toBe(0o600);
    });

    it("a new file keeps the process default", async () => {
      const target = path.join(dir, "fresh.md");
      await atomicWrite(target, "hello");
      expect(modeOf(target)).toBe(0o644);
    });

    it("a 0444 document stays read-only, and a second save still succeeds", async () => {
      // Deliberate behaviour change: the first save used to leave it 0644.
      // The rename needs a writable directory, not a writable file.
      const target = path.join(dir, "locked.md");
      await fs.writeFile(target, "v1");
      await fs.chmod(target, 0o444);

      await atomicWrite(target, "v2");
      await atomicWrite(target, "v3");

      expect(await fs.readFile(target, "utf-8")).toBe("v3");
      expect(modeOf(target)).toBe(0o444);
    });

    it("bits the umask strips are NOT restored — never wider than before the fix", async () => {
      // Why no chmod restores them: see `writeTempThenRename`'s docblock.
      process.umask(0o077);
      const target = path.join(dir, "shared.md");
      await fs.writeFile(target, "x");
      await fs.chmod(target, 0o664);

      await atomicWrite(target, "y");

      expect(modeOf(target)).toBe(0o600);
    });

    it("follows a symlinked target to the real file's mode (stat, not lstat)", async () => {
      // lstat would see the link rather than the file, and fall back to 0644.
      const real = path.join(dir, "real.md");
      await fs.writeFile(real, "x");
      await fs.chmod(real, 0o600);
      const link = path.join(dir, "link.md");
      await fs.symlink(real, link);

      await atomicWrite(link, "y");

      expect(modeOf(link)).toBe(0o600);
    });

    it("a partial stat answer falls back to the default, not 0000", async () => {
      // Shape of the `{ mtimeMs: 0 }` stat double in document-service.test.ts.
      const target = path.join(dir, "mocked.md");
      await fs.writeFile(target, "x");
      await fs.chmod(target, 0o600);
      vi.spyOn(fs, "stat").mockResolvedValueOnce({ mtimeMs: 0 } as never);

      await atomicWrite(target, "y");

      expect(modeOf(target)).toBe(0o644);
    });

    it("creates the temp exclusively at the final mode, with no chmod by path", async () => {
      // The mode must be applied at create. A path-based chmod of the temp
      // afterwards follows a symlink swapped in after the create (#2266 plan
      // review), so it must never come back — even one that yields the same mode.
      const target = path.join(dir, "doc.md");
      await fs.writeFile(target, "x");
      await fs.chmod(target, 0o600);
      const write = vi.spyOn(fs, "writeFile");
      const chmod = vi.spyOn(fs, "chmod");
      const lchmod = vi.spyOn(fs, "lchmod");

      await atomicWrite(target, "y");

      expect(write.mock.calls[0]?.[2]).toMatchObject({ flag: "wx", mode: 0o600, flush: true });
      expect(chmod).not.toHaveBeenCalled();
      expect(lchmod).not.toHaveBeenCalled();
      expect((await fs.readdir(dir)).filter((n) => ATOMIC_TEMP_RE.test(n))).toEqual([]);
    });

    it("drops execute bits — a 0755 document comes back 0644, as before the fix", async () => {
      const target = path.join(dir, "exec.md");
      await fs.writeFile(target, "x");
      await fs.chmod(target, 0o755);

      await atomicWrite(target, "y");

      expect(modeOf(target)).toBe(0o644);
    });

    it("an EEXIST on the temp is rethrown without unlinking an entry that is not ours", async () => {
      const target = path.join(dir, "doc.md");
      vi.spyOn(fs, "writeFile").mockRejectedValueOnce(
        Object.assign(new Error("exists"), { code: "EEXIST" }),
      );
      const unlink = vi.spyOn(fs, "unlink");

      await expect(atomicWrite(target, "y")).rejects.toMatchObject({ code: "EEXIST" });
      expect(unlink).not.toHaveBeenCalled();
    });
  },
);

/**
 * #2266 — the optional `maxMode` ceiling: app-data store files at `0600`, and
 * files derived from a document (sidecar, convert output) capped at the
 * source's group/other bits. The ceiling is ANDed into the create mode, so it
 * narrows and never widens, and it adds no chmod.
 */
describe.skipIf(process.platform === "win32")("atomicWrite maxMode ceiling (#2266)", () => {
  beforeEach(async () => {
    savedUmask = process.umask(0o022);
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-atomic-ceiling-"));
  });

  afterEach(async () => {
    process.umask(savedUmask);
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("a new file written with maxMode 0o600 is created at 0600", async () => {
    const target = path.join(dir, "fresh.json");
    await atomicWrite(target, "{}", { maxMode: 0o600 });
    expect(modeOf(target)).toBe(0o600);
  });

  it("an existing 0644 file rewritten with maxMode 0o600 comes back 0600", async () => {
    const target = path.join(dir, "old.json");
    await fs.writeFile(target, "{}");
    await fs.chmod(target, 0o644);

    await atomicWrite(target, "{}", { maxMode: 0o600 });

    expect(modeOf(target)).toBe(0o600);
  });

  it("an existing 0600 file with a 0o644 ceiling stays 0600 — a ceiling never widens", async () => {
    const target = path.join(dir, "private.md");
    await fs.writeFile(target, "x");
    await fs.chmod(target, 0o600);

    await atomicWriteBuffer(target, Buffer.from("y"), { maxMode: 0o644 });

    expect(modeOf(target)).toBe(0o600);
  });

  it("no ceiling is today's behaviour: a new file at the default, an existing 0644 kept", async () => {
    const fresh = path.join(dir, "fresh.md");
    await atomicWrite(fresh, "x", {});
    expect(modeOf(fresh)).toBe(0o644);

    const existing = path.join(dir, "existing.md");
    await fs.writeFile(existing, "x");
    await fs.chmod(existing, 0o644);
    await atomicWrite(existing, "y", { maxMode: undefined });
    expect(modeOf(existing)).toBe(0o644);
  });

  it("applies the ceiling at create, with no chmod by path", async () => {
    const target = path.join(dir, "store.json");
    const write = vi.spyOn(fs, "writeFile");
    const chmod = vi.spyOn(fs, "chmod");

    await atomicWrite(target, "{}", { maxMode: 0o600 });

    expect(write.mock.calls[0]?.[2]).toMatchObject({ flag: "wx", mode: 0o600 });
    expect(chmod).not.toHaveBeenCalled();
  });

  it.each([
    { src: 0o444, ceiling: 0o644, why: "world-readable source, owner keeps write" },
    { src: 0o400, ceiling: 0o600, why: "owner-only read-only source" },
    { src: 0o640, ceiling: 0o640, why: "group-readable source" },
    { src: 0o600, ceiling: 0o600, why: "private source" },
    { src: 0o666, ceiling: 0o666, why: "the ceiling is never narrower than the source grants" },
  ])("derivedFileModeCeiling: a $src source gives $ceiling ($why)", async ({ src, ceiling }) => {
    const source = path.join(dir, "source.md");
    await fs.writeFile(source, "x");
    await fs.chmod(source, src);

    expect(await derivedFileModeCeiling(source)).toBe(ceiling);
  });

  it("derivedFileModeCeiling gives no ceiling for an upload:// or unstat-able source", async () => {
    expect(await derivedFileModeCeiling("upload://scratchpad/abc.md")).toBeUndefined();
    expect(await derivedFileModeCeiling(path.join(dir, "missing.md"))).toBeUndefined();
    expect(await derivedFileModeCeiling(dir)).toBeUndefined();
  });
});
