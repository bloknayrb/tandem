/**
 * Library helpers for applying Tandem's MCP entries to a Claude (or other
 * MCP-capable) client's config file. Shared by the wizard's apply route,
 * `tandem setup`, and `tandem rotate-token`.
 *
 * Hardening invariants enforced here (callers MUST NOT bypass):
 * - `assertPathSafe()` rejects symlinks and any path whose realpath falls
 *   outside `[homedir(), tmpdir()]`. Prevents a compromised account from
 *   replacing `~/.claude.json` with a symlink to `/etc/shadow` or a
 *   Windows junction redirecting `~/.claude` into a protected dir.
 * - MSIX detection is anchored to `/^Claude_[A-Za-z0-9]+$/` and the
 *   `%LOCALAPPDATA%` realpath must resolve under home (defeats an
 *   attacker who controls env).
 * - Malformed JSON backups land in `${appDataDir}/.broken-backups/` at
 *   `0o600` rather than next to `~/.claude.json` (which may inherit
 *   world-readable perms and would leak co-tenant API keys).
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { SKILL_CONTENT } from "../../cli/skill-content.js";
import { DEFAULT_MCP_PORT } from "../../shared/constants.js";
import type { ClaudeCliPresence } from "../../shared/integrations/contract.js";
import { resolveAppDataDir } from "../platform.js";
import { setRestrictiveAcl } from "./acl-win.js";
import { backupDir, pruneOldBackups, shouldBackup, writeBackup } from "./backup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Paths are anchored to the package root. The CLI bundle (`dist/cli/`) and
// the server bundle (`dist/server/`) both sit one level below `dist/`, so
// `../..` resolves to the package root in either bundle. In tsx dev,
// `__dirname` is `src/server/integrations/`, so we need `../../..`.
const PACKAGE_ROOT = (() => {
  const fromBundle = resolve(__dirname, "../..");
  if (existsSync(join(fromBundle, "package.json"))) return fromBundle;
  return resolve(__dirname, "../../..");
})();
/**
 * Resolve the bundled channel-shim entry registered as Claude Code's push
 * transport.
 *
 * On a Tauri **desktop bundle** the `PACKAGE_ROOT` derivation above points at
 * the sidecar's own location, NOT the app's resource dir where `dist/channel/`
 * is bundled — so the computed path doesn't exist and `shouldRegisterChannelShim`
 * skips registration. The Tauri shell injects `TANDEM_CHANNEL_DIST` with the
 * resource-dir-resolved path on sidecar spawn (`src-tauri/src/lib.rs`); prefer
 * it when it points at an existing file. A bogus/missing injected path is
 * ignored so a broken injection degrades to the computed path rather than
 * registering an unresolvable MCP command. In npm-global / tsx-dev there is no
 * env var and the `PACKAGE_ROOT` derivation is correct.
 *
 * This replaces the old `/api/setup` startup round-trip, which used to be the
 * only path carrying the Tauri-resolved channel path (#477 PR 3c-ii-c).
 *
 * No UNC/traversal validation is applied to the injected path because the sole
 * setter is `resolve_channel_dist()` in `src-tauri/src/lib.rs` — trusted
 * same-user Rust code that emits `resource_dir/dist/channel/index.js` or
 * `cwd/dist/channel/index.js`. The path cannot arrive via any HTTP route.
 *
 * Exported (with `exists` injectable) so the env-precedence can be unit-tested
 * without re-importing the module to re-run the const initializer.
 */
export function resolveChannelDist(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): string {
  const injected = env.TANDEM_CHANNEL_DIST;
  if (injected) {
    if (exists(injected)) return injected;
    // Set-but-missing: a broken desktop injection would otherwise degrade push
    // → polling with no trace. Behavior is unchanged (we still fall back); this
    // only leaves a diagnostic breadcrumb on stderr (Critical Rule #3-safe).
    console.error(
      `[Tandem] TANDEM_CHANNEL_DIST set to "${injected}" but no file there — ` +
        "falling back to bundled path; real-time push may be unavailable.",
    );
  }
  return resolve(PACKAGE_ROOT, "dist/channel/index.js");
}

const CHANNEL_DIST = resolveChannelDist();

const MCP_URL = `http://127.0.0.1:${DEFAULT_MCP_PORT}`;

// Injected by tsup at build time. apply.ts is bundled into BOTH `dist/cli`
// (carries `__TANDEM_VERSION__`) and `dist/server` (carries `__APP_VERSION__`),
// and neither define exists in both bundles. esbuild leaves a *bare* reference
// to an absent define as a free global → runtime ReferenceError (no build
// error), so each MUST be `typeof`-guarded — mirroring `APP_VERSION` in
// `src/server/mcp/server.ts`. The disk fallback only runs in tsx dev / vitest,
// where `__dirname` (src/server/integrations) resolves the repo-root
// package.json via the same two candidates server.ts uses.
declare const __TANDEM_VERSION__: string;
declare const __APP_VERSION__: string;
export function resolveCliVersion(): string {
  if (typeof __TANDEM_VERSION__ !== "undefined") return __TANDEM_VERSION__;
  if (typeof __APP_VERSION__ !== "undefined") return __APP_VERSION__;
  for (const rel of ["../../package.json", "../../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(__dirname, rel), "utf8")) as { version: string };
      if (pkg.version) return pkg.version;
    } catch {
      // try next candidate
    }
  }
  console.error("[Tandem] Could not resolve CLI version for npx pin; using unpinned fallback");
  return "0.0.0-unknown";
}

