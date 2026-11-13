/**
 * #2358 PR 3a — the run files' fail-closed steps on real Windows ACLs (R1.6).
 * Real `icacls` (the lock and the owner changes) and `Get-Acl` (the re-reads),
 * no mock. Run by the `windows-acl-proof` job, which refuses a skip; `check`
 * is Linux only and passes the POSIX twins in run-files.test.ts, which prove
 * nothing about Windows.
 *
 * Covers: a `launcher/` owned by the current user's SID passes the owner check
 * and is locked with no broad ACE; one owned by anyone else — Administrators,
 * which is what an ELEVATED Tandem creates (the CI runner is elevated, so its
 * fresh directories are `O:BA`), or TrustedInstaller — is refused; a file and
 * a dangling link at a run file's name are refused before the create.
 *
 * Each directory's owner is SET here rather than assumed, because the default
 * owner depends on whether the process is elevated: Bryan's PC (unelevated)
 * and the CI runner (elevated) would otherwise prove opposite halves.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertNoBroadAce,
  assertOwnedByCurrentUser,
  setRestrictiveAcl,
  withoutPsModulePath,
} from "../../../src/server/integrations/acl-win.js";
import {
  ensureLauncherDir,
  type RunFileAcl,
  realRunFileAcl,
  resetVerifiedLauncherDirsForTests,
  writeRunFile,
} from "../../../src/server/launcher/run-files.js";

// #2390: opt out of tests/setup/acl-win-mock.ts (hoisted above the imports).
vi.unmock(import("../../../src/server/integrations/acl-win.js"));

const WIN_ONLY = process.platform === "win32";
const execFileAsync = promisify(execFile);

it("uses the real acl-win module", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/server/integrations/acl-win.js")
  >("../../../src/server/integrations/acl-win.js");
  expect(setRestrictiveAcl).toBe(actual.setRestrictiveAcl);
});

const system32 = (exe: string) =>
  path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);

async function currentUserSid(): Promise<string> {
  const { stdout } = await execFileAsync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
  const sid = /"(S-[\d-]+)"\s*$/m.exec(stdout)?.[1];
  if (!sid) throw new Error(`no SID in whoami output: ${stdout}`);
  return sid;
}

/** `dir`'s owner as a full SID (never the SDDL alias). */
async function ownerSid(dir: string): Promise<string> {
  const script =
    "(Get-Acl -LiteralPath $env:TANDEM_SDDL_PATH).GetOwner([System.Security.Principal.SecurityIdentifier]).Value";
  const args = ["-NoProfile", "-NonInteractive", "-Command", script];
  const env: NodeJS.ProcessEnv = { ...process.env, TANDEM_SDDL_PATH: dir };
  try {
    return (await execFileAsync("pwsh.exe", args, { env })).stdout.trim();
  } catch {
    const fallbackEnv = withoutPsModulePath(env);
    const ps = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    return (await execFileAsync(ps, args, { env: fallbackEnv })).stdout.trim();
  }
}

/** Set `dir`'s owner, and report whether it now IS that owner: `icacls` exits 0
 * on a partial failure, so its exit code proves nothing (an unelevated process
 * cannot make Administrators the owner). */
async function setOwner(dir: string, sid: string): Promise<boolean> {
  try {
    await execFileAsync(system32("icacls.exe"), [dir, "/setowner", `*${sid}`]);
  } catch {
    return false;
  }
  return (await ownerSid(dir)) === sid;
}

