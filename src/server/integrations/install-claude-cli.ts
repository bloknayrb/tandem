/**
 * One-click "Install Claude Code" runner — the ONLY module that downloads and
 * executes the official native installer.
 *
 * Security contract (folded in from the security-reviewer pass on the plan):
 * - **Never `| bash` / `| iex`.** That needs `shell: true`, which violates
 *   Tandem's safe-spawn rule. Instead: fetch the pinned HTTPS script with
 *   `node:https` → write it to a locked-down temp file → `execFile` the
 *   interpreter on the *file* (argv-only, no shell, no curl dependency).
 * - **Scheme + host pinned on every redirect hop (F2).** A `Location:` that
 *   downgrades to `http:` or points off `claude.ai` is fatal, not just
 *   un-followed. ≤3 redirects.
 * - **Streamed-byte cap, not Content-Length (F2).** The 10 MiB cap aborts the
 *   response mid-stream; a missing/lying `Content-Length` can't bypass it.
 * - **Minimal allowlisted env (F1).** A `process.env` spread would hand the
 *   wire-fetched script the server's full environment incl. the MCP auth
 *   token, which a hostile/verbose script could echo into `stderrTail`. We
 *   pass only what the installer needs (PATH/HOME or PATH/USERPROFILE/
 *   SystemRoot) plus `CI=1` to suppress interactive prompts.
 * - **TOCTOU-locked temp file (S2/F3).** POSIX: `mkdtemp` (0700) + write 0600.
 *   Windows: `0o600` is a no-op, so lock the *directory* ACL + self-verify
 *   BEFORE writing the `.ps1`, then re-verify the *file* too (acl-win doctrine:
 *   icacls exits 0 on partial failure, so the SDDL re-read is the only
 *   trustworthy signal).
 * - **Honest failure surfacing.** Non-zero exit → `ClaudeInstallError` with the
 *   real exit code + a stderr tail. `stderrTail` is the ONE intentional
 *   exception to the codebase's no-detail-in-response convention (justified by
 *   honest-failure-surfacing); the temp path is scrubbed from it and never
 *   leaked. The exit-0-but-not-on-PATH case is a *successful* outcome
 *   (`INSTALLED_NOT_ON_PATH`), not an error.
 * - **TLS-only trust is acceptable (S1).** Integrity = claude.ai TLS + the
 *   script's own GPG-verify of the binary it fetches. We do NOT cert-pin
 *   (rotation would break installs) and do NOT GPG-verify the script (there's
 *   no detached script signature; the payload it fetches is already signed).
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { get as httpsGetDefault } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ClaudeCliPresence } from "../../shared/integrations/contract.js";
import {
  assertNoBroadAce as assertNoBroadAceDefault,
  setRestrictiveAcl as setRestrictiveAclDefault,
} from "./acl-win.js";
import { detectClaudeCli as detectClaudeCliDefault } from "./apply.js";

const execFileAsyncDefault = promisify(execFile);

const INSTALLER_HOST = "claude.ai";
const INSTALLER_URL_POSIX = "https://claude.ai/install.sh";
const INSTALLER_URL_WIN = "https://claude.ai/install.ps1";
/** Streamed-byte cap. Aborts mid-response; does not trust Content-Length. */
const MAX_SCRIPT_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
/** Generous — a cold install (download + GPG verify) can take 30–120s. */
const EXEC_TIMEOUT_MS = 180_000;
const STDERR_TAIL_CHARS = 500;

/** Thrown when the host OS isn't one the native installer supports. */
export class UnsupportedPlatformError extends Error {
  constructor(platform: string) {
    super(`Claude installer does not support platform: ${platform}`);
    this.name = "UnsupportedPlatformError";
  }
}

/** Thrown when the installer exits non-zero or the interpreter fails to spawn. */
export class ClaudeInstallError extends Error {
  /** Process exit code, or null for spawn failures / timeouts (no exit code). */
  readonly exitCode: number | null;
  /** Last {@link STDERR_TAIL_CHARS} of stderr, temp-path-scrubbed. */
  readonly stderrTail: string;