// Pinning the npx spec to an exact version forces `npm exec` to fetch/run the
// correct published `tandem-editor` instead of reusing whatever (possibly
// stale, pre-`mcp-stdio`) global copy is installed — the root cause of the
// "Server disconnected"/"Could not attach" failure. See the plan/ADR notes.
const CLI_VERSION = resolveCliVersion();

/**
 * Refuse to read a config larger than 5 MiB. The realistic `.claude.json` is
 * single-digit kilobytes; anything beyond that is either accidental corruption
 * (log files dropped in) or a deliberate DoS aimed at making the wizard's
 * read-parse-rewrite path exhaust memory. The cap is generous enough that no
 * legitimate user hits it.
 */
const MAX_CONFIG_BYTES = 5 * 1024 * 1024;

export interface McpEntry {
  type?: "http";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface McpEntries {
  tandem: McpEntry;
  "tandem-channel"?: McpEntry;
}

/** MCP entry keys Tandem owns and may remove from an existing config. */
export type RemovableEntry = "tandem" | "tandem-channel";

/**
 * Explicit apply intent. Callers state both `create` and `remove` so
 * absence of a key never implies removal — that distinction matters when
 * the wizard's user-confirmed diff differs from CLI's stale-cleanup
 * default. `applyOpsForCli` builds the CLI-shaped value.
 */
export interface ApplyOps {
  /** Entries to create or update in `mcpServers`. */
  create: McpEntries;
  /** Entries to remove if present in `mcpServers`. */
  remove: RemovableEntry[];
  /**
   * Optional callback invoked with the backup path when `applyConfig`
   * preserves a non-default existing `mcpServers.tandem` entry before
   * overwriting it. CLI callers pass a `console.error` printer; the
   * wizard pushes the path onto its structured apply response so the
   * user sees a recovery hint. Callback is NOT invoked on fresh-install
   * or pure token-rotation runs (those don't trigger a backup).
   */
  onBackup?: (backupPath: string) => void;
}

/**
 * Construct `ApplyOps` with the legacy "remove tandem-channel unless using
 * the shim" semantics. CLI callers (`tandem setup`, `tandem rotate-token`)
 * use this to preserve back-compat without re-implementing the diff. The
 * wizard never calls this — it builds `ApplyOps` from the user's diff
 * confirmation.
 *
 * Options object intentional: the boolean-flag `withChannelShim` is the
 * only state, but exposing it as a named field at every call site avoids
 * the boolean-trap antipattern (the previous positional signature read as
 * `applyOpsForCli(entries, true)` with no clue what the boolean meant).
 */
export function applyOpsForCli(create: McpEntries, opts: { withChannelShim: boolean }): ApplyOps {
  return {
    create,
    remove: opts.withChannelShim ? [] : ["tandem-channel"],
  };
}

/** Error thrown when a target path fails realpath/symlink validation. */
export class PathRejectedError extends Error {
  override readonly name = "PathRejectedError";
  constructor(
    public readonly path: string,
    public readonly reason: "symlink" | "outside-home" | "unreadable",
    message: string,
  ) {
    super(message);
  }
}

export interface BuildMcpEntriesOptions {
  /** Include the stdio channel shim. This raw option defaults to false, but
   *  `shouldIncludeChannelShim` turns it ON by default for the Claude Code
   *  target — the shim is the default push transport. The plugin monitor is an
   *  independent push path (activates on Claude Code 2.1.212+, no flag); the
   *  channel shim stays canonical by decision (2026-07-19), the monitor
   *  installable but not the default. */
  withChannelShim?: boolean;
  nodeBinary?: string;
  /** Auth token to embed in HTTP entry headers and stdio shim env.
   *  When omitted (first-run before token provisioned), headers/env are omitted
   *  and backward compatibility is preserved. */
  token?: string;
  /** Target kind controls entry shape. Claude Code uses HTTP (direct);
   *  Claude Desktop uses stdio (npx bridge) because Cowork sessions can
   *  only surface stdio MCP servers. */
  targetKind?: TargetKind;
}

export function buildMcpEntries(
  channelPath: string,
  opts: BuildMcpEntriesOptions = {},
): McpEntries {
  const isDesktop = opts.targetKind === "claude-desktop";

  let tandemEntry: McpEntry;
  if (isDesktop) {
    const env: Record<string, string> = { TANDEM_URL: MCP_URL };
    if (opts.token) {
      env.TANDEM_AUTH_TOKEN = opts.token;
    }
    tandemEntry = {
      command: "npx",
      args: ["-y", `tandem-editor@${CLI_VERSION}`, "mcp-stdio"],
      env,
    };
  } else {
    tandemEntry = { type: "http", url: `${MCP_URL}/mcp` };
    if (opts.token) {
      tandemEntry.headers = { Authorization: `Bearer ${opts.token}` };
    }
  }
  const entries: McpEntries = { tandem: tandemEntry };

  if (opts.withChannelShim) {
    const shimEnv: Record<string, string> = { TANDEM_URL: MCP_URL };
    if (opts.token) {
      shimEnv.TANDEM_AUTH_TOKEN = opts.token;
    }
    entries["tandem-channel"] = {
      command: opts.nodeBinary ?? "node",
      args: [channelPath],
      env: shimEnv,
    };
  }
  return entries;
}

export type TargetKind = "claude-code" | "claude-desktop";

export interface DetectedTarget {
  label: string;
  configPath: string;
  kind: TargetKind;
}

// Realpath of OS roots changes only across process restart (and tmpdir is
// stable for test fixtures). Memoize so per-integration apply loops and
// MSIX detection don't re-syscall for every call.
//
// Lifetime: process. Tandem doesn't drop privileges and never mutates HOME
// mid-process; if a future caller does either, the cache is stale and must
// be invalidated.
const DEFAULT_ROOTS_CACHE = new Map<string, string>();
function realpathCached(p: string): string {
  const cached = DEFAULT_ROOTS_CACHE.get(p);
  if (cached !== undefined) return cached;
  try {
    const r = realpathSync(p);
    DEFAULT_ROOTS_CACHE.set(p, r);
    return r;
  } catch {
    return p;
  }
}

/**
 * Verify the target directory (a) is not a symlink/junction and (b) its
 * realpath resolves under one of the allowed roots. Throws
 * `PathRejectedError` otherwise.
 *
 * Threat model: prior compromised account replaces `~/.claude.json` with a
 * symlink to `/etc/shadow`; on Windows, a junction at `~/.claude`
 * redirecting to `C:\Windows\System32\config\` could let `mkdir(...
 * recursive)` walk into a protected dir. We reject both cases before any
 * read or write. The ancestor check is the closed-set boundary — any path
 * outside the allowed roots is refused even if it's not a symlink.
 *
 * Residual TOCTOU: the lstat-then-write window admits a same-uid attacker
 * who swaps a regular file for a symlink between check and write. Node's
 * `fs` doesn't expose `O_NOFOLLOW` / `openat`-style per-component
 * traversal, so the window is unavoidable without native bindings. The
 * realpath check shrinks the practical attack but doesn't close it.
 *
 * Defaults to `[homedir(), tmpdir()]`. Callers may nominate alternate
 * roots (e.g., test fixtures that operate inside a specific tmpdir).
 */
export function assertPathSafe(targetPath: string, opts: { allowedRoots?: string[] } = {}): void {
  const allowedRoots = (opts.allowedRoots ?? [homedir(), tmpdir()]).map(realpathCached);

  // `lstat` a path that may not exist yet (e.g., apply will create the
  // parent dir). Walk up until we find an existing ancestor and validate
  // there — if any walked-through component is a symlink, fail.
  let cursor = targetPath;
  let existing: string | null = null;
  while (true) {
    if (existsSync(cursor)) {
      const st = lstatSync(cursor);
      if (st.isSymbolicLink()) {
        throw new PathRejectedError(
          targetPath,
          "symlink",
          `Refusing to operate on symlinked path: ${cursor}`,
        );
      }
      existing = cursor;
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break; // reached filesystem root
    cursor = parent;
  }

  const resolved = existing ? realpathSync(existing) : targetPath;
  const ok = allowedRoots.some((root) => {
    if (resolved === root) return true;
    const normRoot = root.endsWith(sep) ? root : `${root}${sep}`;
    return resolved.startsWith(normRoot);
  });
  if (!ok) {
    throw new PathRejectedError(
      targetPath,
      "outside-home",
      `Refusing path outside allowed roots: realpath=${resolved}`,
    );
  }
}

/** MSIX package families that match Claude's installer. Anchored on both ends. */
export const MSIX_PACKAGE_PATTERN = /^Claude_[A-Za-z0-9]+$/;

export interface DetectOptions {
  homeOverride?: string;
  localAppDataOverride?: string;
  force?: boolean;
}

export function detectTargets(opts: DetectOptions = {}): DetectedTarget[] {
  const home = opts.homeOverride ?? homedir();
  const targets: DetectedTarget[] = [];

  // Claude Code — cross-platform.
  // MCP servers are configured in ~/.claude.json under the "mcpServers" key.
  // Detect if the file exists OR if ~/.claude directory exists (Claude Code is installed).
  // With --force, always include regardless.
  const claudeCodeConfig = join(home, ".claude.json");
  const claudeCodeDir = join(home, ".claude");
  if (opts.force || existsSync(claudeCodeConfig) || existsSync(claudeCodeDir)) {
    targets.push({ label: "Claude Code", configPath: claudeCodeConfig, kind: "claude-code" });
  }

  // Claude Desktop — platform-specific.
  // Only detect if the config file already exists (user has launched Desktop at least once).
  // With --force, always include.
  let desktopConfig: string | null = null;
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    desktopConfig = join(appdata, "Claude", "claude_desktop_config.json");
  } else if (process.platform === "darwin") {
    desktopConfig = join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  } else {
    desktopConfig = join(home, ".config", "claude", "claude_desktop_config.json");
  }

  if (desktopConfig && (opts.force || existsSync(desktopConfig))) {
    targets.push({ label: "Claude Desktop", configPath: desktopConfig, kind: "claude-desktop" });
  }

  // Claude Desktop (MSIX) — Windows only.
  // MSIX-packaged installs (Microsoft Store) redirect %APPDATA% to a per-package
  // LocalCache dir. The config lives under %LOCALAPPDATA%\Packages\Claude_*\
  // LocalCache\Roaming\Claude\. Multiple package families may exist.
  // Package name is constrained to `Claude_[A-Za-z0-9]+` so an attacker can't
  // smuggle a write target through a hand-crafted package directory like
  // `Claude_../../Windows/System32` (the path constructor would reject such
  // a name on most platforms but we belt-and-suspender).
  if (process.platform === "win32") {
    const localAppData =
      opts.localAppDataOverride ?? process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    // Verify LOCALAPPDATA resolves under home. An attacker who controls env
    // could otherwise redirect us to write under any directory.
    try {
      assertPathSafe(localAppData, { allowedRoots: [home] });
    } catch {
      return targets;
    }
    const packagesDir = join(localAppData, "Packages");
    try {
      const entries = readdirSync(packagesDir);
      const matching = entries.filter((n) => MSIX_PACKAGE_PATTERN.test(n));
      for (const pkg of matching) {
        const msixConfig = join(
          packagesDir,
          pkg,
          "LocalCache",
          "Roaming",
          "Claude",
          "claude_desktop_config.json",
        );
        if (opts.force || existsSync(msixConfig)) {
          const suffix = matching.length > 1 ? ` (${pkg.slice(0, 12)}…)` : "";
          targets.push({
            label: `Claude Desktop MSIX${suffix}`,
            configPath: msixConfig,
            kind: "claude-desktop",
          });
        }
      }
    } catch {
      // %LOCALAPPDATA%\Packages doesn't exist or isn't readable — not an MSIX install
    }
  }

  return targets;
}

export interface DetectClaudeCliOptions {
  /** Override `homedir()` — tests anchor the native-location probe under a tmpdir. */
  homeOverride?: string;
  /** Override `process.env.PATH` — tests inject a controlled PATH. */
  pathOverride?: string;
  /** Override `process.platform` — tests exercise the win32 `.exe` branch. */
  platformOverride?: NodeJS.Platform;
}

/**
 * Probe whether the `claude` CLI binary is present, independent of any config
 * file. This is the **binary** detector; {@link detectTargets} is the separate
 * **config-presence** detector (it answers "has Claude ever written a config
 * here?", which stays true after an uninstall and is true on a machine that
 * only has Claude Desktop).
 *
 * Pure filesystem probe — deliberately no `execFile`/spawn (no shell-injection
 * surface, no hang on a wedged binary). Returns:
 *   - `INSTALLED_ON_PATH` — `claude[.exe]` found on the server process's PATH.
 *   - `INSTALLED_NOT_ON_PATH` — found only in `~/.local/bin` (the native
 *     installer's target, which is typically NOT on the server's PATH at
 *     install time → the usual immediately-post-install state).
 *   - `NOT_INSTALLED` — neither.
 *
 * PATH wins over `~/.local/bin`: if it's on PATH it's usable right now, which
 * is the more useful signal for the wizard.
 */
export function detectClaudeCli(opts: DetectClaudeCliOptions = {}): ClaudeCliPresence {
  const platform = opts.platformOverride ?? process.platform;
  const home = opts.homeOverride ?? homedir();
  const binName = platform === "win32" ? "claude.exe" : "claude";

  // `delimiter` is platform-specific (`;` on win32, `:` elsewhere). When a
  // platformOverride disagrees with the host, the override is for test
  // ergonomics only — real callers never pass it, so host `delimiter` is fine.
  const pathVar = opts.pathOverride ?? process.env.PATH ?? "";
  for (const dir of pathVar.split(delimiter)) {
    if (dir.length === 0) continue;
    if (existsSync(join(dir, binName))) return "INSTALLED_ON_PATH";
  }

  // Native install location — same `~/.local/bin` on every platform per the
  // official installer's documented uninstall paths (Windows included).
  if (existsSync(join(home, ".local", "bin", binName))) return "INSTALLED_NOT_ON_PATH";

  return "NOT_INSTALLED";
}

/**
 * Atomic write: write to a temp file in the SAME directory as the destination,
 * tighten its mode/DACL, then rename. Same-directory tempfile avoids EXDEV
 * errors when `%TEMP%` and `%APPDATA%` are on different drives.
 *
 * Sequence (security-load-bearing):
 * 1. Write tempfile. On Windows the tempfile inherits its parent dir's
 *    DACL (`homedir()` is OS-restricted by default to user + SYSTEM +
 *    Administrators); on POSIX it lands at `0o666 & ~umask` (typically
 *    `0o644` — world-readable, hence step 2's chmod).
 * 2. Tighten on the tempfile:
 *    - Windows: `setRestrictiveAcl` breaks inheritance and grants Full
 *      Control to the current user's SID only, then self-verifies via
 *      SDDL read. The verify is load-bearing — icacls exits 0 even when
 *      "Failed processing N files".
 *    - POSIX: `chmod(tmp, 0o600)` — user-only read/write.
 * 3. Rename tempfile to dest. The kernel preserves mode (POSIX) and DACL
 *    (Windows `MoveFileEx`) across the rename, so the tightened
 *    permissions survive into the destination.
 * 4. On cleanup failure after a write/ACL/rename error, the original
 *    failure propagates with the cleanup error attached via `cause` so
 *    operators can diagnose a leaked tempfile or dest from a single log
 *    line rather than chasing a stray `console.error`.
 */
async function atomicWrite(content: string, dest: string): Promise<void> {
  const tmp = join(dirname(dest), `.tandem-setup-${randomUUID()}.tmp`);
  // mode at create, not chmod-after: on POSIX a plain writeFile lands at
  // 0o666 & ~umask, leaving sibling vendors' tokens world-readable until the
  // tighten below. Windows ignores mode (the ACL step is the protection).
  await writeFile(tmp, content, { encoding: "utf-8", mode: 0o600 });

  try {
    if (process.platform === "win32") {
      await setRestrictiveAcl(tmp);
    } else {
      await chmod(tmp, 0o600);
    }
  } catch (tightenErr) {
    await unlinkOrLeak(tmp, tightenErr);
    throw tightenErr;
  }

  try {
    await rename(tmp, dest);
  } catch (err) {
    // EXDEV: cross-device link — fall back to copy + delete. The copy
    // preserves the source mode on POSIX (file is created via copyFile's
    // default which honors the source's mode bits); on Windows the
    // destination DACL is recomputed from the dest dir, so we re-run
    // setRestrictiveAcl on the dest after the cross-device copy.
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      await copyFile(tmp, dest);
      await unlinkOrLeak(tmp, err);
      if (process.platform === "win32") await setRestrictiveAcl(dest);
      else await chmod(dest, 0o600);
    } else {
      await unlinkOrLeak(tmp, err);
      throw err;
    }
  }
}

