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

import { statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicWrite, atomicWriteBuffer } from "../../../src/server/file-io/index.js";
import { ATOMIC_TEMP_RE } from "../../../src/server/file-io/reaper.js";

let dir: string;
let savedUmask: number;

/** Sync `statSync`, so a spec that mocks `fs.stat` cannot also fool the assertion. */
function modeOf(p: string): number {
  return statSync(p).mode & 0o777;
}

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
      // lstat would report the link's own 0777 and mint a 0755 document.
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

    it("creates the temp exclusively, and leaves no temp sibling behind", async () => {
      const target = path.join(dir, "doc.md");
      await fs.writeFile(target, "x");
      const spy = vi.spyOn(fs, "writeFile");

      await atomicWrite(target, "y");

      expect(spy.mock.calls[0]?.[2]).toMatchObject({ flag: "wx" });
      expect((await fs.readdir(dir)).filter((n) => ATOMIC_TEMP_RE.test(n))).toEqual([]);
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
