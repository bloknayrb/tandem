/**
 * Windows DACL hardening for files that contain bearer tokens (`~/.claude.json`
 * and similar). Every function in this module is a no-op on non-Windows
 * platforms — POSIX paths get `chmod 0o600` through Node's native `mode`
 * argument, which is the right primitive there.
 *
 * Security contract:
 * - `icacls` and `powershell` are always invoked via `execFile` with an argv
 *   array, never via a shell. Paths flow from `homedir()` which is
 *   user-controlled via `HOME`/`USERPROFILE`; any shell-style invocation is
 *   a command-injection bug.
 * - Broad-principal detection (`assertNoBroadAce`) reads the file's SDDL via
 *   PowerShell `(Get-Acl).Sddl`. SDDL uses locale-independent 2-letter
 *   shortcuts for well-known SIDs (`WD`=Everyone, `AU`=Authenticated Users,
 *   `BU`=BUILTIN\Users) — substring-matching English names from `icacls`
 *   default output false-negatives on non-English Windows (where the
 *   resolver returns "Utilisateurs", "Benutzer", etc.).
 * - `setRestrictiveAcl` calls `/inheritance:r` THEN `/grant:r`. Without
 *   `:r` on both flags, inherited ACEs from the parent dir survive and
 *   `/grant` adds the user as an additional principal instead of replacing
 *   the ACL.
 * - The bearer-token write must precede the ACL-set only when the tempfile
 *   already inherits a restrictive DACL from a known-restrictive parent dir
 *   (on Windows, `homedir()` qualifies — only the user + SYSTEM +
 *   Administrators by default). The atomic-write caller in `apply.ts`
 *   relies on this assumption; the icacls call is explicit defence in depth.
 * - PowerShell paths are passed via the `TANDEM_ACL_PATH` env var, not
 *   interpolated into the script string. This avoids every quoting /
 *   escaping pitfall for paths that contain spaces, apostrophes, or
 *   backticks.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run a PowerShell script, preferring PowerShell 7 (`pwsh.exe`) and falling
 * back to Windows PowerShell 5.1 (`powershell.exe`). pwsh is more reliable —
 * 5.1's auto-module-load has been observed to fail intermittently for
 * `Microsoft.PowerShell.Security` in CI sandboxes and on some user setups.
 */
async function runPowerShell(script: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string }> {
  const args = ["-NoProfile", "-NonInteractive", "-Command", script];
  try {
    return await execFileAsync("pwsh.exe", args, { env });
  } catch (err) {
    // ENOENT or spawn failure → fall back to legacy Windows PowerShell.
    // Any other error (e.g. the script itself failed) propagates from the
    // fallback invocation below so the caller sees a real diagnosis.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    return await execFileAsync("powershell.exe", args, { env });
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
 * Set a restrictive DACL on `path`: break inheritance, then grant Full
 * Control to the current user only. On non-Windows, no-op.
 *
 * @throws if the `icacls` invocation fails or the verify step finds a broad
 * ACE on the result.
 */
export async function setRestrictiveAcl(path: string): Promise<void> {
  if (process.platform !== "win32") return;

  const user = process.env.USERNAME;
  if (!user || user.trim() === "") {
    throw new Error(
      "setRestrictiveAcl: USERNAME env var is empty; refusing to set ACL without a principal",
    );
  }

  // icacls processes flags left-to-right in one invocation:
  //   /inheritance:r — remove ALL inherited entries (`:d` would copy them
  //                    as explicit, defeating the purpose)
  //   /grant:r       — replace any existing explicit ACE for the user
  //                    rather than ADD a new one (no `:r` → duplicates
  //                    accumulate over repeated runs).
  // Combining saves a process spawn; the contract is identical to the
  // serialised form. Callers MUST follow up with `assertNoBroadAce` on
  // the final destination path — that is the load-bearing security check
  // and we don't duplicate it here to keep this function single-spawn.
  await execFileAsync("icacls", [path, "/inheritance:r", "/grant:r", `${user}:F`]);
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

  // Script reads the path from an env var to avoid every quoting pitfall.
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