/**
 * Attempt to delete `path` after a write/ACL/rename failure. On cleanup
 * success we just return; on cleanup failure we attach the cleanup error
 * as `cause` to the original failure (mutating `originalErr`) so operators
 * see a single composite log line rather than a free-floating
 * `console.error`. Bearer-token-bearing files that fail cleanup MUST be
 * surfaced, not silently logged.
 */
async function unlinkOrLeak(path: string, originalErr: unknown): Promise<void> {
  try {
    await unlink(path);
  } catch (cleanupErr) {
    if (originalErr instanceof Error && originalErr.cause === undefined) {
      (originalErr as { cause?: unknown }).cause = cleanupErr;
    }
    console.error(
      `  Warning: could not remove ${path} after a previous failure: ${
        (cleanupErr as Error).message
      }`,
    );
  }
}

/**
 * Apply explicit create/remove operations to a Claude config file.
 *
 * **Security gates (run before any read or write):**
 * - `assertPathSafe(configPath)` — symlink / outside-home rejection.
 * - Malformed JSON is backed up under Tandem's data dir with mode `0o600`
 *   (avoids leaking other vendors' API keys via a world-readable
 *   `~/.claude.json.broken-<ts>` sibling).
 *
 * `applyConfig` writes both `ops.create` entries (merging into the existing
 * `mcpServers` object) and removes any key listed in `ops.remove`. Removal
 * is silent if the key was already absent. Callers state both intents
 * explicitly — no implicit "absent key implies remove".
 */
