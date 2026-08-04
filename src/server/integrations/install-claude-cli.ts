/**
 * One-click "Install <assistant> CLI" runner — the ONLY module that downloads
 * and executes an official native installer.
 *
 * Originally Claude-only; the Codex twin (`install-codex-cli.ts`) was a
 * copy-paste of this module that had drifted, and has been folded back in.
 * Everything provider-specific lives in {@link CliInstallerSpec} / the
 * {@link CLI_INSTALLERS} table: pinned hosts, install URLs, temp-file prefix,
 * detector, error class, the per-platform env **key list**, and the **base env
 * object** (Claude's installer wants `CI=1`; Codex's wants
 * `CODEX_NON_INTERACTIVE=1`). Everything else below is shared and must stay
 * byte-for-byte equivalent for Claude — this file's hardening is the reason
 * the merge went this direction rather than the other.
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
 *   SystemRoot) plus the provider's non-interactive flag (`CI=1` for Claude)
 *   to suppress interactive prompts.
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

import type { ClaudeCliPresence, CodexCliPresence } from "../../shared/integrations/contract.js";
import {
  type CliProvider,
  detectCodexCli as detectCodexCliDefault,
} from "../../shared/integrations/detect-claude-cli.js";
import {
  assertNoBroadAce as assertNoBroadAceDefault,
  setRestrictiveAcl as setRestrictiveAclDefault,
} from "./acl-win.js";
import { detectClaudeCli as detectClaudeCliDefault } from "./apply.js";

const execFileAsyncDefault = promisify(execFile);

/** Apexes of the pinned installer domains, per provider. */
const CLAUDE_INSTALLER_HOSTS = ["claude.ai"] as const;
const CODEX_INSTALLER_HOSTS = ["chatgpt.com", "openai.com"] as const;

/**
 * Accept a pinned apex AND any subdomain of it. The official Claude installer
 * 302-redirects `https://claude.ai/install.{sh,ps1}` →
 * `https://downloads.claude.ai/claude-code-releases/bootstrap.{sh,ps1}`, so an
 * exact-apex pin would reject the real download host. The leading-dot suffix
 * check means `evilclaude.ai` / `claude.ai.evil.com` do NOT match (the former
 * lacks the `.claude.ai` suffix; the latter's hostname ends in `.evil.com`).
 */
function isPinnedHost(hostname: string, hosts: readonly string[]): boolean {
  return hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}
/** Streamed-byte cap. Aborts mid-response; does not trust Content-Length. */
const MAX_SCRIPT_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
/** Generous — a cold install (download + GPG verify) can take 30–120s. */
const EXEC_TIMEOUT_MS = 180_000;
/**
 * Socket-inactivity timeout for the script fetch. The script is tiny, so 30s
 * is ample. Load-bearing: without it a stalled/withholding peer (claude.ai
 * hiccup, or an in-path adversary trickling bytes under the cap and never
 * sending FIN) leaves the fetch pending forever, which strands the route's
 * install mutex (the `finally` that clears it never runs) → 429 until restart.
 */
const FETCH_TIMEOUT_MS = 30_000;
const STDERR_TAIL_CHARS = 500;
/**
 * execFile stdout+stderr cap. Node's 1 MiB default can ENOBUFS-kill a chatty
 * installer mid-run, surfacing as a misleading `exitCode: null` on a possibly-
 * successful install; 10 MiB matches the script-fetch cap. `CI=1` keeps the
 * official installer quiet, so this is a defensive ceiling, not a routine need.
 */
const EXEC_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** Thrown when the host OS isn't one the native installer supports. */
export class UnsupportedPlatformError extends Error {
  constructor(platform: string, providerLabel = "Claude") {
    super(`${providerLabel} installer does not support platform: ${platform}`);
    this.name = "UnsupportedPlatformError";
  }
}

/**
 * Thrown when an installer exits non-zero or the interpreter fails to spawn.
 * The per-provider subclasses below exist so `instanceof` still discriminates
 * at call sites that care which installer failed; route handlers that don't
 * care catch this base class.
 */
export class CliInstallError extends Error {
  /** Process exit code, or null for spawn failures / timeouts (no exit code). */
  readonly exitCode: number | null;
  /** Last {@link STDERR_TAIL_CHARS} of stderr, temp-path-scrubbed. */
  readonly stderrTail: string;

