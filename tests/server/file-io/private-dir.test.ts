/**
 * `private-dir.ts` (#2266): owner-only app-data directories.
 *
 * POSIX half: `hardenPrivateDir` creates at 0700 and tightens an existing
 * directory by `fchmod` on an `O_NOFOLLOW` descriptor — never adding an owner
 * bit, never following a symlink, never throwing from the tighten step.
 *
 * Windows half: `applyPrivateDirAcl`'s per-directory memo, driven with
 * `setRestrictiveAcl` MOCKED and `process.platform` faked. Deliberately no real
 * `icacls` here: a real-icacls spec must join `scripts/ci/windows-acl-proof.mjs`
 * (pinned by `tests/scripts/windows-acl-proof-wiring.test.ts`), and the memo is
 * plumbing that a mock proves completely.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("../../../src/server/integrations/acl-win.js"), () => ({
  setRestrictiveAcl: vi.fn().mockResolvedValue(undefined),
}));

import {
  _resetPrivateDirAclForTests,
  applyPrivateDirAcl,
  ensurePrivateStoreDir,
  hardenPrivateDir,
} from "../../../src/server/file-io/private-dir.js";
import { setRestrictiveAcl } from "../../../src/server/integrations/acl-win.js";
import { modeOf } from "../../helpers/file-mode.js";

const setRestrictiveAclMock = vi.mocked(setRestrictiveAcl);

let base: string;
let savedUmask: number | undefined;

describe.skipIf(process.platform === "win32")("hardenPrivateDir (POSIX)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    savedUmask = process.umask(0o022);
    base = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-private-dir-"));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    if (savedUmask !== undefined) process.umask(savedUmask);
    warnSpy.mockRestore();
    // A 0500 fixture would make rm fail on its children.
    await fs.chmod(base, 0o700).catch(() => {});
    await fs.rm(base, { recursive: true, force: true });
  });

  it("creates a missing directory (and its parents) at 0700", async () => {
    const dir = path.join(base, "app-data", "sessions");
    await hardenPrivateDir(dir);
    expect(modeOf(dir)).toBe(0o700);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("tightens an existing 0755 directory to 0700", async () => {
    const dir = path.join(base, "sessions");
    await fs.mkdir(dir, { mode: 0o755 });
    await fs.chmod(dir, 0o755);

    await hardenPrivateDir(dir);

    expect(modeOf(dir)).toBe(0o700);
  });

  it("never adds an owner bit — a 0500 directory stays 0500", async () => {
    const dir = path.join(base, "readonly");
    await fs.mkdir(dir);
    await fs.chmod(dir, 0o500);

    await hardenPrivateDir(dir);

    expect(modeOf(dir)).toBe(0o500);
    await fs.chmod(dir, 0o700);
  });

  it("refuses a symlinked directory and leaves the target's mode untouched", async () => {
    const real = path.join(base, "real");
    await fs.mkdir(real);
    await fs.chmod(real, 0o755);
    const link = path.join(base, "link");
    await fs.symlink(real, link);

    await expect(hardenPrivateDir(link)).resolves.toBeUndefined();

    expect(modeOf(real)).toBe(0o755);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Could not restrict permissions"));
  });

  it("tightens a directory outside home and tmp (no root allowlist)", async () => {
    // A custom TANDEM_APP_DATA_DIR or XDG_DATA_HOME on another mount must still
    // be tightened. The guard is O_NOFOLLOW plus a narrow-only mask, not a
    // root check; this pins that no allowlist came back.
    const outside = await fs.mkdtemp(path.join(process.cwd(), ".tandem-private-dir-outside-"));
    try {
      await fs.chmod(outside, 0o755);
      await hardenPrivateDir(outside);
      expect(modeOf(outside)).toBe(0o700);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("a tighten failure is non-fatal and logged to stderr, not stdout", async () => {
    const file = path.join(base, "not-a-dir");
    await fs.writeFile(file, "x");
    const logSpy = vi.spyOn(console, "log");

    await expect(hardenPrivateDir(file, { create: false })).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Could not restrict permissions"));
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("create: false never creates a missing directory, and stays silent about it", async () => {
    const dir = path.join(base, "absent");
    await hardenPrivateDir(dir, { create: false });
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("a mkdir failure still propagates — the callers' failure contract is unchanged", async () => {
    const file = path.join(base, "blocker");
    await fs.writeFile(file, "x");
    await expect(hardenPrivateDir(path.join(file, "sessions"))).rejects.toThrow();
  });

  it("applies no ACL off Windows", async () => {
    setRestrictiveAclMock.mockClear();
    await ensurePrivateStoreDir(path.join(base, "annotations"));
    expect(await applyPrivateDirAcl(path.join(base, "annotations"))).toBe("unsupported");
    expect(setRestrictiveAclMock).not.toHaveBeenCalled();
  });
});

describe("applyPrivateDirAcl memo (Windows, setRestrictiveAcl mocked)", () => {
  let prevPlatform: PropertyDescriptor | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    prevPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    _resetPrivateDirAclForTests();
    setRestrictiveAclMock.mockReset();
    setRestrictiveAclMock.mockResolvedValue(undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (prevPlatform) Object.defineProperty(process, "platform", prevPlatform);
    errorSpy.mockRestore();
    _resetPrivateDirAclForTests();
  });

  it("applies an inheritable grant once per directory, and reports who applied it", async () => {
    const dir = path.join(os.tmpdir(), "tandem-acl-a");

    expect(await applyPrivateDirAcl(dir)).toBe("repaired");
    expect(await applyPrivateDirAcl(dir)).toBe("already-repaired");

    expect(setRestrictiveAclMock).toHaveBeenCalledTimes(1);
    expect(setRestrictiveAclMock).toHaveBeenCalledWith(dir, { inheritable: true });
  });

  it("is memoised PER directory, not once per run", async () => {
    const a = path.join(os.tmpdir(), "tandem-acl-a");
    const b = path.join(os.tmpdir(), "tandem-acl-b");

    expect(await applyPrivateDirAcl(a)).toBe("repaired");
    expect(await applyPrivateDirAcl(b)).toBe("repaired");

    expect(setRestrictiveAclMock).toHaveBeenCalledTimes(2);
  });

  it("concurrent callers share one application", async () => {
    const dir = path.join(os.tmpdir(), "tandem-acl-c");
    const outcomes = await Promise.all([applyPrivateDirAcl(dir), applyPrivateDirAcl(dir)]);
    expect(outcomes.sort()).toEqual(["already-repaired", "repaired"]);
    expect(setRestrictiveAclMock).toHaveBeenCalledTimes(1);
  });

  it("never rejects: a failure resolves repair-failed, logs the label, and latches", async () => {
    setRestrictiveAclMock.mockRejectedValue(new Error("icacls: access is denied"));
    const dir = path.join(os.tmpdir(), "tandem-acl-d");

    await expect(applyPrivateDirAcl(dir, { logLabel: "[Test] ACL on store" })).resolves.toBe(
      "repair-failed",
    );
    await expect(applyPrivateDirAcl(dir)).resolves.toBe("repair-failed");

    expect(setRestrictiveAclMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[Test] ACL on store failed (continuing):",
      expect.any(Error),
    );
  });

  it("the test reset forgets every directory", async () => {
    const dir = path.join(os.tmpdir(), "tandem-acl-e");
    await applyPrivateDirAcl(dir);
    _resetPrivateDirAclForTests();
    expect(await applyPrivateDirAcl(dir)).toBe("repaired");
    expect(setRestrictiveAclMock).toHaveBeenCalledTimes(2);
  });

  it("ensurePrivateStoreDir fires the ACL without awaiting it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-acl-store-"));
    try {
      let release: () => void = () => {};
      setRestrictiveAclMock.mockImplementation(
        () => new Promise<void>((resolve) => (release = resolve)),
      );

      // Resolves while the ACL application is still pending.
      await ensurePrivateStoreDir(dir);
      expect(setRestrictiveAclMock).toHaveBeenCalledWith(dir, { inheritable: true });

      release();
      expect(await applyPrivateDirAcl(dir)).toBe("already-repaired");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