describe.skipIf(!WIN_ONLY)("run files — Windows ACL proof (#2358 PR 3a)", () => {
  let root: string;
  let me: string;
  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "run-files-win-")));
    me = await currentUserSid();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  /** A `launcher/` that the current user's SID owns, whatever the elevation. */
  async function ownLauncherDir(): Promise<string> {
    const dir = path.join(root, "launcher");
    fs.mkdirSync(dir);
    const set = await setOwner(dir, me);
    expect(set, `owner after /setowner: ${await ownerSid(dir)}, user ${me}`).toBe(true);
    return dir;
  }

  it("a launcher/ the current user owns passes the owner check and is locked with no broad ACE", async () => {
    const dir = await ownLauncherDir();
    await expect(assertOwnedByCurrentUser(dir)).resolves.toBeUndefined();
    expect(await ensureLauncherDir(dir, { create: true, acl: realRunFileAcl })).toBe(true);
    await expect(assertNoBroadAce(dir)).resolves.toBeUndefined();
    const file = await writeRunFile(dir, "mcp", { a: 1 }, realRunFileAcl);
    await expect(assertNoBroadAce(file)).resolves.toBeUndefined();
  }, 120_000);

  it("a directory anyone else owns is refused: TrustedInstaller always, Administrators (an elevated Tandem's) where it can be set", async () => {
    // Read-only: the owner check never reaches the lock, and only Get-Acl runs.
    await expect(assertOwnedByCurrentUser(process.env.SystemRoot ?? "C:\\Windows")).rejects.toThrow(
      /assertOwnedByCurrentUser/,
    );

    const dir = path.join(root, "launcher");
    fs.mkdirSync(dir);
    // S-1-5-32-544 is BUILTIN\Administrators: the owner an elevated process's
    // new directories get. Only an elevated process may assign it; the CI
    // runner is elevated, so the job always proves this half.
    if (await setOwner(dir, "S-1-5-32-544")) {
      await expect(
        ensureLauncherDir(dir, { create: true, acl: realRunFileAcl }),
      ).rejects.toMatchObject({
        step: "launcher-dir-not-owned",
      });
    }
  }, 120_000);

  it("a file or a dangling link at the run file's name is refused", async () => {
    const dir = await ownLauncherDir();
    await ensureLauncherDir(dir, { create: true, acl: realRunFileAcl });
    const present = "1".repeat(32);
    fs.writeFileSync(path.join(dir, `tandem-run-mcp-${present}.json`), "x");
    await expect(writeRunFile(dir, "mcp", {}, realRunFileAcl, present)).rejects.toMatchObject({
      step: "mcp-name-present",
    });
    const dangling = "2".repeat(32);
    fs.symlinkSync(
      path.join(root, "nowhere.json"),
      path.join(dir, `tandem-run-settings-${dangling}.json`),
    );
    await expect(writeRunFile(dir, "settings", {}, realRunFileAcl, dangling)).rejects.toMatchObject(
      { step: "settings-name-present" },
    );
    expect(fs.existsSync(path.join(root, "nowhere.json"))).toBe(false);
  }, 120_000);

  it("the directory's checks run once per process, and again when the directory is replaced (review item 4)", async () => {
    resetVerifiedLauncherDirsForTests();
    const calls: string[] = [];
    const counting: RunFileAcl = {
      assertOwned: async (p) => {
        calls.push("owner");
        await realRunFileAcl.assertOwned(p);
      },
      lockDir: async (p) => {
        calls.push("lock");
        await realRunFileAcl.lockDir(p);
      },
      verifyNoBroadAce: async (p) => {
        calls.push("verify");
        await realRunFileAcl.verifyNoBroadAce(p);
      },
    };
    const dir = await ownLauncherDir();
    await ensureLauncherDir(dir, { create: true, acl: counting });
    await ensureLauncherDir(dir, { create: true, acl: counting });
    expect(calls).toEqual(["owner", "lock", "verify"]);
    // Replaced: a new directory at the same path is checked again.
    fs.rmSync(dir, { recursive: true, force: true });
    await ownLauncherDir();
    await ensureLauncherDir(dir, { create: true, acl: counting });
    expect(calls).toEqual(["owner", "lock", "verify", "owner", "lock", "verify"]);
  }, 120_000);

  it("a launcher/ that is a junction is refused", async () => {
    const real = path.join(root, "real");
    fs.mkdirSync(real);
    const dir = path.join(root, "launcher");
    fs.symlinkSync(real, dir, "junction");
    await expect(
      ensureLauncherDir(dir, { create: true, acl: realRunFileAcl }),
    ).rejects.toMatchObject({ step: "launcher-dir-is-a-link" });
  }, 120_000);
});
