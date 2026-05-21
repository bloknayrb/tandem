/**
 * Conditional backup of `~/.claude.json` before Tandem overwrites a
 * user-customised `mcpServers.tandem` entry.
 *
 * The threat we close: a user with a hand-crafted tandem entry pointing
 * at a non-default port, a custom URL, or extra fields runs `tandem
 * setup` (or the auto-launcher) and Tandem replaces the entry with the
 * default `http://127.0.0.1:3479/mcp` shape. The user's customisation
 * is silently destroyed.
 *
 * The backup gives them a recovery path. We only write a backup when
 * the existing entry is **non-default** — token-rotation and fresh-
 * install runs would otherwise generate backup churn that buries the
 * one backup the user actually needs.
 *
 * Storage layout: `${appDataDir}/.backups/claude-json-YYYYMMDD-HHMMSS-
 * ${UUID8}.json`. Dir mode 0o700, file mode 0o600. The UUID suffix
 * defeats predictable-path symlink attacks; `wx` (exclusive create)
 * is the second layer.
 *
 * Atomicity invariant: `writeBackup` MUST complete (or throw) before
 * the caller invokes `atomicWrite` on the destination. If the backup
 * write fails, the destination MUST NOT be touched. `applyConfig`
 * sequences this contract explicitly.
 *
 * Cross-platform note: on Windows, `wx` + `mode: 0o600` doesn't honour
 * POSIX modes, so we apply `setRestrictiveAcl` from `acl-win.ts` to the
 * backup file after write. The same SDDL contract that protects
 * `~/.claude.json` itself now also protects the backup copy.
 */

import { randomUUID } from "node:crypto";
import { open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { setRestrictiveAcl } from "./acl-win.js";

/** Directory name (under appDataDir) for non-default-config backups. */
const BACKUP_DIR_NAME = ".backups";

/** Filename prefix — present in every backup we create. */
const BACKUP_PREFIX = "claude-json-";

/** Filename suffix — present in every backup we create. */
const BACKUP_SUFFIX = ".json";

/**
 * Keep at most this many backups. Older ones are pruned on every write
 * and on every server startup (covers crash-mid-prune cases).
 */
export const MAX_BACKUPS = 3;

/**
 * Resolve the backup directory under `appDataDir`. Callers MUST pass the
 * dir as a parameter (not read `resolveAppDataDir()` internally) so tests
 * can inject a tmpdir without env-var stubbing.
 */
export function backupDir(appDataDir: string): string {
  return join(appDataDir, BACKUP_DIR_NAME);
}

/**
 * Format a timestamp as `YYYYMMDD-HHMMSS` in the local timezone. Local
 * time is what the user sees in their file manager — useful for
 * forensics.
 */
function formatTimestamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * Build a backup filename. UUID suffix defeats predictable-path attacks
 * where an attacker pre-creates a symlink at the predicted name.
 */
export function backupFilename(now: Date = new Date()): string {
  const ts = formatTimestamp(now);
  const uuid8 = randomUUID().slice(0, 8);
  return `${BACKUP_PREFIX}${ts}-${uuid8}${BACKUP_SUFFIX}`;
}

/**
 * Write `content` as a backup under `backupDir(appDataDir)`. Caller
 * passes the directory (already validated via `assertPathSafe` and
 * created with mode 0o700) and the bytes to write.
 *
 * Returns the full path of the written backup.
 *
 * Atomicity contract: this function either completes successfully and
 * the backup is on disk, or it throws and the caller MUST NOT proceed
 * with the rewrite. The atomic-failure-leaves-original-intact guarantee
 * depends on this.
 */
export async function writeBackup(dir: string, content: Buffer): Promise<string> {
  const backupPath = join(dir, backupFilename());

  // `wx` is exclusive-create: fails if the path already exists (UUID
  // collision is astronomically rare but a symlinked predictable path
  // is the real concern). `0o600` is honoured on POSIX; on Windows
  // we apply setRestrictiveAcl below.
  const fd = await open(backupPath, "wx", 0o600);
  try {
    await fd.write(content);
  } finally {
    await fd.close();
  }

  if (process.platform === "win32") {
    await setRestrictiveAcl(backupPath);
  }

  return backupPath;
}

/**
 * List backups currently in `dir`, newest first. Files are matched by
 * the `claude-json-...json` prefix/suffix so stray non-backup files in
 * the dir aren't touched.
 *
 * Sorting is by filename, which works because the timestamp segment is
 * lexicographically monotonic (`YYYYMMDD-HHMMSS`). The UUID suffix is a
 * tiebreaker within the same second.
 */
export async function listBackups(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((e) => e.startsWith(BACKUP_PREFIX) && e.endsWith(BACKUP_SUFFIX))
    .sort()
    .reverse();
}

/**
 * Delete backups beyond the `MAX_BACKUPS` newest. Returns the list of
 * paths removed. Called from `writeBackup`'s caller (after a successful
 * write) and from server startup (covers crash-mid-prune).
 */
export async function pruneOldBackups(dir: string): Promise<string[]> {
  const all = await listBackups(dir);
  const toRemove = all.slice(MAX_BACKUPS);
  for (const name of toRemove) {
    await rm(join(dir, name), { force: true });
  }
  return toRemove.map((name) => join(dir, name));
}

/**
 * Server-startup hook. Idempotent. Bounded — sweeps only the backup dir.
 *
 * Callers pass `appDataDir` so tests can inject a tmpdir; the production
 * call site uses `resolveAppDataDir()`.
 */
export async function sweepBackupsOnStartup(appDataDir: string): Promise<void> {
  await pruneOldBackups(backupDir(appDataDir));
}

/**
 * Allowed top-level keys for a tandem HTTP-target entry. Anything else
 * is a sign the user customised the entry by hand — we treat that as
 * non-default and back it up before overwriting.
 *
 * stdio-shape keys (`command`/`args`/`env`) appearing in a tandem entry
 * targeting HTTP are by definition non-default; they hit the
 * "unknown keys" branch below.
 */
const KNOWN_TANDEM_HTTP_KEYS = new Set(["type", "url", "headers"]);

/**
 * Decide whether an existing tandem entry counts as "non-default" — i.e.
 * something the user customised that we owe a backup for before
 * overwriting. Returns `true` if the entry's URL differs from
 * `expectedUrl` or it carries any key outside the HTTP-target shape.
 */
export function isNonDefaultTandem(
  entry: Record<string, unknown> | undefined,
  expectedUrl: string,
): boolean {
  if (!entry) return false;
  if (entry.url !== expectedUrl) return true;
  for (const k of Object.keys(entry)) {
    if (!KNOWN_TANDEM_HTTP_KEYS.has(k)) return true;
  }
  return false;
}
