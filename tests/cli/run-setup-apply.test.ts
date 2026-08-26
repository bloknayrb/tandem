import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `runSetup({ apply: true })` orchestrates the non-interactive write path
// (`applySetup` → detectTargets → writeTargets → installSkill). We mock the
// apply.js helpers so the orchestration logic — target filtering, the
// all-failed exit(1) gate, the zero-targets early path, skill install — is
// exercised without touching the filesystem or real Claude configs.
//
// This MUST be a separate file from `setup.test.ts`: `vi.mock` is hoisted
// file-wide, and `setup.test.ts` deliberately exercises the REAL apply.js
// helpers (buildMcpEntries/applyConfig/detectTargets/installSkill suites).
// Mocking apply.js there would gut that coverage.
vi.mock("../../src/server/integrations/apply.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/server/integrations/apply.js")>();
  return {
    ...actual,
    detectTargets: vi.fn(),
    applyConfig: vi.fn(),
    installSkill: vi.fn(),
    buildMcpEntries: vi.fn(() => ({})),
    applyOpsForCli: vi.fn(() => ({})),
    // `resolveChannelShimIntent`, not `resolveChannelShimIntent` — `setup`
    // moved to the former so an omitted flag preserves rather than deletes.
    // Left unmocked it does a REAL config read against these fake paths,
    // `assertPathSafe` throws, every target "fails", and the all-failed gate
    // exits 1 — which is how this file failed when the switch landed.
    resolveChannelShimIntent: vi.fn(async () => false),
    validateChannelShimPrereq: vi.fn(() => true),
  };
});

import { runSetup } from "../../src/cli/setup.js";
import {
  applyConfig,
  type DetectedTarget,
  detectTargets,
  installSkill,
  resolveChannelShimIntent,
} from "../../src/server/integrations/apply.js";

const CLAUDE_CODE: DetectedTarget = {
  label: "Claude Code",
  configPath: "/home/u/.claude.json",
  kind: "claude-code",
};
const CLAUDE_DESKTOP: DetectedTarget = {
  label: "Claude Desktop",
  configPath: "/home/u/claude_desktop_config.json",
  kind: "claude-desktop",
};

