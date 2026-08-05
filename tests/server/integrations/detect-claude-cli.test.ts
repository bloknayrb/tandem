import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { detectClaudeCli, isBareNameLaunchable } from "../../../src/server/integrations/apply.js";

/**
 * `detectClaudeCli` is a pure filesystem probe — these tests exercise it
 * against real tmpdir fixtures (not `vi.spyOn`) so the live-binding `existsSync`
 * import is hit for real. `platformOverride` drives the `claude` vs `claude.exe`
 * branch independent of the host OS; PATH is joined with the host `delimiter`
 * (which the function also splits on), so the fixtures work on Windows + POSIX.
 */
describe("detectClaudeCli", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tandem-cli-detect-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Create `<root>/<sub>` and drop an (empty) executable file inside it. */
  function seedBin(sub: string, binName: string): string {
    const dir = join(root, sub);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, binName), "");
    return dir;
  }

  describe.each([
    { platform: "linux" as NodeJS.Platform, binName: "claude" },
    { platform: "win32" as NodeJS.Platform, binName: "claude.exe" },
  ])("on $platform", ({ platform, binName }) => {
    it("returns INSTALLED_ON_PATH when the binary is on PATH", () => {
      const binDir = seedBin("pathdir", binName);
      const home = join(root, "home"); // no ~/.local/bin — PATH is the only hit
      mkdirSync(home, { recursive: true });

      const presence = detectClaudeCli({
        platformOverride: platform,
        pathOverride: [join(root, "empty"), binDir].join(delimiter),
        homeOverride: home,
      });

      expect(presence).toBe("INSTALLED_ON_PATH");
    });

    it("returns INSTALLED_NOT_ON_PATH when only ~/.local/bin has it", () => {
      const home = join(root, "home");
      seedBinUnderHome(home, binName);

      const presence = detectClaudeCli({
        platformOverride: platform,
        pathOverride: join(root, "empty"), // nothing on PATH
        homeOverride: home,
      });

      expect(presence).toBe("INSTALLED_NOT_ON_PATH");
    });

    it("prefers PATH over ~/.local/bin when both are present", () => {
      const binDir = seedBin("pathdir", binName);
      const home = join(root, "home");
      seedBinUnderHome(home, binName);

      const presence = detectClaudeCli({
        platformOverride: platform,
        pathOverride: binDir,
        homeOverride: home,
      });

      expect(presence).toBe("INSTALLED_ON_PATH");
    });

    it("returns NOT_INSTALLED when neither PATH nor ~/.local/bin has it", () => {
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });

      const presence = detectClaudeCli({
        platformOverride: platform,
        pathOverride: join(root, "empty"),
        homeOverride: home,
      });

      expect(presence).toBe("NOT_INSTALLED");
    });
  });

  it("detects an npm-global cmd-shim on win32 (claude.cmd, no claude.exe)", () => {
    // `npm i -g @anthropic-ai/claude-code` on Windows writes `claude.cmd` /
    // `claude.ps1` shims — never a `claude.exe`. Probing only `claude.exe`
    // would report this usable install as NOT_INSTALLED. Regression guard.
    const binDir = seedBin("pathdir", "claude.cmd");
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });

    const presence = detectClaudeCli({
      platformOverride: "win32",
      pathOverride: binDir,
      homeOverride: home,
    });

    expect(presence).toBe("INSTALLED_ON_PATH");
  });

  it("ignores empty PATH segments without throwing", () => {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });

    const presence = detectClaudeCli({
      platformOverride: "linux",
      pathOverride: `${delimiter}${delimiter}`, // all-empty segments
      homeOverride: home,
    });

    expect(presence).toBe("NOT_INSTALLED");
  });
});

/**
 * `isBareNameLaunchable` answers the narrower question `detectClaudeCli` can't:
 * whether the launcher's bare-name `CreateProcessW` can actually start what was
 * found. Same real-tmpdir fixtures — the `.exe`-vs-shim distinction is entirely
 * about which files exist in which PATH directory.
 */
