import { dirname } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexInstallError,
  type InstallCodexDeps,
  installCodexCli,
} from "../../../src/server/integrations/install-codex-cli.js";

function detection(
  ...values: Array<"NOT_INSTALLED" | "INSTALLED_ON_PATH" | "INSTALLED_NOT_ON_PATH">
) {
  let index = 0;
  return vi.fn(() => values[Math.min(index++, values.length - 1)]);
}

function deps(overrides: Partial<InstallCodexDeps> = {}): InstallCodexDeps {
  return {
    detect: detection("NOT_INSTALLED", "INSTALLED_NOT_ON_PATH"),
    fetchScript: vi.fn(async () => "echo installing\n"),
    run: vi.fn(async () => ({ stdout: "", stderr: "" })) as never,
    setAcl: vi.fn(async () => {}),
    assertAcl: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("installCodexCli", () => {
  const realPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    vi.restoreAllMocks();
  });

  it("does nothing when Codex is already installed", async () => {
    const fetchScript = vi.fn(async () => "");
    const run = vi.fn(async () => ({ stdout: "", stderr: "" })) as never;
    await expect(
      installCodexCli(deps({ detect: detection("INSTALLED_ON_PATH"), fetchScript, run })),
    ).resolves.toBe("INSTALLED_ON_PATH");
    expect(fetchScript).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("executes the downloaded script by argv without a shell", async () => {
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const run = vi.fn(async (command: string, args: string[], options: object) => {
      calls.push({ command, args, options: options as Record<string, unknown> });
      return { stdout: "", stderr: "" };
    }) as never;
    await expect(installCodexCli(deps({ run }))).resolves.toBe("INSTALLED_NOT_ON_PATH");
    expect(calls).toHaveLength(1);
    expect(calls[0].options.shell).toBeUndefined();
    expect(calls[0].args.at(-1)).toMatch(/install\.(ps1|sh)$/);
  });

  it("passes only the minimal environment", async () => {
    let captured: NodeJS.ProcessEnv | undefined;
    const run = vi.fn(
      async (_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        captured = options.env;
        return { stdout: "", stderr: "" };
      },
    ) as never;
    await installCodexCli(deps({ run }));
    expect(captured?.CODEX_NON_INTERACTIVE).toBe("1");
    expect(captured?.VITEST).toBeUndefined();
    expect(captured?.npm_lifecycle_event).toBeUndefined();
  });

  it("sanitizes failures and removes the temporary path", async () => {
    let tempDir = "";
    const run = vi.fn(async (_command: string, args: string[]) => {
      tempDir = dirname(args.at(-1) ?? "");
      throw Object.assign(new Error("failed"), {
        code: 9,
        stderr: `\u001b[31mfailed in ${tempDir}\u001b[0m`,
      });
    }) as never;
    const promise = installCodexCli(deps({ run }));
    await expect(promise).rejects.toBeInstanceOf(CodexInstallError);
    await promise.catch((error: CodexInstallError) => {
      expect(error.exitCode).toBe(9);
      expect(error.stderrTail).not.toContain("\u001b");
      expect(error.stderrTail).not.toContain(tempDir);
      expect(error.stderrTail).toContain("<tmp>");
    });
  });
});