describe("runSetup({ apply: true }) orchestration", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  const stderr = () => errSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? "")).join("\n");

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(detectTargets).mockReset();
    vi.mocked(applyConfig).mockReset();
    vi.mocked(installSkill).mockReset().mockResolvedValue(undefined);
    vi.mocked(resolveChannelShimIntent).mockReset().mockResolvedValue(false);
  });
  afterEach(() => {
    errSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("writes config for a detected target and reports success (no exit)", async () => {
    vi.mocked(detectTargets).mockReturnValue([CLAUDE_CODE]);
    vi.mocked(applyConfig).mockResolvedValue(undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    await runSetup({ apply: true });

    expect(applyConfig).toHaveBeenCalledTimes(1);
    expect(applyConfig).toHaveBeenCalledWith(CLAUDE_CODE.configPath, expect.anything());
    expect(installSkill).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
    const out = stderr();
    expect(out).toContain("Writing MCP configuration");
    expect(out).toContain("Setup complete");
  });

  it("exits 1 when every target write fails (after installing the skill)", async () => {
    vi.mocked(detectTargets).mockReturnValue([CLAUDE_CODE]);
    vi.mocked(applyConfig).mockRejectedValue(new Error("EACCES"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    // process.exit is mocked to throw, so the all-failed gate at the end of
    // applySetup surfaces as a rejection. installSkill ran earlier, before it.
    await expect(runSetup({ apply: true })).rejects.toThrow("process.exit called");

    expect(installSkill).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderr()).toContain("Setup failed");
  });

  it("partial failure (some targets succeed, some fail) does not exit", async () => {
    vi.mocked(detectTargets).mockReturnValue([CLAUDE_CODE, CLAUDE_DESKTOP]);
    // writeTargets iterates in order: claude-code succeeds, claude-desktop fails
    // → failures=1, targets.length=2 → the `failures > 0 && failures < length`
    // partial branch, which must NOT exit(1).
    vi.mocked(applyConfig)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("EACCES"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    await runSetup({ apply: true });

    expect(applyConfig).toHaveBeenCalledTimes(2);
    expect(installSkill).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderr()).toContain("partially complete");
  });

  it("does not exit when zero targets are detected, but still installs the skill", async () => {
    vi.mocked(detectTargets).mockReturnValue([]);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    await runSetup({ apply: true });

    expect(applyConfig).not.toHaveBeenCalled();
    expect(installSkill).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
    const out = stderr();
    expect(out).toContain("No matching Claude installations detected");
    expect(out).toContain("Installing Claude Code skill");
  });

  it("restricts writes to the requested --target kind", async () => {
    vi.mocked(detectTargets).mockReturnValue([CLAUDE_CODE, CLAUDE_DESKTOP]);
    vi.mocked(applyConfig).mockResolvedValue(undefined);
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    await runSetup({ apply: true, targets: ["claude-code"] });

    expect(applyConfig).toHaveBeenCalledTimes(1);
    expect(applyConfig).toHaveBeenCalledWith(CLAUDE_CODE.configPath, expect.anything());
  });

  /**
   * The push-status report.
   *
   * It used to print "Enabled" off `existsSync(CHANNEL_DIST)` — a FILE check,
   * not a record of what was written. `resolveChannelShimIntent` returns false
   * for every Claude Desktop target, so `--target=claude-desktop` announced a
   * shim it had never registered. These pin the report to the writes that
   * actually happened; without them, reverting to the file check is silent.
   */
  describe("push status", () => {
    const noExit = () =>
      vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);
    // The status line colourises the leading word, so an ANSI reset sits
    // between "Registered" and " for:". Strip escapes rather than asserting
    // around them, or these assertions break on any styling change.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI SGR escapes is the point
    const plain = () => stderr().replace(/\x1b\[[0-9;]*m/g, "");

    it("does not claim push when no target took a shim (the Desktop-only case)", async () => {
      vi.mocked(resolveChannelShimIntent).mockResolvedValue(false);
      vi.mocked(detectTargets).mockReturnValue([CLAUDE_DESKTOP]);
      vi.mocked(applyConfig).mockResolvedValue(undefined);
      noExit();

      await runSetup({ apply: true });

      expect(plain()).toContain("Not registered");
      expect(plain()).not.toContain("Registered for:");
      // The specific regression: the word that used to appear here.
      expect(plain()).not.toMatch(/\bEnabled\b/);
    });

    it("names the targets that actually got a shim", async () => {
      vi.mocked(resolveChannelShimIntent).mockImplementation(
        async (kind) => kind === "claude-code",
      );
      vi.mocked(detectTargets).mockReturnValue([CLAUDE_CODE, CLAUDE_DESKTOP]);
      vi.mocked(applyConfig).mockResolvedValue(undefined);
      noExit();

      await runSetup({ apply: true });

      expect(plain()).toContain("Registered for: Claude Code");
      expect(plain()).not.toContain("Claude Desktop,");
      // Registration is not delivery — a hand-launched session still needs the
      // flag, and saying otherwise is the original sin this report is fixing.
      expect(plain()).toContain("--dangerously-load-development-channels server:tandem-channel");
    });

    it("does not credit a target whose config write failed", async () => {
      // `shimRegisteredFor.push` sits AFTER the awaited `applyConfig` for this
      // reason: a target we intended to give a shim, but could not write, has
      // no shim. Hoisting that line above the await would make this pass.
      //
      // Two targets, both eligible, one write failing — a single failing target
      // would take the all-failed exit path and never reach the report at all.
      vi.mocked(resolveChannelShimIntent).mockResolvedValue(true);
      vi.mocked(detectTargets).mockReturnValue([CLAUDE_CODE, CLAUDE_DESKTOP]);
      vi.mocked(applyConfig)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("EACCES"));
      noExit();

      await runSetup({ apply: true });

      // Scope to the status line — "Claude Desktop" legitimately appears
      // elsewhere in the output (the "Found:" list, and its own ✗ failure line).
      const line = plain()
        .split("\n")
        .find((l: string) => l.includes("Registered for:"));
      expect(line).toBeDefined();
      expect(line).toContain("Claude Code");
      expect(line).not.toContain("Claude Desktop");
    });
  });
});