  constructor(providerLabel: string, exitCode: number | null, stderrTail: string) {
    super(`${providerLabel} installer failed (exit ${exitCode ?? "null"})`);
    this.name = "CliInstallError";
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

export class ClaudeInstallError extends CliInstallError {
  constructor(exitCode: number | null, stderrTail: string) {
    super("Claude", exitCode, stderrTail);
    this.name = "ClaudeInstallError";
  }
}

/** Re-homed from the deleted `install-codex-cli.ts`. */
export class CodexInstallError extends CliInstallError {
  constructor(exitCode: number | null, stderrTail: string) {
    super("Codex", exitCode, stderrTail);
    this.name = "CodexInstallError";
  }
}

export interface FetchInstallerScriptOptions {
  httpsGet?: typeof httpsGetDefault;
  maxRedirects?: number;
  /**
   * Apexes the fetch is pinned to (apex or any subdomain). Defaults to
   * Claude's — the parameter exists so the Codex installer shares this
   * hardened fetch rather than carrying its own copy.
   */
  pinnedHosts?: readonly string[];
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
  const pinnedHosts = opts.pinnedHosts ?? CLAUDE_INSTALLER_HOSTS;

  return new Promise<string>((resolve, reject) => {
    // Per-hop F2 scheme+host gate. The redirect recursion below re-enters this
    // executor, so every hop is re-validated before its own fetch. A `Location:`
    // that downgrades to http: or points off claude.ai is fatal (rejected), not
    // silently corrected.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    if (parsed.protocol !== "https:" || !isPinnedHost(parsed.hostname, pinnedHosts)) {
      reject(
        new Error(
          `Installer URL must be https://(*.){${pinnedHosts.join("|")}}/… — refusing ${parsed.protocol}//${parsed.hostname}`,
        ),
      );
      return;
    }

    // Hand httpsGet a URL rebuilt from a literal `https://` scheme, so the
    // protocol reaching the download sink is a compile-time constant rather
    // than a value derived from the (untrusted) redirect Location header. The
    // host is carried from the just-validated URL (`parsed.host` keeps any
    // explicit port) — it has already passed `isPinnedHost` above. Equivalent
    // to `url` for every accepted request; the explicit reconstruction is what
    // satisfies CodeQL js/insecure-download, which keys on the scheme of the
    // string flowing into the request and does not model the guard above as a
    // protocol barrier.
    const pinnedUrl = `https://${parsed.host}${parsed.pathname}${parsed.search}`;

    const req = httpsGet(pinnedUrl, (res) => {
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
        fetchInstallerScript(next, {
          httpsGet,
          maxRedirects: maxRedirects - 1,
          pinnedHosts,
        }).then(resolve, reject);
        return;
      }

      if (status !== 200) {
        res.resume();
        reject(new Error(`Installer fetch: unexpected status ${status} from ${parsed.hostname}`));
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
    // `destroy(err)` emits 'error', which the listener above turns into a
    // reject — so a hung connection settles the promise instead of stranding it.
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`Installer fetch timed out after ${FETCH_TIMEOUT_MS}ms`));
    });
  });
}

/**
 * Everything that differs between the providers' installers. Adding a provider
 * means adding a row to {@link CLI_INSTALLERS} — never forking this module
 * again.
 */
interface CliInstallerSpec {
  /** Human-readable provider name, used in error messages. */
  label: string;
  /** Apexes the script fetch is pinned to (apex or any subdomain). */
  pinnedHosts: readonly string[];
  urlWin: string;
  urlPosix: string;
  /** `mkdtemp` prefix — distinct per provider so concurrent installs can't collide. */
  tempPrefix: string;
  /** Presence probe, run before (idempotency) and after (result) the install. */
  detect: () => ClaudeCliPresence;
  /**
   * Base env handed to the interpreter, BEFORE the allowlisted keys are copied
   * in. This is the provider's non-interactive flag, and it is deliberately
   * part of the spec rather than hardcoded — Claude's installer keys off `CI`,
   * Codex's off `CODEX_NON_INTERACTIVE`.
   */
  baseEnv: NodeJS.ProcessEnv;
  /**
   * `process.env` keys copied through, per platform. Codex's win32 list must
   * keep `LOCALAPPDATA`: its installer targets
   * `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` and the detector reads the same
   * var, so dropping it makes the closing `detect()` report NOT_INSTALLED
   * after a *successful* install.
   */
  envKeys: { win32: readonly string[]; posix: readonly string[] };
  makeError: (exitCode: number | null, stderrTail: string) => CliInstallError;
}

