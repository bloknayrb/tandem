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
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { SKILL_CONTENT } from "../../cli/skill-content.js";
import { DEFAULT_MCP_PORT } from "../../shared/constants.js";
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
const CHANNEL_DIST = resolve(PACKAGE_ROOT, "dist/channel/index.js");

const MCP_URL = `http://127.0.0.1:${DEFAULT_MCP_PORT}`;

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
  /** Include the legacy stdio channel shim. Defaults to false — the plugin
   *  monitor handles event push for modern installs. Users on older setups
   *  can run `tandem setup --with-channel-shim` to preserve the shim. */
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
      args: ["-y", "tandem-editor", "mcp-stdio"],
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
  await writeFile(tmp, content, "utf-8");

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
          // Windows doesn't honor POSIX modes — fall back to plain copy.
          // The randomUUID-suffixed path makes collisions effectively impossible.
          await copyFile(configPath, backupPath);
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
    if (merged[key]) {
      console.error(`  Note: removed mcpServers.${key} from ${configPath}`);
    }
    delete merged[key];
  }
  const updated = { ...existing, mcpServers: merged };

  await mkdir(dirname(configPath), { recursive: true });
  await atomicWrite(JSON.stringify(updated, null, 2) + "\n", configPath);
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

/**
 * Returns true if the channel-shim build artifact exists at the given path.
 * Exported so the prereq check can be tested without spawning runSetup.
 */
export function validateChannelShimPrereq(channelPath: string): boolean {
  return existsSync(channelPath);
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
    const entries = buildMcpEntries(CHANNEL_DIST, {
      withChannelShim: opts.withChannelShim,
      token: token ?? undefined,
      targetKind: t.kind,
    });
    try {
      await applyConfig(
        t.configPath,
        applyOpsForCli(entries, { withChannelShim: !!opts.withChannelShim }),
      );
      updated++;
    } catch (err) {
      errors.push(`${t.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { updated, errors };
}
