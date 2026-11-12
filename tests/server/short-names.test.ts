/**
 * `expandShortNames` (#2400): the one new filesystem behaviour.
 *
 * Every case injects `win32` and a fake filesystem, so it runs the same on
 * every host. The fake is a table of directory entries keyed by Windows-shaped
 * strings; nothing here touches a real path, the host's separator or the host's
 * `process.platform`.
 */

import fsSync from "node:fs";
import fsp from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _setShortNameDepsForTests,
  expandShortNames,
  looksLikeShortName,
} from "../../src/server/file-io/short-names.js";

const BS = String.fromCharCode(92);
const W = (...parts: string[]): string => parts.join(BS);

interface Entry {
  /** What the native realpath returns for this path. */
  native: string;
  ino: bigint;
  dev?: bigint;
}

/** A fake Windows volume: path (lower-cased) → entry. */
function fakeFs(entries: Record<string, Entry>) {
  // Windows treats both separators alike; so does the fake.
  const key = (p: string) => p.toLowerCase().replace(/\//g, BS);
  const table = new Map(Object.entries(entries).map(([k, v]) => [key(k), v]));
  const enoent = (p: string) =>
    Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" }) as NodeJS.ErrnoException;
  const realpathNative = vi.fn((p: string) => {
    const e = table.get(key(p));
    if (!e) throw enoent(p);
    return e.native;
  });
  const lstat = vi.fn((p: string) => {
    const e = table.get(key(p));
    if (!e) throw enoent(p);
    return { ino: e.ino, dev: e.dev ?? 1n };
  });
  _setShortNameDepsForTests({ platform: "win32", realpathNative, lstat });
  return { realpathNative, lstat };
}

afterEach(() => {
  _setShortNameDepsForTests(null);
  vi.restoreAllMocks();
});

describe("looksLikeShortName", () => {
  it.each([
    ["AFOLDE~1", true],
    ["afolde~1", true],
    ["LONGFI~1.MD", true],
    ["RUNNER~1", true],
    ["AB12CD~2", true],
    ["A~12", true],
    ["notes~1.md", true], // shape only: the filesystem decides whether it is real
    ["a folder with a long name", false],
    ["notes.md", false],
    ["TOOLONGNAME~1", false], // base over eight characters
    ["NOTES~1.MARKDOWN", false], // extension over three
    ["NOTES~1.MD.", false],
    ["NO TES~1", false],
    ["notes~draft.md", false],
    ["~1", true],
    ["", false],
  ])("%s → %s", (name, expected) => {
    expect(looksLikeShortName(name)).toBe(expected);
  });
});

describe("expandShortNames", () => {
  const LONG_DIR = W("C:", "a folder with a long name");
  const volume = {
    [W("C:", "AFOLDE~1")]: { native: LONG_DIR, ino: 10n },
    [LONG_DIR]: { native: LONG_DIR, ino: 10n },
    [W(LONG_DIR, "LONGFI~1.MD")]: { native: W(LONG_DIR, "long file.md"), ino: 11n },
    [W(LONG_DIR, "long file.md")]: { native: W(LONG_DIR, "long file.md"), ino: 11n },
    [W(LONG_DIR, "notes~1.md")]: { native: W(LONG_DIR, "notes~1.md"), ino: 12n },
    [W(LONG_DIR, "x.md")]: { native: W(LONG_DIR, "x.md"), ino: 13n },
  };

  it("expands a short folder, a short file name, and both", async () => {
    fakeFs(volume);
    expect(await expandShortNames(W("C:", "AFOLDE~1", "x.md"))).toEqual({
      path: W(LONG_DIR, "x.md"),
    });
    expect(await expandShortNames(W(LONG_DIR, "LONGFI~1.MD"))).toEqual({
      path: W(LONG_DIR, "long file.md"),
    });
    expect(await expandShortNames(W("C:", "AFOLDE~1", "LONGFI~1.MD"))).toEqual({
      path: W(LONG_DIR, "long file.md"),
    });
  });

  it("returns a path with no short component byte-identical, with no filesystem call", async () => {
    const { realpathNative, lstat } = fakeFs(volume);
    const p = W(LONG_DIR, "x.md");
    expect(await expandShortNames(p)).toEqual({ path: p });
    expect(realpathNative).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
  });

  it("keeps a real long name that merely has the alias shape, bytes and case included (R1.4)", async () => {
    fakeFs(volume);
    const typed = W(LONG_DIR, "NOTES~1.md");
    expect(await expandShortNames(typed)).toEqual({ path: typed });
  });

  it("copies separators and every other component through unchanged", async () => {
    fakeFs(volume);
    expect(await expandShortNames("C:/AFOLDE~1/x.md")).toEqual({
      path: "C:/a folder with a long name/x.md",
    });
  });

  it("never changes the drive prefix: a mapped drive stays on R:, a subst drive on Q: (R1.3)", async () => {
    // The native realpath of a mapped drive is a UNC string and of a subst
    // drive the physical path. Only the last component of either is used.
    fakeFs({
      [W("R:", "AFOLDE~1")]: { native: W(`${BS}${BS}server`, "share", "a long folder"), ino: 20n },
      [W("R:", "a long folder")]: { native: "unused", ino: 20n },
      [W("Q:", "AFOLDE~1")]: { native: W("C:", "physical", "a long folder"), ino: 21n },
      [W("Q:", "a long folder")]: { native: "unused", ino: 21n },
    });
    expect(await expandShortNames(W("R:", "AFOLDE~1", "x.md"))).toEqual({
      path: W("R:", "a long folder", "x.md"),
    });
    expect(await expandShortNames(W("Q:", "AFOLDE~1", "x.md"))).toEqual({
      path: W("Q:", "a long folder", "x.md"),
    });
  });

  it("is all-or-nothing: an EPERM on the second component returns the input, not a half-expanded string (R4.5)", async () => {
    const { realpathNative } = fakeFs(volume);
    const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" });
    realpathNative.mockImplementation((p: string) => {
      if (p.toUpperCase().endsWith("LONGFI~1.MD")) throw eperm;
      return LONG_DIR;
    });
    const typed = W("C:", "AFOLDE~1", "LONGFI~1.MD");
    expect(await expandShortNames(typed)).toEqual({ path: typed, failed: eperm });
  });

  it("refuses a candidate that is not the same directory entry", async () => {
    fakeFs({
      ...volume,
      [W("C:", "AFOLDE~1")]: { native: LONG_DIR, ino: 99n },
    });
    const typed = W("C:", "AFOLDE~1", "x.md");
    const out = await expandShortNames(typed);
    expect(out.path).toBe(typed);
    expect(out.failed).toBeInstanceOf(Error);
  });

  it("treats a zero inode as unverifiable", async () => {
    fakeFs({
      [W("C:", "AFOLDE~1")]: { native: LONG_DIR, ino: 0n },
      [LONG_DIR]: { native: LONG_DIR, ino: 0n },
    });
    const typed = W("C:", "AFOLDE~1", "x.md");
    const out = await expandShortNames(typed);
    expect(out.path).toBe(typed);
    expect(out.failed).toBeInstanceOf(Error);
  });

  it("treats a vanished long name as a failure, never as 'not there yet'", async () => {
    fakeFs({ [W("C:", "AFOLDE~1")]: { native: LONG_DIR, ino: 10n } });
    const typed = W("C:", "AFOLDE~1", "x.md");
    const out = await expandShortNames(typed, { allowMissingTail: true });
    expect(out.path).toBe(typed);
    expect((out.failed as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  it("without allowMissingTail, a missing alias-shaped component is a failure", async () => {
    fakeFs(volume);
    const typed = W("C:", "AFOLDE~1", "NEWFIL~1.MD");
    const out = await expandShortNames(typed);
    expect(out.path).toBe(typed);
    expect((out.failed as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  it("with allowMissingTail, expands what exists and keeps a missing leaf as typed (R1.6)", async () => {
    fakeFs(volume);
    expect(
      await expandShortNames(W("C:", "AFOLDE~1", "NEWFIL~1.MD"), { allowMissingTail: true }),
    ).toEqual({ path: W(LONG_DIR, "NEWFIL~1.MD") });
    expect(
      await expandShortNames(W("C:", "AFOLDE~1", "new file.md"), { allowMissingTail: true }),
    ).toEqual({ path: W(LONG_DIR, "new file.md") });
  });

  it("does nothing off win32", async () => {
    const realpathNative = vi.fn();
    const lstat = vi.fn();
    _setShortNameDepsForTests({ platform: "linux", realpathNative, lstat });
    const p = "/home/u/AFOLDE~1/x.md";
    expect(await expandShortNames(p)).toEqual({ path: p });
    expect(realpathNative).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
  });

  // R4.1. The guard is this function's FIRST statement, independent of any
  // caller's ordering. Asserted on spies, and on the real filesystem functions
  // as well as the injected ones: a later direct `fsp.*` call added outside the
  // seam would be invisible to the injected spies alone.
  it.each([
    ["a bare UNC path", `${BS}${BS}evil.example${BS}share${BS}AFOLDE~1${BS}x.md`],
    ["a forward-slash UNC path", "//evil.example/share/AFOLDE~1/x.md"],
    ["a mixed-separator UNC path", `/${BS}evil.example/share/AFOLDE~1/x.md`],
    ["an extended-length path", `${BS}${BS}?${BS}C:${BS}AFOLDE~1${BS}x.md`],
    [
      "an extended UNC path",
      `${BS}${BS}?${BS}UNC${BS}evil.example${BS}share${BS}AFOLDE~1${BS}x.md`,
    ],
    ["a device-namespace path", `${BS}${BS}.${BS}C:${BS}AFOLDE~1${BS}x.md`],
  ])("makes no filesystem call for %s", async (_label, hostile) => {
    const { realpathNative, lstat } = fakeFs({});
    const real = [
      // Before `realpathSync` itself: a spy on that replaces the function.
      vi.spyOn(fsSync.realpathSync, "native"),
      vi.spyOn(fsp, "realpath"),
      vi.spyOn(fsp, "lstat"),
      vi.spyOn(fsp, "stat"),
      vi.spyOn(fsSync, "realpathSync"),
      vi.spyOn(fsSync, "lstatSync"),
      vi.spyOn(fsSync, "statSync"),
    ];
    expect(await expandShortNames(hostile, { allowMissingTail: true })).toEqual({ path: hostile });
    expect(realpathNative).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
    for (const spy of real) expect(spy).not.toHaveBeenCalled();
  });
});