const CLI_INSTALLERS: Record<CliProvider, CliInstallerSpec> = {
  claude: {
    label: "Claude",
    pinnedHosts: CLAUDE_INSTALLER_HOSTS,
    urlWin: "https://claude.ai/install.ps1",
    urlPosix: "https://claude.ai/install.sh",
    tempPrefix: "tandem-claude-install-",
    detect: () => detectClaudeCliDefault(),
    baseEnv: { CI: "1" },
    envKeys: { win32: ["PATH", "USERPROFILE", "SystemRoot"], posix: ["PATH", "HOME"] },
    makeError: (exitCode, stderrTail) => new ClaudeInstallError(exitCode, stderrTail),
  },
  codex: {
    label: "Codex",
    pinnedHosts: CODEX_INSTALLER_HOSTS,
    urlWin: "https://chatgpt.com/codex/install.ps1",
    urlPosix: "https://chatgpt.com/codex/install.sh",
    tempPrefix: "tandem-codex-install-",
    detect: () => detectCodexCliDefault(),
    baseEnv: { CODEX_NON_INTERACTIVE: "1" },
    envKeys: {
      win32: ["PATH", "HOME", "USERPROFILE", "LOCALAPPDATA", "SystemRoot"],
      posix: ["PATH", "HOME", "USERPROFILE", "LOCALAPPDATA", "SystemRoot"],
    },
    makeError: (exitCode, stderrTail) => new CodexInstallError(exitCode, stderrTail),
  },
};

export interface InstallCliDeps {
  /** Injected so tests assert argv without spawning a real interpreter. */
  execFileAsync?: typeof execFileAsyncDefault;
  /** Injected so tests never hit the real network. */
  fetchScript?: (url: string) => Promise<string>;
  /** Injected so tests don't invoke real icacls/PowerShell on Windows. */
  setRestrictiveAcl?: typeof setRestrictiveAclDefault;
  assertNoBroadAce?: typeof assertNoBroadAceDefault;
}

export interface InstallClaudeCliDeps extends InstallCliDeps {
  detectClaudeCli?: typeof detectClaudeCliDefault;
}

export interface InstallCodexCliDeps extends InstallCliDeps {
  detectCodexCli?: typeof detectCodexCliDefault;
}

