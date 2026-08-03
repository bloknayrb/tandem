import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectCodexCli } from "../../../src/shared/integrations/detect-codex-cli.js";

describe("detectCodexCli", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tandem-codex-detect-"));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function seed(dir: string, name: string): string {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), "");
    return dir;
  }

  it("finds codex on PATH", () => {
    const bin = seed(join(root, "bin"), process.platform === "win32" ? "codex.exe" : "codex");
    expect(detectCodexCli({ pathOverride: bin, homeOverride: join(root, "home") })).toBe(
      "INSTALLED_ON_PATH",
    );
  });

  it("finds the official Windows standalone location", () => {
    const local = join(root, "local");
    seed(join(local, "Programs", "OpenAI", "Codex", "bin"), "codex.exe");
    expect(
      detectCodexCli({
        platformOverride: "win32",
        pathOverride: join(root, "empty"),
        homeOverride: join(root, "home"),
        localAppDataOverride: local,
      }),
    ).toBe("INSTALLED_NOT_ON_PATH");
  });

  it("finds the POSIX standalone location", () => {
    const home = join(root, "home");
    seed(join(home, ".local", "bin"), "codex");
    expect(
      detectCodexCli({
        platformOverride: "linux",
        pathOverride: [join(root, "empty"), ""].join(delimiter),
        homeOverride: home,
      }),
    ).toBe("INSTALLED_NOT_ON_PATH");
  });
});
