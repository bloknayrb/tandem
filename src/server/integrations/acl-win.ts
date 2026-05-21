/**
 * Windows DACL hardening for files that contain bearer tokens (`~/.claude.json`
 * and similar). Every function in this module is a no-op on non-Windows
 * platforms — POSIX paths use `chmod 0o600` instead.
 *
 * Security contract:
 * - `icacls`, `whoami`, and `powershell` are always invoked via `execFile`
 *   with an argv array, never via a shell. Paths flow from `homedir()`
 *   which is user-controlled via `HOME`/`USERPROFILE`; any shell-style
 *   invocation is a command-injection bug.
 * - Broad-principal detection (`assertNoBroadAce`) reads the file's SDDL
 *   via PowerShell `(Get-Acl).Sddl`. SDDL uses locale-independent 2-letter
 *   shortcuts for well-known SIDs (`WD`=Everyone, `AU`=Authenticated
 *   Users, `BU`=BUILTIN\Users). Parsing `icacls` default output instead
 *   would false-negative on non-English Windows (where the resolver
 *   returns "Utilisateurs", "Benutzer", etc.) and on partial-success
 *   exit-0 cases where icacls's "Failed processing N files" summary is
 *   also localised.
 * - `setRestrictiveAcl` grants by **SID** (resolved once per process via
 *   `whoami /user`), not by `process.env.USERNAME`. USERNAME is
 *   in-process spoofable; a poisoned USERNAME could direct the grant at
 *   a different local user whose name happens to collide, or contain
 *   characters icacls parses unexpectedly (`:`, `/`, embedded UPNs).
 * - `setRestrictiveAcl` calls `/inheritance:r` THEN `/grant:r`. Without
 *   `:r` on both flags, inherited ACEs from the parent dir survive and
 *   `/grant` adds the user as an additional principal instead of
 *   replacing the ACL.
 * - The tempfile self-verify (`assertNoBroadAce` at the end of
 *   `setRestrictiveAcl`) is load-bearing — icacls is documented to exit
 *   0 on partial failure (silent no-op). The SDDL re-read is the only
 *   trustworthy signal that the DACL is actually correct.
 * - PowerShell paths are passed via the `TANDEM_ACL_PATH` env var, not
 *   interpolated into the script string. This avoids every quoting /
 *   escaping pitfall for paths that contain spaces, apostrophes, or
 *   backticks.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Resolve a Windows system binary by absolute path under `%SystemRoot%`.
 * Bypasses `PATH` so a git-bash / MSYS / Cygwin shadow (e.g. their own
 * `whoami` that doesn't understand Windows flags) can't intercept us.
 * `icacls` and `whoami` both live in `System32`.
 */
function systemBin(name: string): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
}

/**
 * Run a PowerShell script, preferring PowerShell 7 (`pwsh.exe`) and falling
 * back to Windows PowerShell 5.1 (`powershell.exe`). pwsh is more reliable —
 * 5.1's auto-module-load has been observed to fail intermittently for
 * `Microsoft.PowerShell.Security` in CI sandboxes and on some user setups.
 *
 * Fallback is gated on `ENOENT` only. A spawn error of `EACCES` or `EPERM`
 * almost always reflects an AppLocker / WDAC policy denial — silently
 * routing around it via the legacy shell is the wrong defence posture
 * (admin's policy is a real security boundary). The original error is
 * preserved as `cause` on the fallback's failure for log forensics.
 */
async function runPowerShell(script: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string }> {
  const args = ["-NoProfile", "-NonInteractive", "-Command", script];
  try {
    return await execFileAsync("pwsh.exe", args, { env });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    try {
      return await execFileAsync("powershell.exe", args, { env });
    } catch (fallbackErr) {
      throw new Error(
        `runPowerShell: both pwsh.exe and powershell.exe failed (pwsh: ${(err as Error).message})`,
        { cause: fallbackErr },
      );
    }
  }
}

/**
 * SDDL ACE-string fragments that flag a broad-principal grant. These
 * shortcuts are locale-independent — they appear verbatim in the SDDL
 * regardless of Windows display language.
 *
 * Each pattern matches the principal-SID position of an SDDL ACE,
 * which is the last token before the closing `)`. Example ACE:
 *   `(A;;FA;;;WD)`  ← Everyone has Full Access
 *
 * Reference: https://learn.microsoft.com/windows/win32/secauthz/sid-strings
 */