export async function applyConfig(configPath: string, ops: ApplyOps): Promise<void> {
  // Security gate: refuse symlinks, refuse paths outside home/tmpdir.
  assertPathSafe(configPath);

  // Size guard runs before any read — fail closed on oversized files. ENOENT
  // falls through so fresh-install (no .claude.json yet) stays the common path.
  try {
    const { size } = statSync(configPath);
    if (size > MAX_CONFIG_BYTES) {
      throw new Error(
        `${configPath} is ${size} bytes; refusing to read (cap: ${MAX_CONFIG_BYTES}).`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  // Read existing config or start fresh — no existsSync guard needed.
  // ENOENT and malformed JSON start fresh; other errors (permissions, disk) propagate.
  let existing: { mcpServers?: Record<string, McpEntry> } = {};
  try {
    // Strip a leading UTF-8 BOM (`﻿`) before JSON.parse. Some editors
    // (legacy Windows tooling, certain VS Code configs) write `.claude.json`
    // with a BOM; without this strip, `JSON.parse` throws `SyntaxError`
    // and the file would be pushed into `.broken-backups/` as if it were
    // malformed. The BOM is encoded as the literal three bytes
    // `EF BB BF` which Node's "utf-8" decoder surfaces as a leading
    // U+FEFF code point.
    let raw = readFileSync(configPath, "utf-8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const parsed: unknown = JSON.parse(raw);

    // Shape gate: the rewrite path spreads `existing.mcpServers` and
    // `existing` itself into the new config. If either is the wrong
    // shape, the spread produces a corrupted output (string-spread
    // yields `{0:'a',1:'b',...}`, array-spread yields numeric keys,
    // null-spread throws). Reject up-front so a legitimate-looking
    // config-shape mismatch never silently corrupts the user's file.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${configPath} root is not a JSON object — refusing to rewrite`);
    }
    const maybeServers = (parsed as Record<string, unknown>).mcpServers;
    if (
      maybeServers !== undefined &&
      (maybeServers === null || typeof maybeServers !== "object" || Array.isArray(maybeServers))
    ) {
      throw new Error(`${configPath} mcpServers is not an object — refusing to rewrite`);
    }
    existing = parsed as { mcpServers?: Record<string, McpEntry> };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // File doesn't exist yet — start fresh
    } else if (err instanceof SyntaxError) {
      // Don't silently wipe the user's other mcpServers. Copy the malformed
      // file under Tandem's data dir (NOT next to ~/.claude.json — that
      // location may inherit world-readable perms and leak co-tenant API
      // keys via the backup). Mode 0o600 hardens against the same.
      const brokenBackupDir = join(resolveAppDataDir(), ".broken-backups");
      // Validate against default roots [homedir(), tmpdir()] rather than
      // scoping to resolveAppDataDir() — the latter is tautological, and
      // an XDG_DATA_HOME-poisoning attacker can otherwise redirect the
      // backup target outside the home tree.
      assertPathSafe(brokenBackupDir);
      // mode: 0o700 on dir creation — the file mode is 0o600, but a
      // world-readable parent dir lists sibling filenames (older backups
      // carry other vendors' keys). Mode applies only when the dir is
      // newly created; existing dirs retain their mode.
      mkdirSync(brokenBackupDir, { recursive: true, mode: 0o700 });
      // randomUUID() in the path defeats path prediction by an attacker
      // who might pre-create a file at the predicted location and have
      // our mode-at-open inherit world-readable bits. `wx` (exclusive
      // create) below is the second layer.
      const backupPath = join(
        brokenBackupDir,
        `${basename(configPath)}.broken-${Date.now()}-${randomUUID()}`,
      );
      try {
        if (process.platform === "win32") {
          // Windows ignores the POSIX `mode` arg on mkdir, so harden the
          // dir with an explicit DACL BEFORE writing the backup file.
          // Mirrors the ordering invariant in
          // `storage.ts#backupBrokenFile`: dir-level ACL closes the
          // TOCTOU window that a per-file ACL would otherwise open
          // between copyFile and the ACL set. Fail loud — orphaning a
          // half-hardened dir is worse than aborting the backup
          // outright. The inner `catch (copyErr)` below surfaces a
          // named error and refuses to overwrite the malformed config.
          try {
            await setRestrictiveAcl(brokenBackupDir);
          } catch (aclErr) {
            throw new Error(
              `failed to apply restrictive ACL to broken-backups dir ${brokenBackupDir}: ${
                aclErr instanceof Error ? aclErr.message : String(aclErr)
              }`,
              { cause: aclErr },
            );
          }
          // Windows doesn't honor POSIX modes — fall back to plain copy.
          // The randomUUID-suffixed path makes collisions effectively
          // impossible. COPYFILE_EXCL refuses to overwrite an existing
          // target, defeating any predictable-path symlink/pre-create
          // attack the UUID suffix might still leave reachable. NOTE:
          // `setRestrictiveAcl` (acl-win.ts) calls `icacls /grant:r
          // *<SID>:F` without (OI)(CI) inheritance flags, so the new
          // file does NOT inherit the parent dir's SID-only ACE.
          // Instead it receives the DACL synthesized from the process
          // token's default (typically user + SYSTEM + Administrators),
          // which is narrow enough to prevent cross-tenant leak in
          // standard contexts. If broader access is observed, the dir
          // ACE should be made inheritable in acl-win.ts (this would
          // also benefit storage.ts which uses the same helper).
          await copyFile(configPath, backupPath, fsConstants.COPYFILE_EXCL);
        } else {
          // Open with mode 0o600 + `wx` so the file is created exclusively
          // at the right mode (no copyFile + chmodSync race window where
          // the backup was briefly 0o644 with another vendor's API keys
          // inside).
          const data = await readFile(configPath);
          const fd = await open(backupPath, "wx", 0o600);
          try {
            await fd.write(data);
          } finally {
            await fd.close();
          }
        }
        console.error(
          `  Warning: ${configPath} contains malformed JSON — backed up to ${backupPath}, replacing with fresh config`,
        );
      } catch (copyErr) {
        console.error(
          `  Warning: ${configPath} contains malformed JSON and backup failed (${
            copyErr instanceof Error ? copyErr.message : copyErr
          }) — refusing to overwrite. Fix the JSON manually and rerun 'tandem setup'.`,
        );
        throw copyErr;
      }
    } else {
      throw err; // Permission errors, disk errors, etc. should not be silently swallowed
    }
  }

  // Backup the existing config IFF the existing `mcpServers.tandem` entry
  // is non-default (user-customised URL or extra keys). Token rotation and
  // fresh-install runs would otherwise generate backup churn that buries
  // the one backup the user actually needs. The write happens BEFORE the
  // rewrite — atomicity invariant: if backup throws, the original is
  // untouched.
  const backupPath = await maybeBackupExistingConfig(configPath, existing, ops);
  if (backupPath && ops.onBackup) {
    // The onBackup callback is observational — a wizard push, a CLI
    // print, a telemetry hop. If the consumer throws, log it but DO
    // NOT abort the rewrite: doing so would orphan the just-written
    // backup file and leave the user's config un-applied, with no
    // user-visible explanation.
    try {
      ops.onBackup(backupPath);
    } catch (cbErr) {
      console.error(
        `  Warning: onBackup callback threw — continuing with rewrite: ${
          cbErr instanceof Error ? cbErr.message : cbErr
        }`,
      );
    }
  }

  const merged: Record<string, McpEntry> = {
    ...(existing.mcpServers ?? {}),
    ...ops.create,
  };
  // Explicit removals — silent if the key was already absent.
  for (const key of ops.remove) {
    // "create wins": never remove a key we're also creating this run. The
    // wizard builds `ApplyOps` directly from a user-confirmed diff and can
    // legitimately list the same key in both `create` and `remove`; without
    // this guard the channel shim we just registered would be deleted again.
    // Structural invariant for every flow — see #985.
    if (key in ops.create) continue;
    if (merged[key]) {
      console.error(`  Note: removed mcpServers.${key} from ${configPath}`);
    }
    delete merged[key];
  }
  const updated = { ...existing, mcpServers: merged };

  await mkdir(dirname(configPath), { recursive: true });
  await atomicWrite(JSON.stringify(updated, null, 2) + "\n", configPath);
}

export type RemoveEntriesResult =
  | { status: "removed"; removed: RemovableEntry[] }
  | { status: "no-op" }
  | { status: "missing" }
  | { status: "skipped"; reason: "malformed-json" | "not-an-object" | "oversize" };

/**
 * Remove Tandem's `mcpServers` keys from a client config — the uninstall
 * counterpart of `applyConfig`, sharing the same gates (`assertPathSafe`,
 * size cap, BOM strip) and the same `atomicWrite` 0o600/ACL hardening, but
 * with scrub semantics `applyConfig` deliberately does NOT have:
 * - never creates the file (`applyConfig` starts fresh on ENOENT);
 * - never replaces malformed JSON (`applyConfig` backs it up and rewrites —
 *   on an uninstall path that would wipe the user's whole config);
 * - never rewrites when nothing matched (no churn of a file other vendors'
 *   tokens live in).
 *
 * `skipped` reasons are fixed strings — parse-error detail must never reach
 * the caller's log (V8 SyntaxError messages embed source snippets, and this
 * file holds bearer tokens).
 */
export async function removeConfigEntries(
  configPath: string,
  keys: RemovableEntry[],
): Promise<RemoveEntriesResult> {
  assertPathSafe(configPath);

  let raw: string;
  try {
    const { size } = statSync(configPath);
    if (size > MAX_CONFIG_BYTES) return { status: "skipped", reason: "oversize" };
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    throw err;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "skipped", reason: "malformed-json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "skipped", reason: "not-an-object" };
  }

  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
    return { status: "no-op" };
  }
  const map = servers as Record<string, unknown>;
  const removed = keys.filter((key) => key in map);
  if (removed.length === 0) return { status: "no-op" };
  for (const key of removed) {
    delete map[key];
  }

  await atomicWrite(JSON.stringify(parsed, null, 2) + "\n", configPath);
  return { status: "removed", removed };
}

/**
 * Conditionally back up `configPath` before `applyConfig` overwrites a
 * user-customised tandem entry. Returns the backup path on write, or
 * `undefined` when no backup was needed (fresh install, token rotation,
 * non-tandem-key changes only).
 *
 * Atomicity contract: if this throws, the caller MUST abort before
 * touching the destination. The original config and any prior backup
 * remain intact.
 */
async function maybeBackupExistingConfig(
  configPath: string,
  existing: { mcpServers?: Record<string, McpEntry> },
  ops: ApplyOps,
): Promise<string | undefined> {
  const existingTandem = existing.mcpServers?.tandem;
  if (!shouldBackup(existingTandem, ops.create.tandem)) return undefined;

  const dir = backupDir(resolveAppDataDir());
  // assertPathSafe defeats XDG_DATA_HOME poisoning — same hardening as
  // the broken-JSON backup path above.
  assertPathSafe(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // mkdirSync's `mode` only applies on creation. If the dir already
  // existed at a more permissive mode (older umask, manual creation,
  // user fiddling), tighten it now. POSIX-only; on Windows the file's
  // own ACL — set by setRestrictiveAcl inside writeBackup — is the
  // protection. Filenames in a broader dir leak timestamps, not
  // bytes; failing closed here would block legit setups for that.
  if (process.platform !== "win32") {
    try {
      const dirStat = statSync(dir);
      if ((dirStat.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
    } catch {
      // stat/chmod failure is non-fatal — proceeds with the wider
      // protection on the file itself.
    }
  }

  const content = readFileSync(configPath);
  const backupPath = await writeBackup(dir, content);
  // Prune AFTER successful write so we never delete the previous backup
  // before its replacement is on disk.
  await pruneOldBackups(dir);
  return backupPath;
}

/**
 * Install the Tandem skill to ~/.claude/skills/tandem/SKILL.md.
 * Claude Code auto-discovers skills in this directory and uses the description
 * field to trigger them when tandem_* tools are present.
 *
 * `homeOverride` is supported for tests only — the apply HTTP handler
 * MUST NOT thread this from the request body. Same symlink/realpath
 * hardening as `applyConfig`.
 */
export async function installSkill(opts: { homeOverride?: string } = {}): Promise<void> {
  const home = opts.homeOverride ?? homedir();
  const skillPath = join(home, ".claude", "skills", "tandem", "SKILL.md");
  assertPathSafe(skillPath, { allowedRoots: opts.homeOverride ? [opts.homeOverride] : undefined });
  await mkdir(dirname(skillPath), { recursive: true });
  await atomicWrite(SKILL_CONTENT, skillPath);
}

/** Parse the integer `version:` from a skill front-matter block. Returns 0
 * if the file doesn't exist, has no version, or fails to parse — older
 * bundled skills predate the version stamp, so 0 means "definitely upgrade". */
function readSkillVersion(skillContent: string): number {
  const match = skillContent.match(/^version:\s*(\d+)\s*$/m);
  if (!match) return 0;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? n : 0;
}

const BUNDLED_SKILL_VERSION = readSkillVersion(SKILL_CONTENT);

/** Module-scoped last-failure record. Cleared on successful refresh; set on
 * read/write failure. Surfaced via `GET /api/launcher/status` (loopback only)
 * so the palette/settings UI can warn the user that the bundled skill is
 * out of date. `null` when last refresh succeeded or was a no-op. */
let lastSkillRefreshError: { code: "write-failed" | "read-failed"; message: string } | null = null;
export function getSkillRefreshError(): {
  code: "write-failed" | "read-failed";
  message: string;
} | null {
  return lastSkillRefreshError;
}
/** Test-only — reset module state between tests. */
export function _resetSkillRefreshErrorForTests(): void {
  if (process.env.VITEST !== "true") return;
  lastSkillRefreshError = null;
}

/**
 * Idempotent skill refresh — called from supervisor startup so existing
 * users (who already ran `tandem setup` once) pick up bundled-skill
 * updates without re-running the wizard.
 *
 * Compares the bundled `version:` against the on-disk file. Writes only
 * if bundled > on-disk. Silently no-ops on any error (read failure,
 * write failure, missing parent dir) — this is a best-effort refresh,
 * not a critical path. The wizard-driven `installSkill()` remains the
 * authoritative installer.
 */
export async function refreshSkillIfStale(opts: { homeOverride?: string } = {}): Promise<void> {
  if (BUNDLED_SKILL_VERSION === 0) return; // Bundled skill has no version stamp — nothing to compare.
  const home = opts.homeOverride ?? homedir();
  const skillPath = join(home, ".claude", "skills", "tandem", "SKILL.md");
  try {
    assertPathSafe(skillPath, {
      allowedRoots: opts.homeOverride ? [opts.homeOverride] : undefined,
    });
  } catch {
    return;
  }
  let onDiskVersion = -1; // -1 = file missing (treat as needing install)
  let readErr: unknown;
  try {
    const fs = await import("node:fs/promises");
    const current = await fs.readFile(skillPath, "utf8");
    onDiskVersion = readSkillVersion(current);
  } catch (err) {
    // ENOENT is expected (first run); any other error is a real read failure.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") readErr = err;
  }
  if (onDiskVersion >= BUNDLED_SKILL_VERSION) {
    // No-op path — clear any prior failure only if read succeeded.
    if (readErr === undefined) lastSkillRefreshError = null;
    else
      lastSkillRefreshError = {
        code: "read-failed",
        message: readErr instanceof Error ? readErr.message : String(readErr),
      };
    return;
  }
  try {
    await mkdir(dirname(skillPath), { recursive: true });
    await atomicWrite(SKILL_CONTENT, skillPath);
    lastSkillRefreshError = null;
    console.error(
      `[Tandem] Refreshed bundled skill at ${skillPath} (v${onDiskVersion} → v${BUNDLED_SKILL_VERSION}).`,
    );
  } catch (err) {
    lastSkillRefreshError = {
      code: "write-failed",
      message: err instanceof Error ? err.message : String(err),
    };
    console.error(
      `[Tandem] Skill refresh failed (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Returns true if the channel-shim build artifact exists at the given path.
 * Exported so the prereq check can be tested without spawning runSetup.
 */
export function validateChannelShimPrereq(channelPath: string): boolean {
  return existsSync(channelPath);
}

/**
 * Single source of truth for "should this target get the stdio channel shim?".
 *
 * The channel shim is Claude Code's default real-time push transport. The
 * plugin also carries a monitor that activates on Claude Code 2.1.212+ and
 * needs no flag — an independent push path (it was inactive on 2.1.143, the
 * historical Spike B / #985 NO-GO, since reversed). The channel shim stays
 * canonical by decision (2026-07-19, ADR-028) — the monitor is installable but
 * not made the default; both active in one session double-deliver — so the
 * default for the Claude Code target stays ON, gated only by the build
 * artifact actually existing.
 *
 * - `claude-desktop` → always false (Cowork stdio path; the node-process
 *   shim does not apply there).
 * - `override` (the explicit `--with-channel-shim` / wizard opt-out) wins
 *   when provided.
 * - Otherwise: default-on for Claude Code, but only if `channelPath` exists.
 *   That `existsSync` guard does double duty — it degrades gracefully when
 *   `tandem` runs from source without a build, AND it stops the CLI/wizard
 *   from writing a wrong `CHANNEL_DIST` on a desktop bundle. On the desktop
 *   bundle the correct resource-dir channel path is injected via the
 *   `TANDEM_CHANNEL_DIST` env var (see `resolveChannelDist`), so `CHANNEL_DIST`
 *   already resolves to an existing file there and the shim registers.
 */
export function shouldRegisterChannelShim(
  targetKind: TargetKind,
  channelPath: string,
  override?: boolean,
): boolean {
  if (targetKind === "claude-desktop") return false;
  if (override !== undefined) return override;
  return validateChannelShimPrereq(channelPath);
}

/** Re-exported for `tandem setup` orchestration in `src/cli/setup.ts`. */
export { CHANNEL_DIST, PACKAGE_ROOT };

/**
 * Write the given token into all detected Claude MCP config files.
 * Returns the number of configs successfully updated and any per-target errors.
 *
 * CLI-shaped semantics: when `withChannelShim` is false, any existing
 * `tandem-channel` entry is removed (legacy install artifact). The
 * wizard's apply endpoint uses an explicit-confirmation code path
 * instead; this helper is for `tandem rotate-token` / `tandem setup`
 * where the flag already captures user intent.
 */
export async function applyConfigWithToken(
  token: string | null,
  opts: { force?: boolean; withChannelShim?: boolean } = {},
): Promise<{ updated: number; errors: string[] }> {
  const targets = detectTargets({ force: opts.force });

  let updated = 0;
  const errors: string[] = [];
  for (const t of targets) {
    // Resolve per-target: a token rotation should preserve/heal the channel
    // shim registration (default-on for Claude Code) rather than silently
    // strip it. `opts.withChannelShim` still wins as an explicit override.
    const withChannelShim = shouldRegisterChannelShim(t.kind, CHANNEL_DIST, opts.withChannelShim);
    const entries = buildMcpEntries(CHANNEL_DIST, {
      withChannelShim,
      token: token ?? undefined,
      targetKind: t.kind,
    });
    try {
      await applyConfig(t.configPath, applyOpsForCli(entries, { withChannelShim }));
      updated++;
    } catch (err) {
      errors.push(`${t.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { updated, errors };
}
