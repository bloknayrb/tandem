/**
 * The launcher's sync/async resolver pairs agree, on the sync side's behaviour
 * (#2400, Requirement 3), and no resolver touches the filesystem before the
 * UNC / device-prefix screen (R4.2).
 *
 * `fs.promises.realpath` is Node's native realpath; `fs.realpathSync` and the
 * callback `fs.realpath` are its JS one. On Windows the two flavours return
 * different strings for an 8.3 short name, a mapped drive and a `subst` drive,
 * so a sync resolver and an async one built on different flavours accept,
 * refuse and spell folders differently. Both halves now use the JS flavour.
 *
 * The explicit short-name and `subst` cases need a real Windows volume and are
 * gated to `win32`; everything else runs on every host.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  _resetHomeFailureLatchForTests,
  previewCwdDrift,
} from "../../../src/server/launcher/cwd-preview.js";
import {
  classifyRouteCwd,
  resolveRouteCwd,
  resolveRouteCwdAsync,
  resolveSafeCwd,
  resolveSafeCwdAsync,
  sessionCwdMatches,
} from "../../../src/server/launcher/supervisor.js";

const BS = String.fromCharCode(92);
const WIN = process.platform === "win32";

let root: string;
let home: string;
let project: string;
let outside: string;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resolver-flavour-")));
  home = path.join(root, "home");
  project = path.join(home, "a project with a long name");
  outside = path.join(root, "elsewhere");
  for (const d of [project, outside]) fs.mkdirSync(d, { recursive: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetHomeFailureLatchForTests();
});

/** Every filesystem function a launcher resolver can reach. */
function spyOnResolverFs() {
  return [
    vi.spyOn(fs, "realpathSync"),
    vi.spyOn(fs, "statSync"),
    vi.spyOn(fs, "lstatSync"),
    vi.spyOn(fs, "realpath"),
    vi.spyOn(fsp, "realpath"),
    vi.spyOn(fsp, "stat"),
    vi.spyOn(fsp, "lstat"),
  ];
}

/** The 8.3 alias of an existing path, or null when the volume makes none. */
function shortAliasOf(p: string): string | null {
  try {
    const out = execSync(`cmd /d /c for %I in ("${p}") do @echo %~sI`, { encoding: "utf-8" });
    const alias = out.trim().split(/\r?\n/).pop()?.trim() ?? "";
    return alias.includes("~") ? alias : null;
  } catch {
    return null;
  }
}