describe("isBareNameLaunchable", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tandem-cli-launchable-"));
    // The predicate falls back to the real env var, and a developer who has
    // set it would otherwise see every PATH-walk case below answer from their
    // machine instead of the fixture.
    vi.stubEnv("TANDEM_CLAUDE_CMD", "");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function seedBins(sub: string, ...binNames: string[]): string {
    const dir = join(root, sub);
    mkdirSync(dir, { recursive: true });
    for (const name of binNames) writeFileSync(join(dir, name), "");
    return dir;
  }

  it("is true when a shim directory precedes a real claude.exe on PATH", () => {
    // THE discriminating case. `CreateProcessW` skips directories with no
    // `.exe` and keeps searching, so this user's launcher works — an
    // implementation that answered from the first directory containing ANY
    // candidate (the shape `resolveCli` uses) would call them broken.
    const shimDir = seedBins("npmdir", "claude.cmd", "claude.ps1", "claude");
    const exeDir = seedBins("nativedir", "claude.exe");

    expect(
      isBareNameLaunchable({
        platformOverride: "win32",
        pathOverride: [shimDir, exeDir].join(delimiter),
      }),
    ).toBe(true);
  });

  it("is false when PATH holds only npm shims", () => {
    const shimDir = seedBins("npmdir", "claude.cmd", "claude.ps1", "claude");

    expect(
      isBareNameLaunchable({
        platformOverride: "win32",
        pathOverride: [join(root, "empty"), shimDir].join(delimiter),
      }),
    ).toBe(false);
  });

  it("is true when a directory holds both a shim and the .exe", () => {
    const mixed = seedBins("mixed", "claude.cmd", "claude.exe");

    expect(isBareNameLaunchable({ platformOverride: "win32", pathOverride: mixed })).toBe(true);
  });

  it("is true on POSIX, where the bare name IS the executable", () => {
    // A file literally named `claude` is the shim case on win32 and the normal
    // case everywhere else — the platform gate is what tells them apart.
    const binDir = seedBins("pathdir", "claude");

    expect(isBareNameLaunchable({ platformOverride: "darwin", pathOverride: binDir })).toBe(true);
    expect(isBareNameLaunchable({ platformOverride: "linux", pathOverride: binDir })).toBe(true);
    expect(isBareNameLaunchable({ platformOverride: "win32", pathOverride: binDir })).toBe(false);
  });

  it("is true when nothing is on PATH at all", () => {
    // NOT_INSTALLED / INSTALLED_NOT_ON_PATH — callers report those on their own
    // terms, and answering `false` here would stack a second, wrong warning on
    // top. `false` is reserved for the affirmative shim-only finding.
    expect(
      isBareNameLaunchable({ platformOverride: "win32", pathOverride: join(root, "empty") }),
    ).toBe(true);
  });

  it("ignores empty PATH segments without throwing", () => {
    expect(
      isBareNameLaunchable({
        platformOverride: "win32",
        pathOverride: `${delimiter}${delimiter}`,
      }),
    ).toBe(true);
  });

  describe("TANDEM_CLAUDE_CMD override", () => {
    // The launcher spawns this command instead of the bare name, so it settles
    // the question — including the exact escape hatch the doctor's fix text
    // recommends. Without this, following our own advice would leave the
    // warning up: the shim is still first on PATH.
    const shimOnlyPath = () => {
      const dir = join(root, "npmdir");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "claude.cmd"), "");
      return dir;
    };

    it("is true for an .exe override even when PATH holds only shims", () => {
      expect(
        isBareNameLaunchable({
          platformOverride: "win32",
          pathOverride: shimOnlyPath(),
          claudeCmdOverride: "C:\\Program Files\\Claude\\claude.exe",
        }),
      ).toBe(true);
    });

    it("is false for a shim override even when a real .exe is on PATH", () => {
      const exeDir = seedBins("nativedir", "claude.exe");
      expect(
        isBareNameLaunchable({
          platformOverride: "win32",
          pathOverride: exeDir,
          claudeCmdOverride: "C:\\npm\\claude.cmd",
        }),
      ).toBe(false);
    });

    it("falls through to the PATH walk for an extensionless override", () => {
      // Same bare-name rule as no override at all — so the answer must match
      // what PATH says, not the override's mere presence.
      const exeDir = seedBins("nativedir", "claude.exe");
      expect(
        isBareNameLaunchable({
          platformOverride: "win32",
          pathOverride: exeDir,
          claudeCmdOverride: "claude",
        }),
      ).toBe(true);
      expect(
        isBareNameLaunchable({
          platformOverride: "win32",
          pathOverride: shimOnlyPath(),
          claudeCmdOverride: "claude",
        }),
      ).toBe(false);
    });

    it("walks PATH for the OVERRIDE's name, not `claude`", () => {
      // The launcher spawns the override verbatim. Answering from `claude.cmd`
      // would be a confident finding about a program that is never started.
      const dir = seedBins("bindir", "claude.cmd", "claude-canary.exe");

      expect(
        isBareNameLaunchable({
          platformOverride: "win32",
          pathOverride: dir,
          claudeCmdOverride: "claude-canary",
        }),
      ).toBe(true);
      // And the mirror: a real claude.exe says nothing about `mycli`.
      expect(
        isBareNameLaunchable({
          platformOverride: "win32",
          pathOverride: seedBins("exeonly", "claude.exe", "mycli.cmd"),
          claudeCmdOverride: "mycli",
        }),
      ).toBe(false);
    });

    it("resolves an extensionless concrete path against `<path>.exe`", () => {
      // No PATH search happens for a path — CreateProcessW appends .exe to the
      // literal string. PATH is seeded shim-only to prove it isn't consulted.
      const dir = seedBins("tools", "mytool.exe");
      expect(
        isBareNameLaunchable({
          platformOverride: "win32",
          pathOverride: shimOnlyPath(),
          claudeCmdOverride: join(dir, "mytool"),
        }),
      ).toBe(true);
      expect(
        isBareNameLaunchable({
          platformOverride: "win32",
          pathOverride: shimOnlyPath(),
          claudeCmdOverride: join(dir, "absent"),
        }),
      ).toBe(false);
    });
  });

  it("ignores a DIRECTORY named `claude` on PATH", () => {
    // `existsSync` is true for a directory, and one probed candidate is the
    // extensionless `claude` — so a PATH entry holding a `claude/` checkout
    // would produce an affirmative, specific, wrong "your CLI is a shim" claim
    // for someone who has no CLI at all.
    const dir = join(root, "srcroot");
    mkdirSync(join(dir, "claude"), { recursive: true });

    expect(isBareNameLaunchable({ platformOverride: "win32", pathOverride: dir })).toBe(true);
    // Same defect one level down: presence must not count it either.
    expect(
      detectClaudeCli({
        platformOverride: "win32",
        pathOverride: dir,
        homeOverride: join(root, "nohome"),
      }),
    ).toBe("NOT_INSTALLED");
  });
});

/** `<home>/.local/bin/<binName>` — the native installer's documented target. */
function seedBinUnderHome(home: string, binName: string): void {
  const dir = join(home, ".local", "bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, binName), "");
}
