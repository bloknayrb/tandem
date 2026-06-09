import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ClaudeInstallError,
  fetchInstallerScript,
  type InstallClaudeCliDeps,
  installClaudeCli,
  UnsupportedPlatformError,
} from "../../../src/server/integrations/install-claude-cli.js";

/**
 * The runner is the one module that downloads + executes the installer, so
 * these tests inject EVERY side-effecting dependency — `execFileAsync` (never
 * spawn a real interpreter), `detectClaudeCli` (call-counted), `fetchScript`
 * (never hit the network), and the Windows ACL helpers (never run real
 * icacls/PowerShell on Bryan's Windows host). Only the temp-dir create/write/rm
 * uses real `fs`, which lets us assert cleanup from the captured script path.
 */

const FAKE_SCRIPT = "#!/bin/sh\necho installing\n";

/** A `detectClaudeCli` stub: returns the queue values in order, repeating last. */
function detectQueue(...values: ReturnType<typeof String>[]) {
  let i = 0;
  return vi.fn(() => values[Math.min(i++, values.length - 1)] as never);
}

/** Stubs that make installClaudeCli inert apart from the temp-file dance. */
function baseDeps(over: Partial<InstallClaudeCliDeps> = {}): InstallClaudeCliDeps {
  return {
    detectClaudeCli: detectQueue("NOT_INSTALLED", "INSTALLED_NOT_ON_PATH"),
    fetchScript: vi.fn(async () => FAKE_SCRIPT),
    execFileAsync: vi.fn(async () => ({ stdout: "", stderr: "" })) as never,
    setRestrictiveAcl: vi.fn(async () => {}),
    assertNoBroadAce: vi.fn(async () => {}),
    ...over,
  };
}

describe("installClaudeCli", () => {
  const realPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    vi.restoreAllMocks();
  });

  it("throws UnsupportedPlatformError on an unsupported OS", async () => {
    Object.defineProperty(process, "platform", { value: "aix", configurable: true });
    const fetchScript = vi.fn(async () => FAKE_SCRIPT);
    await expect(installClaudeCli(baseDeps({ fetchScript }))).rejects.toBeInstanceOf(
      UnsupportedPlatformError,
    );
    // Unsupported platform short-circuits before any network/exec.
    expect(fetchScript).not.toHaveBeenCalled();
  });

  it("short-circuits when the CLI is already installed (no fetch, no exec)", async () => {
    const fetchScript = vi.fn(async () => FAKE_SCRIPT);
    const execFileAsync = vi.fn(async () => ({ stdout: "", stderr: "" })) as never;
    const presence = await installClaudeCli(
      baseDeps({
        detectClaudeCli: detectQueue("INSTALLED_ON_PATH"),
        fetchScript,
        execFileAsync,
      }),
    );
    expect(presence).toBe("INSTALLED_ON_PATH");
    expect(fetchScript).not.toHaveBeenCalled();
    expect(execFileAsync).not.toHaveBeenCalled();
  });

  it("execs the interpreter with NO shell and the script path as final arg", async () => {
    const calls: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = [];
    const execFileAsync = vi.fn(async (file: string, args: string[], opts: object) => {
      calls.push({ file, args, opts: opts as Record<string, unknown> });
      return { stdout: "", stderr: "" };
    }) as never;

    const presence = await installClaudeCli(baseDeps({ execFileAsync }));

    expect(presence).toBe("INSTALLED_NOT_ON_PATH");
    expect(calls).toHaveLength(1);
    const { file, args, opts } = calls[0];
    // The load-bearing security assertion: argv-only, never `shell: true`.
    expect(opts.shell).toBeUndefined();
    const scriptPath = args[args.length - 1];
    if (process.platform === "win32") {
      expect(file).toBe("pwsh.exe");
      expect(args.slice(0, 4)).toEqual(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
      expect(scriptPath.endsWith("install.ps1")).toBe(true);
    } else {
      expect(file).toBe("/bin/sh");
      expect(args).toHaveLength(1);
      expect(scriptPath.endsWith("install.sh")).toBe(true);
    }
  });

  it("passes a minimal env (CI=1, no full process.env spread)", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const execFileAsync = vi.fn(
      async (_f: string, _a: string[], opts: { env?: NodeJS.ProcessEnv }) => {
        capturedEnv = opts.env;
        return { stdout: "", stderr: "" };
      },
    ) as never;

    await installClaudeCli(baseDeps({ execFileAsync }));

    expect(capturedEnv?.CI).toBe("1");
    // A few env vars that exist in the test process but are NOT in the
    // allowlist must be absent — proves it's not a process.env spread.
    expect(capturedEnv?.VITEST).toBeUndefined();
    expect(capturedEnv?.npm_lifecycle_event).toBeUndefined();
  });

  it("maps a non-zero exit to ClaudeInstallError with exitCode + stderrTail", async () => {
    const execFileAsync = vi.fn(async () => {
      const err = Object.assign(new Error("Command failed"), {
        code: 17,
        stderr: "network unreachable\n",
      });
      throw err;
    }) as never;

    const promise = installClaudeCli(baseDeps({ execFileAsync }));
    await expect(promise).rejects.toBeInstanceOf(ClaudeInstallError);
    await promise.catch((err: ClaudeInstallError) => {
      expect(err.exitCode).toBe(17);
      expect(err.stderrTail).toContain("network unreachable");
    });
  });

  it("strips ANSI/control sequences from stderrTail (PowerShell colorizes errors)", async () => {
    const execFileAsync = vi.fn(async () => {
      throw Object.assign(new Error("failed"), {
        code: 3,
        // Real `pwsh` Write-Error output: SGR color codes around the message.
        stderr: "\x1b[31;1mWrite-Error: \x1b[0msimulated failure\x1b[0m\n",
      });
    }) as never;

    await installClaudeCli(baseDeps({ execFileAsync })).catch((err: ClaudeInstallError) => {
      expect(err.stderrTail).not.toMatch(/\x1b/);
      expect(err.stderrTail).toContain("Write-Error: simulated failure");
    });
  });

  it("scrubs the temp path out of stderrTail", async () => {
    let captured: string | undefined;
    const execFileAsync = vi.fn(async (_f: string, args: string[]) => {
      captured = dirname(args[args.length - 1]);
      const err = Object.assign(new Error("failed"), {
        code: 1,
        stderr: `error in ${captured}/install.sh at line 3`,
      });
      throw err;
    }) as never;

    await installClaudeCli(baseDeps({ execFileAsync })).catch((err: ClaudeInstallError) => {
      expect(captured).toBeDefined();
      expect(err.stderrTail).not.toContain(captured as string);
      expect(err.stderrTail).toContain("<tmp>");
    });
  });

  it("removes the temp dir after a successful install", async () => {
    let scriptPath: string | undefined;
    const execFileAsync = vi.fn(async (_f: string, args: string[]) => {
      scriptPath = args[args.length - 1];
      expect(existsSync(scriptPath)).toBe(true); // exists during exec
      return { stdout: "", stderr: "" };
    }) as never;

    await installClaudeCli(baseDeps({ execFileAsync }));
    expect(scriptPath).toBeDefined();
    expect(existsSync(dirname(scriptPath as string))).toBe(false); // cleaned up
  });

  it("removes the temp dir even when the installer throws", async () => {
    let scriptPath: string | undefined;
    const execFileAsync = vi.fn(async (_f: string, args: string[]) => {
      scriptPath = args[args.length - 1];
      throw Object.assign(new Error("boom"), { code: 1, stderr: "boom" });
    }) as never;

    await installClaudeCli(baseDeps({ execFileAsync })).catch(() => {});
    expect(scriptPath).toBeDefined();
    expect(existsSync(dirname(scriptPath as string))).toBe(false);
  });
});