describe("no resolver touches the filesystem before the prefix screen (R4.2)", () => {
  // Forward-slash spellings are POSIX-absolute, so on a POSIX host they get
  // past `path.isAbsolute` and are stopped ONLY by the prefix rule: removing
  // that rule makes these cases fail on every host. The backslash spellings
  // are the Windows shapes (on POSIX they are refused as relative).
  const hostile = [
    "//evil.example/share/folder",
    "//?/C:/Windows",
    "//./C:/Windows",
    "//?/UNC/evil.example/share",
    `${BS}${BS}evil.example${BS}share${BS}folder`,
    `${BS}${BS}?${BS}C:${BS}Windows`,
    `${BS}${BS}.${BS}C:${BS}`,
    `/${BS}evil.example/share`,
  ];

  it.each(hostile)("%s", async (candidate) => {
    const spies = spyOnResolverFs();
    expect(resolveSafeCwd(candidate)).toBeNull();
    expect(await resolveSafeCwdAsync(candidate)).toBeNull();
    expect(classifyRouteCwd(candidate, { homeOverride: home })).toEqual({
      ok: false,
      reason: "unresolvable",
    });
    expect(await resolveRouteCwdAsync(candidate, { homeOverride: home })).toBeNull();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("the async resolvers use the JS realpath, never the native one (D4)", () => {
  it("resolveSafeCwdAsync", async () => {
    const native = vi.spyOn(fsp, "realpath");
    const js = vi.spyOn(fs, "realpath");
    expect(await resolveSafeCwdAsync(project)).toBe(project);
    expect(native).not.toHaveBeenCalled();
    expect(js).toHaveBeenCalledTimes(1);
  });

  it("resolveRouteCwdAsync, for the candidate and for home", async () => {
    const native = vi.spyOn(fsp, "realpath");
    const js = vi.spyOn(fs, "realpath");
    expect(await resolveRouteCwdAsync(project, { homeOverride: home })).toBe(project);
    expect(native).not.toHaveBeenCalled();
    expect(js).toHaveBeenCalledTimes(2);
  });
});

describe("each pair accepts, refuses and spells the same (R3.1)", () => {
  async function expectPairsAgree(candidate: string, homeOverride: string): Promise<void> {
    expect(await resolveSafeCwdAsync(candidate)).toBe(resolveSafeCwd(candidate));
    expect(await resolveRouteCwdAsync(candidate, { homeOverride })).toBe(
      resolveRouteCwd(candidate, { homeOverride }),
    );
  }

  it("on ordinary, missing, non-directory, outside-home and linked folders", async () => {
    const file = path.join(project, "README.md");
    fs.writeFileSync(file, "# hi\n");
    const link = path.join(home, "link to project");
    // A junction on Windows needs no privilege; elsewhere it is a symlink.
    fs.symlinkSync(project, link, "junction");
    for (const c of [project, home, outside, file, link, path.join(home, "nope"), "relative", ""]) {
      await expectPairsAgree(c, home);
    }
    // Links are resolved by both, to the same string.
    expect(resolveSafeCwd(link)).toBe(project);
    expect(await resolveSafeCwdAsync(link)).toBe(project);
  });

  it.runIf(WIN)(
    "on an explicit 8.3 short-name path, keeping the short spelling as the launch path does today",
    async (ctx) => {
      const alias = shortAliasOf(project);
      if (alias === null) return ctx.skip();
      const shortHome = shortAliasOf(home) ?? home;
      await expectPairsAgree(alias, home);
      await expectPairsAgree(alias, shortHome);
      await expectPairsAgree(project, shortHome);
      // Literal: the JS flavour returns the alias it was given.
      expect(resolveSafeCwd(alias)).toBe(alias);
      expect(await resolveSafeCwdAsync(alias)).toBe(alias);
    },
  );

  it.runIf(WIN)("on a subst drive, keeping its drive letter", async (ctx) => {
    const letter = ["Q", "P", "O", "N"].find((l) => !fs.existsSync(`${l}:${BS}`));
    if (!letter) return ctx.skip();
    try {
      execSync(`subst ${letter}: "${home}"`);
    } catch {
      return ctx.skip();
    }
    try {
      const onDrive = `${letter}:${BS}a project with a long name`;
      await expectPairsAgree(onDrive, home);
      await expectPairsAgree(onDrive, `${letter}:${BS}`);
      expect(resolveSafeCwd(onDrive)).toBe(onDrive);
      expect(await resolveSafeCwdAsync(onDrive)).toBe(onDrive);
    } finally {
      execSync(`subst ${letter}: /d`);
    }
  });
});

describe("home confinement and session resume answer as before (R3.3)", () => {
  it("a plain long folder under home is accepted, with its own string", () => {
    expect(classifyRouteCwd(project, { homeOverride: home })).toEqual({ ok: true, cwd: project });
    expect(classifyRouteCwd(home, { homeOverride: home })).toEqual({ ok: true, cwd: home });
  });

  it("a folder outside home is refused as outside-home", () => {
    expect(classifyRouteCwd(outside, { homeOverride: home })).toEqual({
      ok: false,
      reason: "outside-home",
    });
  });

  it("sessionCwdMatches compares strings exactly as before: case-folded on win32 only", () => {
    const longDir = `C:${BS}Users${BS}me${BS}a project`;
    const shortDir = `C:${BS}Users${BS}me${BS}APROJE~1`;
    const subst = `Q:${BS}a project`;
    // A cwd saved by an earlier version is whatever the JS realpath returned.
    expect(sessionCwdMatches(undefined, longDir, "win32")).toBe(true);
    expect(sessionCwdMatches(longDir, longDir, "win32")).toBe(true);
    expect(sessionCwdMatches(longDir.toUpperCase(), longDir, "win32")).toBe(true);
    expect(sessionCwdMatches(shortDir, shortDir, "win32")).toBe(true);
    expect(sessionCwdMatches(shortDir, longDir, "win32")).toBe(false);
    expect(sessionCwdMatches(subst, subst, "win32")).toBe(true);
    expect(sessionCwdMatches(subst, longDir, "win32")).toBe(false);
    expect(sessionCwdMatches("/home/me/A", "/home/me/a", "linux")).toBe(false);
  });

  it.runIf(WIN)(
    "a short-named folder is confined against a short-named home exactly as the sync resolver always did",
    (ctx) => {
      const alias = shortAliasOf(project);
      const shortHome = shortAliasOf(home);
      if (alias === null || shortHome === null) return ctx.skip();
      expect(classifyRouteCwd(alias, { homeOverride: shortHome })).toEqual({
        ok: true,
        cwd: alias,
      });
    },
  );
});

describe("previewCwdDrift says nothing for Tandem's own bundled folders, whichever spelling each side has (R3.2)", () => {
  const base = (over: Partial<Parameters<typeof previewCwdDrift>[0]>) => ({
    candidate: project,
    claudeCwd: outside,
    bundledDocDirs: [] as readonly string[],
    homeOverride: home,
    ...over,
  });

  // Host-neutral form of the defect: the bundled list holds one spelling of the
  // folder and the candidate resolves to another. A link stands in for the
  // short spelling, which only Windows can make.
  it("a bundled folder listed through a link matches the candidate's real path", async () => {
    const bundled = path.join(home, "Tandem", "sample");
    fs.mkdirSync(bundled, { recursive: true });
    const viaLink = path.join(home, "bundled link");
    fs.symlinkSync(bundled, viaLink, "junction");
    expect(await previewCwdDrift(base({ candidate: bundled, bundledDocDirs: [viaLink] }))).toEqual({
      drifted: false,
    });
    // The exclusion stays exact: another folder is still reported.
    expect((await previewCwdDrift(base({ bundledDocDirs: [viaLink] }))).drifted).toBe(true);
  });

  it.runIf(WIN)(
    "a long candidate against a short bundled folder, and a short candidate against a long one",
    async (ctx) => {
      const bundled = path.join(home, "a bundled sample folder");
      fs.mkdirSync(bundled, { recursive: true });
      const alias = shortAliasOf(bundled);
      if (alias === null) return ctx.skip();
      expect(await previewCwdDrift(base({ candidate: bundled, bundledDocDirs: [alias] }))).toEqual({
        drifted: false,
      });
      expect(await previewCwdDrift(base({ candidate: alias, bundledDocDirs: [bundled] }))).toEqual({
        drifted: false,
      });
    },
  );

  it.runIf(WIN)("a short spelling of Claude's own folder is not reported as drift", async (ctx) => {
    const alias = shortAliasOf(project);
    if (alias === null) return ctx.skip();
    expect(await previewCwdDrift(base({ candidate: project, claudeCwd: alias }))).toEqual({
      drifted: false,
    });
  });

  it("never resolves a UNC or device-prefix string natively: Claude's folder, home, or a bundled folder", async () => {
    const hostile = "//evil.example/share/x";
    const native = vi.spyOn(fsp, "realpath");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await previewCwdDrift(
      base({ claudeCwd: hostile, bundledDocDirs: ["//?/C:/bundled", hostile] }),
    );
    expect(out.drifted).toBe(true);
    for (const call of native.mock.calls) {
      expect(String(call[0]).startsWith("//")).toBe(false);
      expect(String(call[0]).startsWith(`${BS}${BS}`)).toBe(false);
    }
    // A UNC home fails the gate: no drift, and still no native call on it.
    native.mockClear();
    expect(await previewCwdDrift(base({ homeOverride: hostile }))).toEqual({ drifted: false });
    for (const call of native.mock.calls) expect(String(call[0])).not.toBe(hostile);
  });
});
