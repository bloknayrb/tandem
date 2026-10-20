import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isBareNameLaunchable,
  resolveClaudeLaunch,
} from "../../../src/shared/integrations/detect-claude-cli.js";

/**
 * `resolveClaudeLaunch` (#2199) is what the auto-launcher spawns: always an
 * absolute path or nothing. Real tmpdir fixtures, as in
 * `detect-claude-cli.test.ts`; `platformOverride` picks the naming rules, the
 * host's own path module does the filesystem work.
 */
describe("resolveClaudeLaunch", () => {
  let root: string;
  let home: string;
  let empty: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tandem-claude-launch-"));
    home = join(root, "home");
    empty = join(root, "empty");
    mkdirSync(home, { recursive: true });
    mkdirSync(empty, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seed(dir: string, name: string, mode = 0o755): string {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, "", { mode });
    return file;
  }

  const nativeDir = () => join(home, ".local", "bin");

  describe("POSIX", () => {
    const base = { platformOverride: "linux" as NodeJS.Platform, claudeCmdOverride: "" };

    it("answers the absolute PATH hit, never the bare name", () => {
      const file = seed(join(root, "bin"), "claude");
      expect(
        resolveClaudeLaunch({
          ...base,
          pathOverride: [empty, join(root, "bin")].join(delimiter),
          homeOverride: home,
        }),
      ).toEqual({ command: file, knownUnstartable: false });
    });

    it("finds a fresh native install the PATH does not carry", () => {
      const file = seed(nativeDir(), "claude");
      expect(
        resolveClaudeLaunch({ ...base, pathOverride: empty, homeOverride: home }).command,
      ).toBe(file);
    });

    it("keeps the native link path rather than its target (auto-updates move the target)", () => {
      const target = seed(join(root, "versions", "2.1.0"), "claude");
      mkdirSync(nativeDir(), { recursive: true });
      symlinkSync(target, join(nativeDir(), "claude"));
      expect(
        resolveClaudeLaunch({ ...base, pathOverride: empty, homeOverride: home }).command,
      ).toBe(join(nativeDir(), "claude"));
    });

    // Windows has no execute bit (`X_OK` passes for any file there), so this
    // runs on the POSIX CI legs only (#2230).
    it.skipIf(process.platform === "win32")(
      "skips a file without the execute bit, as execvp does",
      () => {
        seed(join(root, "noexec"), "claude", 0o644);
        const ok = seed(join(root, "bin"), "claude");
        const pathOverride = [join(root, "noexec"), join(root, "bin")].join(delimiter);
        expect(resolveClaudeLaunch({ ...base, pathOverride, homeOverride: home }).command).toBe(ok);
      },
    );

    it("never takes a relative PATH entry — that would mean the working directory", () => {
      const rel = relative(process.cwd(), join(root, "rel"));
      seed(join(root, "rel"), "claude");
      expect(rel.startsWith("/")).toBe(false);
      expect(
        resolveClaudeLaunch({
          ...base,
          pathOverride: ["", ".", rel].join(delimiter),
          homeOverride: home,
        }),
      ).toEqual({ command: null, knownUnstartable: false });
    });

    it("answers null, not a bare name, when nothing resolves", () => {
      expect(resolveClaudeLaunch({ ...base, pathOverride: empty, homeOverride: home })).toEqual({
        command: null,
        knownUnstartable: false,
      });
    });

    describe("TANDEM_CLAUDE_CMD", () => {
      it("an absolute path is taken as given", () => {
        const file = seed(join(root, "custom"), "claude-canary");
        expect(
          resolveClaudeLaunch({ ...base, claudeCmdOverride: file, pathOverride: empty }).command,
        ).toBe(file);
      });

      it("a relative path is refused, even one that exists from the server's cwd", () => {
        seed(join(root, "custom"), "claude-canary");
        const rel = relative(process.cwd(), join(root, "custom", "claude-canary"));
        expect(
          resolveClaudeLaunch({ ...base, claudeCmdOverride: rel, pathOverride: empty }).command,
        ).toBeNull();
      });

      it("a bare name is looked up on PATH, and never falls back to the native install", () => {
        seed(nativeDir(), "claude");
        expect(
          resolveClaudeLaunch({
            ...base,
            claudeCmdOverride: "claude-canary",
            pathOverride: empty,
            homeOverride: home,
          }).command,
        ).toBeNull();
        const file = seed(join(root, "bin"), "claude-canary");
        expect(
          resolveClaudeLaunch({
            ...base,
            claudeCmdOverride: "claude-canary",
            pathOverride: join(root, "bin"),
            homeOverride: home,
          }).command,
        ).toBe(file);
      });
    });
  });

  describe("Windows", () => {
    const base = { platformOverride: "win32" as NodeJS.Platform, claudeCmdOverride: "" };

    it("an npm shim ahead of nothing is the affirmative unstartable finding", () => {
      seed(join(root, "npm"), "claude.cmd");
      const opts = { ...base, pathOverride: join(root, "npm"), homeOverride: home };
      expect(resolveClaudeLaunch(opts)).toEqual({ command: null, knownUnstartable: true });
      expect(isBareNameLaunchable(opts)).toBe(false);
    });

    it("a native claude.exe beside a shim-only PATH starts — no Tandem restart needed", () => {
      seed(join(root, "npm"), "claude.cmd");
      const exe = seed(nativeDir(), "claude.exe");
      const opts = { ...base, pathOverride: join(root, "npm"), homeOverride: home };
      expect(resolveClaudeLaunch(opts)).toEqual({ command: exe, knownUnstartable: false });
      expect(isBareNameLaunchable(opts)).toBe(true);
    });

    it("walks past a shim directory to a real .exe later on PATH", () => {
      seed(join(root, "npm"), "claude.cmd");
      const exe = seed(join(root, "native"), "claude.exe");
      const pathOverride = [join(root, "npm"), join(root, "native")].join(delimiter);
      expect(resolveClaudeLaunch({ ...base, pathOverride, homeOverride: home }).command).toBe(exe);
    });

    it("strips the quotes cmd.exe tolerates around a PATH entry", () => {
      const exe = seed(join(root, "quoted"), "claude.exe");
      expect(
        resolveClaudeLaunch({
          ...base,
          pathOverride: `"${join(root, "quoted")}"`,
          homeOverride: home,
        }).command,
      ).toBe(exe);
    });

    // `//<path>` is the same directory as `/<path>` on POSIX, and a UNC
    // spelling to `rejectUnsafeWindowsPrefix`: a real file sits behind each, so
    // these fail if the screen goes and the probe is allowed to find it.
    it("skips a UNC PATH entry rather than probing it", () => {
      const dir = join(root, "unc");
      seed(dir, "claude.exe");
      expect(resolveClaudeLaunch({ ...base, pathOverride: `/${dir}`, homeOverride: home })).toEqual(
        { command: null, knownUnstartable: false },
      );
      // Control: the same directory spelled plainly is found.
      expect(resolveClaudeLaunch({ ...base, pathOverride: dir, homeOverride: home }).command).toBe(
        join(dir, "claude.exe"),
      );
    });

    it("a UNC home is never probed for the native install", () => {
      seed(nativeDir(), "claude.exe");
      expect(
        resolveClaudeLaunch({ ...base, pathOverride: empty, homeOverride: `/${home}` }).command,
      ).toBeNull();
      expect(
        resolveClaudeLaunch({ ...base, pathOverride: empty, homeOverride: home }).command,
      ).toBe(join(nativeDir(), "claude.exe"));
    });

    it("an override naming a wrapper is refused — CreateProcessW would hand it to cmd.exe", () => {
      const cmd = seed(join(root, "npm"), "claude.cmd");
      expect(resolveClaudeLaunch({ ...base, claudeCmdOverride: cmd })).toEqual({
        command: null,
        knownUnstartable: true,
      });
      expect(resolveClaudeLaunch({ ...base, claudeCmdOverride: "claude.cmd" })).toEqual({
        command: null,
        knownUnstartable: true,
      });
    });

    it("an extensionless override path resolves to its .exe", () => {
      const exe = seed(join(root, "custom"), "claude.exe");
      expect(
        resolveClaudeLaunch({ ...base, claudeCmdOverride: join(root, "custom", "claude") }).command,
      ).toBe(exe);
    });
  });
});