describe("fetchInstallerScript — scheme/host pinning (F2)", () => {
  /** Minimal fake `https.get`: returns a canned response via an EventEmitter. */
  function fakeGet(
    responses: Record<
      string,
      { statusCode: number; headers?: Record<string, string>; body?: string }
    >,
  ) {
    return ((url: string, cb: (res: unknown) => void) => {
      const res = makeFakeRes(responses[url] ?? { statusCode: 404 });
      // Defer to mimic async I/O, then drive the response: `cb` attaches the
      // consumer's data/end listeners synchronously, so emit only AFTER it.
      queueMicrotask(() => {
        cb(res);
        res._emit();
      });
      return { on: () => {}, destroy: () => {}, setTimeout: () => {} };
    }) as never;
  }

  function makeFakeRes(spec: {
    statusCode: number;
    headers?: Record<string, string>;
    body?: string;
  }) {
    const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
    const res = {
      statusCode: spec.statusCode,
      headers: spec.headers ?? {},
      resume() {},
      destroy() {},
      on(event: string, fn: (arg?: unknown) => void) {
        (handlers[event] ??= []).push(fn);
        return res;
      },
      /** Emit the body for a 200; redirects/errors are handled in `cb` itself. */
      _emit() {
        if (spec.statusCode !== 200) return;
        for (const fn of handlers.data ?? []) fn(Buffer.from(spec.body ?? ""));
        for (const fn of handlers.end ?? []) fn();
      },
    };
    return res;
  }

  it("rejects a redirect that downgrades to http://", async () => {
    const httpsGet = fakeGet({
      "https://claude.ai/install.sh": {
        statusCode: 302,
        headers: { location: "http://claude.ai/install.sh" },
      },
    });
    await expect(
      fetchInstallerScript("https://claude.ai/install.sh", { httpsGet }),
    ).rejects.toThrow(/must be https/i);
  });

  it("rejects a redirect to a different host", async () => {
    const httpsGet = fakeGet({
      "https://claude.ai/install.sh": {
        statusCode: 302,
        headers: { location: "https://evil.example.com/install.sh" },
      },
    });
    await expect(
      fetchInstallerScript("https://claude.ai/install.sh", { httpsGet }),
    ).rejects.toThrow(/must be https/i);
  });

  it("rejects an initial non-https URL without fetching", async () => {
    const httpsGet = vi.fn() as never;
    await expect(fetchInstallerScript("http://claude.ai/install.sh", { httpsGet })).rejects.toThrow(
      /must be https/i,
    );
    expect(httpsGet).not.toHaveBeenCalled();
  });

  it("returns the body on a 200 from the pinned host", async () => {
    const httpsGet = fakeGet({
      "https://claude.ai/install.sh": { statusCode: 200, body: FAKE_SCRIPT },
    });
    await expect(fetchInstallerScript("https://claude.ai/install.sh", { httpsGet })).resolves.toBe(
      FAKE_SCRIPT,
    );
  });

  it("follows one same-host https redirect to the final body", async () => {
    const httpsGet = fakeGet({
      "https://claude.ai/install.sh": {
        statusCode: 301,
        headers: { location: "https://claude.ai/v2/install.sh" },
      },
      "https://claude.ai/v2/install.sh": { statusCode: 200, body: FAKE_SCRIPT },
    });
    await expect(fetchInstallerScript("https://claude.ai/install.sh", { httpsGet })).resolves.toBe(
      FAKE_SCRIPT,
    );
  });
});