const BROAD_SDDL_FRAGMENTS = [
  ";WD)", // Everyone (S-1-1-0)
  ";AU)", // Authenticated Users (S-1-5-11)
  ";BU)", // BUILTIN\Users (S-1-5-32-545)
] as const;

/**
 * Cached SID of the current Windows user. `whoami /user` is the cheapest
 * locale-independent way to get this. Resolved once per process; cleared
 * to `null` only on test reset.
 */
let cachedCurrentUserSid: string | null = null;

/** Reset for tests only. Production callers MUST NOT depend on resetting. */
export function _resetCurrentUserSidForTests(): void {
  cachedCurrentUserSid = null;
}

/**
 * Resolve the SID of the current user via `whoami /user /fo csv /nh`. CSV
 * output is locale-independent and parses cleanly without PowerShell.
 */
async function getCurrentUserSid(): Promise<string> {
  if (cachedCurrentUserSid !== null) return cachedCurrentUserSid;
  const { stdout } = await execFileAsync(systemBin("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
  // CSV row format: `"DOMAIN\user","S-1-5-21-..."` — extract the second column.
  const match = stdout.match(/"(S-[\d-]+)"\s*$/m);
  if (!match) {
    throw new Error(`getCurrentUserSid: could not parse SID from whoami output: ${stdout.trim()}`);
  }
  cachedCurrentUserSid = match[1];
  return cachedCurrentUserSid;
}

/**
 * Set a restrictive DACL on `path`: break inheritance, then grant Full
 * Control to the current user (by SID, not name) only. On non-Windows,
 * no-op.
 *
 * Includes a post-set SDDL re-verify on `path` because icacls is
 * documented to exit 0 even when "Failed processing N files" — the SDDL
 * read is the only trustworthy signal that the DACL is actually correct.
 *
 * @throws if any step (SID resolve, icacls, verify) fails.
 */
export async function setRestrictiveAcl(path: string): Promise<void> {
  if (process.platform !== "win32") return;

  const sid = await getCurrentUserSid();

  // icacls processes flags left-to-right in one invocation:
  //   /inheritance:r — remove ALL inherited entries (`:d` would copy them
  //                    as explicit, defeating the purpose)
  //   /grant:r       — replace any existing explicit ACE for the user
  //                    rather than ADD a new one (no `:r` → duplicates
  //                    accumulate over repeated runs).
  //   *<SID>:F       — grant Full Control by SID. The `*` prefix tells
  //                    icacls to interpret the principal as a raw SID
  //                    rather than a name to look up.
  try {
    await execFileAsync(systemBin("icacls.exe"), [path, "/inheritance:r", "/grant:r", `*${sid}:F`]);
  } catch (err) {
    throw new Error(`setRestrictiveAcl: icacls failed on ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }

  await assertNoBroadAce(path);
}

/**
 * Read the SDDL of `path` and assert no well-known broad principal is
 * granted access. Uses PowerShell `Get-Acl` so the principal check works
 * regardless of Windows display language.
 *
 * @throws if any broad-principal SDDL shortcut appears in the file's ACL.
 */
export async function assertNoBroadAce(path: string): Promise<void> {
  if (process.platform !== "win32") return;

  // `-LiteralPath` ensures wildcards in the path are not expanded. The
  // explicit `Import-Module` is defensive — `Get-Acl` lives in
  // `Microsoft.PowerShell.Security` which usually auto-loads, but the
  // auto-load fails in some sandboxed shells (e.g. CI runners with
  // restricted module paths).
  const script =
    "Import-Module Microsoft.PowerShell.Security; (Get-Acl -LiteralPath $env:TANDEM_ACL_PATH).Sddl";

  const { stdout } = await runPowerShell(script, {
    ...process.env,
    TANDEM_ACL_PATH: path,
  });

  const sddl = stdout.trim();
  for (const fragment of BROAD_SDDL_FRAGMENTS) {
    if (sddl.includes(fragment)) {
      throw new Error(
        `assertNoBroadAce: ${path} has a broad-principal ACE (SDDL fragment ${fragment}). SDDL:\n${sddl}`,
      );
    }
  }
}
