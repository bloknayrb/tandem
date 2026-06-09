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
    shouldRegisterChannelShim: vi.fn(() => false),
    validateChannelShimPrereq: vi.fn(() => true),
  };
});

import { runSetup } from "../../src/cli/setup.js";
import {
  applyConfig,
  type DetectedTarget,
  detectTargets,
  installSkill,
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
  const stderr = () => errSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(detectTargets).mockReset();
    vi.mocked(applyConfig).mockReset();
    vi.mocked(installSkill).mockReset().mockResolvedValue(undefined);
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
});