  constructor(exitCode: number | null, stderrTail: string) {
    super(`Claude installer failed (exit ${exitCode ?? "null"})`);
    this.name = "ClaudeInstallError";
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

/** `new URL().protocol` keeps the trailing colon. */
function assertPinnedUrl(raw: string): void {
  const u = new URL(raw);
  if (u.protocol !== "https:" || u.hostname !== INSTALLER_HOST) {
    throw new Error(
      `Installer URL must be https://${INSTALLER_HOST}/… — refusing ${u.protocol}//${u.hostname}`,
    );
  }
}

export interface FetchInstallerScriptOptions {
  httpsGet?: typeof httpsGetDefault;
  maxRedirects?: number;
}

/**
 * Fetch the installer script over HTTPS, following ≤`maxRedirects` redirects,
 * re-pinning scheme+host on every hop, and aborting if the streamed body
 * exceeds {@link MAX_SCRIPT_BYTES}. Exported separately so the scheme-pin /
 * cap logic is unit-testable with an injected `httpsGet`.
 */
export function fetchInstallerScript(
  url: string,
  opts: FetchInstallerScriptOptions = {},
): Promise<string> {
  const httpsGet = opts.httpsGet ?? httpsGetDefault;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;

  return new Promise<string>((resolve, reject) => {
    // Throwing here (sync, inside the executor) rejects the promise — this is
    // the per-hop F2 scheme+host gate; recursion re-enters through this path.
    assertPinnedUrl(url);

    const req = httpsGet(url, (res) => {
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400) {
        res.resume(); // drain so the socket is freed
        const location = res.headers.location;
        if (!location) {
          reject(new Error(`Installer fetch: ${status} redirect with no Location header`));
          return;
        }
        if (maxRedirects <= 0) {
          reject(new Error(`Installer fetch: exceeded redirect limit at ${url}`));
          return;
        }
        let next: string;
        try {
          next = new URL(location, url).toString();
        } catch (err) {
          reject(err);
          return;
        }
        fetchInstallerScript(next, { httpsGet, maxRedirects: maxRedirects - 1 }).then(
          resolve,
          reject,
        );
        return;
      }

      if (status !== 200) {
        res.resume();
        reject(new Error(`Installer fetch: unexpected status ${status} from ${INSTALLER_HOST}`));
        return;
      }

      let bytes = 0;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_SCRIPT_BYTES) {
          req.destroy();
          res.destroy();
          reject(new Error(`Installer script exceeded ${MAX_SCRIPT_BYTES}-byte cap`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

export interface InstallClaudeCliDeps {
  /** Injected so tests assert argv without spawning a real interpreter. */
  execFileAsync?: typeof execFileAsyncDefault;
  detectClaudeCli?: typeof detectClaudeCliDefault;
  /** Injected so tests never hit the real network. */
  fetchScript?: (url: string) => Promise<string>;
  /** Injected so tests don't invoke real icacls/PowerShell on Windows. */
  setRestrictiveAcl?: typeof setRestrictiveAclDefault;
  assertNoBroadAce?: typeof assertNoBroadAceDefault;
}

interface ExecPlan {
  interpreter: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Copy only the named env vars (if set), always adding `CI=1`. */
function minimalEnv(keys: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: "1" };
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function buildExecPlan(isWin: boolean, scriptPath: string): ExecPlan {
  if (isWin) {
    return {
      interpreter: "pwsh.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      env: minimalEnv(["PATH", "USERPROFILE", "SystemRoot"]),
    };
  }
  return {
    interpreter: "/bin/sh",
    args: [scriptPath],
    env: minimalEnv(["PATH", "HOME"]),
  };
}

/**
 * Run the interpreter with NO shell. On Windows, fall back from `pwsh.exe` to
 * the absolute Windows PowerShell 5.1 path on ENOENT only (a missing pwsh, not
 * an AppLocker EACCES/EPERM denial — routing around a policy block is the wrong
 * posture). The args are identical for both.
 */
async function runInterpreter(
  execFileAsync: typeof execFileAsyncDefault,
  plan: ExecPlan,
  isWin: boolean,
): Promise<void> {
  try {
    await execFileAsync(plan.interpreter, plan.args, {
      timeout: EXEC_TIMEOUT_MS,
      env: plan.env,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (isWin && code === "ENOENT" && plan.interpreter === "pwsh.exe") {
      const fallback = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      await execFileAsync(fallback, plan.args, { timeout: EXEC_TIMEOUT_MS, env: plan.env });
      return;
    }
    throw err;
  }
}

/**
 * Map an `execFile` rejection to a `ClaudeInstallError`. The promisified
 * `execFile` attaches `code` (numeric exit code, or a string errno like ENOENT
 * for spawn failures) and `stderr`. The temp dir is scrubbed from the tail in
 * case the script echoed `$0`.
 */
function toClaudeInstallError(err: unknown, tmpDir: string): ClaudeInstallError {
  const e = err as NodeJS.ErrnoException & { stderr?: unknown; code?: unknown };
  const exitCode = typeof e.code === "number" ? e.code : null;
  let stderr = typeof e.stderr === "string" ? e.stderr : (e.message ?? String(err));
  if (tmpDir) stderr = stderr.split(tmpDir).join("<tmp>");
  return new ClaudeInstallError(exitCode, stderr.slice(-STDERR_TAIL_CHARS));
}

/**
 * Download + run the official native Claude Code installer, returning the
 * re-probed {@link ClaudeCliPresence} on success (usually
 * `INSTALLED_NOT_ON_PATH` — the binary lands in `~/.local/bin`, off the
 * server's PATH).
 *
 * Idempotent: if `detectClaudeCli()` already reports the CLI present, returns
 * that presence without touching the network or spawning anything.
 *
 * @throws {UnsupportedPlatformError} on a non win32/darwin/linux host.
 * @throws {ClaudeInstallError} when the installer exits non-zero / fails to spawn.
 */
export async function installClaudeCli(
  deps: InstallClaudeCliDeps = {},
): Promise<ClaudeCliPresence> {
  const execFileAsync = deps.execFileAsync ?? execFileAsyncDefault;
  const detect = deps.detectClaudeCli ?? detectClaudeCliDefault;
  const fetchScript = deps.fetchScript ?? ((url: string) => fetchInstallerScript(url));
  const lockDirAcl = deps.setRestrictiveAcl ?? setRestrictiveAclDefault;
  const verifyNoBroadAce = deps.assertNoBroadAce ?? assertNoBroadAceDefault;

  const platform = process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new UnsupportedPlatformError(platform);
  }

  // Idempotency guard — never reinstall over an existing CLI.
  const before = detect();
  if (before !== "NOT_INSTALLED") return before;

  const isWin = platform === "win32";
  const script = await fetchScript(isWin ? INSTALLER_URL_WIN : INSTALLER_URL_POSIX);

  const tmpDir = await mkdtemp(join(tmpdir(), "tandem-claude-install-"));
  try {
    const scriptPath = join(tmpDir, isWin ? "install.ps1" : "install.sh");

    if (isWin) {
      // 0o600 write-mode is a no-op on Windows. Lock the DIRECTORY ACL and
      // self-verify it FIRST, then write the .ps1 inside (it inherits the
      // restrictive ACL from birth — write→exec window is zero, F3). Then
      // re-verify the FILE: inheritance is the expectation, but acl-win's
      // doctrine is that the SDDL re-read is the only trustworthy signal.
      await lockDirAcl(tmpDir);
      await verifyNoBroadAce(tmpDir);
      await writeFile(scriptPath, script, { encoding: "utf8" });
      await verifyNoBroadAce(scriptPath);
    } else {
      // mkdtemp created the dir 0700; the file is 0600 from birth.
      await writeFile(scriptPath, script, { encoding: "utf8", mode: 0o600 });
    }

    const plan = buildExecPlan(isWin, scriptPath);
    try {
      await runInterpreter(execFileAsync, plan, isWin);
    } catch (err) {
      throw toClaudeInstallError(err, tmpDir);
    }

    return detect();
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
