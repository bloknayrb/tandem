import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectClaudeCli } from "../../../src/server/integrations/apply.js";

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

/** `<home>/.local/bin/<binName>` — the native installer's documented target. */
function seedBinUnderHome(home: string, binName: string): void {
  const dir = join(home, ".local", "bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, binName), "");
}