interface ExecPlan {
  interpreter: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Copy only the named env vars (if set) on top of the provider's base env. */
function minimalEnv(baseEnv: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function buildExecPlan(spec: CliInstallerSpec, isWin: boolean, scriptPath: string): ExecPlan {
  if (isWin) {
    return {
      interpreter: "pwsh.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      env: minimalEnv(spec.baseEnv, spec.envKeys.win32),
    };
  }
  return {
    interpreter: "/bin/sh",
    args: [scriptPath],
    env: minimalEnv(spec.baseEnv, spec.envKeys.posix),
  };
}

/**
 * `execFile` options shared by both the primary interpreter invocation and the
 * Windows PowerShell 5.1 fallback. `windowsHide` suppresses the PowerShell
 * console window that would otherwise flash on every Windows install — it was
 * present only on the Codex copy before the merge, and applies to both.
 */
function execOptions(env: NodeJS.ProcessEnv) {
  return {
    timeout: EXEC_TIMEOUT_MS,
    env,
    maxBuffer: EXEC_MAX_BUFFER_BYTES,
    windowsHide: true,
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
    await execFileAsync(plan.interpreter, plan.args, execOptions(plan.env));
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
      await execFileAsync(fallback, plan.args, execOptions(plan.env));
      return;
    }
    throw err;
  }
}

/**
 * Map an `execFile` rejection to the provider's install error. The promisified
 * `execFile` attaches `code` (numeric exit code, or a string errno like ENOENT
 * for spawn failures) and `stderr`. The temp dir is scrubbed from the tail in
 * case the script echoed `$0`.
 */
function toInstallError(spec: CliInstallerSpec, err: unknown, tmpDir: string): CliInstallError {
  const e = err as NodeJS.ErrnoException & { stderr?: unknown; code?: unknown };
  const exitCode = typeof e.code === "number" ? e.code : null;
  let stderr = typeof e.stderr === "string" ? e.stderr : (e.message ?? String(err));
  if (tmpDir) stderr = stderr.split(tmpDir).join("<tmp>");
  // Strip ANSI/control bytes BEFORE the tail-slice so the 500-char budget is
  // real text — PowerShell's Write-Error emits SGR color codes that would
  // otherwise render as literal `[31;1m…` junk in the wizard's error banner.
  return spec.makeError(exitCode, sanitizeStderr(stderr).slice(-STDERR_TAIL_CHARS));
}

/**
 * Remove terminal escape sequences (ANSI CSI/SGR, OSC, lone ESC) and leftover
 * C0 control bytes (keeping tab + newline) from interpreter stderr before it's
 * surfaced to the user. The installer runs under real shells whose error output
 * is colorized; the banner shows this as plain text.
 */
function sanitizeStderr(s: string): string {
  const withoutEscapes = s.replace(
    // CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`), or a lone ESC-class byte.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape bytes is the intent
    /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g,
    "",
  );
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping residual control bytes is the intent
  return withoutEscapes.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

/**
 * Download + run a provider's official native installer, returning the
 * re-probed presence on success (usually `INSTALLED_NOT_ON_PATH` — the binary
 * lands in a standalone location off the server's PATH).
 *
 * Idempotent: if the provider's detector already reports the CLI present,
 * returns that presence without touching the network or spawning anything.
 *
 * @throws {UnsupportedPlatformError} on a non win32/darwin/linux host.
 * @throws {CliInstallError} when the installer exits non-zero / fails to spawn.
 */
async function installCli(
  spec: CliInstallerSpec,
  deps: InstallCliDeps & { detect?: () => ClaudeCliPresence } = {},
): Promise<ClaudeCliPresence> {
  const execFileAsync = deps.execFileAsync ?? execFileAsyncDefault;
  const detect = deps.detect ?? spec.detect;
  const fetchScript =
    deps.fetchScript ??
    ((url: string) => fetchInstallerScript(url, { pinnedHosts: spec.pinnedHosts }));
  const lockDirAcl = deps.setRestrictiveAcl ?? setRestrictiveAclDefault;
  const verifyNoBroadAce = deps.assertNoBroadAce ?? assertNoBroadAceDefault;

  const platform = process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new UnsupportedPlatformError(platform, spec.label);
  }

  // Idempotency guard — never reinstall over an existing CLI.
  const before = detect();
  if (before !== "NOT_INSTALLED") return before;

  const isWin = platform === "win32";
  // Map fetch failures (timeout, byte-cap, redirect downgrade, non-200) to a
  // CliInstallError so the client gets an actionable tail instead of an
  // opaque generic 500. These messages are path/secret-free (the temp dir
  // doesn't exist yet). The ACL/prep failures below deliberately do NOT get
  // this treatment — acl-win errors can embed the user's SID/username, which
  // must not reach the response; they stay on the generic sendInternal path.
  let script: string;
  try {
    script = await fetchScript(isWin ? spec.urlWin : spec.urlPosix);
  } catch (err) {
    throw spec.makeError(
      null,
      sanitizeStderr(err instanceof Error ? err.message : String(err)).slice(-STDERR_TAIL_CHARS),
    );
  }

  const tmpDir = await mkdtemp(join(tmpdir(), spec.tempPrefix));
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

    const plan = buildExecPlan(spec, isWin, scriptPath);
    try {
      await runInterpreter(execFileAsync, plan, isWin);
    } catch (err) {
      throw toInstallError(spec, err, tmpDir);
    }

    return detect();
  } finally {
    // Best-effort cleanup. A throw here (Windows EBUSY/EPERM — e.g. AV holding
    // a lock on the just-run install.ps1; `force` only swallows ENOENT) would
    // REPLACE the pending `return detect()` with a raw fs error, mis-reporting
    // a successful install as a 500. The leaked temp dir is harmless (public
    // script, 0700/user-only ACL, OS temp sweep — NOT the annotations-dir
    // reaper, which doesn't sweep this path).
    await rm(tmpDir, { recursive: true, force: true }).catch((err) => {
      console.error(`[Tandem] ${spec.label} install: temp cleanup failed:`, err);
    });
  }
}

/**
 * Download + run the official native Claude Code installer. The binary lands
 * in `~/.local/bin`, off the server's PATH, so the returned presence is
 * usually `INSTALLED_NOT_ON_PATH`.
 *
 * @throws {UnsupportedPlatformError} on a non win32/darwin/linux host.
 * @throws {ClaudeInstallError} when the installer exits non-zero / fails to spawn.
 */
export function installClaudeCli(deps: InstallClaudeCliDeps = {}): Promise<ClaudeCliPresence> {
  return installCli(CLI_INSTALLERS.claude, { ...deps, detect: deps.detectClaudeCli });
}

/**
 * Download + run the official native Codex CLI installer.
 *
 * @throws {UnsupportedPlatformError} on a non win32/darwin/linux host.
 * @throws {CodexInstallError} when the installer exits non-zero / fails to spawn.
 */
export function installCodexCli(deps: InstallCodexCliDeps = {}): Promise<CodexCliPresence> {
  return installCli(CLI_INSTALLERS.codex, { ...deps, detect: deps.detectCodexCli });
}
