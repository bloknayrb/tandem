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
 * ${UUID8}.json`. Dir mode 0o700, file mode 0o600. The random suffix
 * makes the name unpredictable and `wx` (exclusive create) refuses an
 * existing file; on Windows `wx` still creates through a dangling symlink
 * (#2144), so the bound there is the suffix plus the directory being
 * writable only by this user.
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
import { promises } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { readdir, rm, stat } from "node:fs/promises";
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
 * forensics. Exported for `file-io/doc-backup.ts`'s snapshot filenames.
 */
export function formatTimestamp(d: Date): string {
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
export function backupFilename(now: Date = new Date(), prefix: string = BACKUP_PREFIX): string {
  const ts = formatTimestamp(now);
  const uuid8 = randomUUID().slice(0, 8);
  return `${prefix}${ts}-${uuid8}${BACKUP_SUFFIX}`;
}

/**
 * The boot sweep's backups of `~/.claude.json` (#2358 PR 2b) carry their own
 * prefix, so they are capped separately: a run of sweep backups (one per
 * migration or forward repoint) never evicts the backup `applyConfig` took of
 * an entry the user had customised. Not a `claude-json-` prefix extension,
 * which `listBackups`' `startsWith` would also match.
 */
export const SWEEP_BACKUP_PREFIX = "sweep-claude-json-";

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
export async function writeBackup(
  dir: string,
  content: Buffer,
  prefix: string = BACKUP_PREFIX,
): Promise<string> {
  const backupPath = join(dir, backupFilename(new Date(), prefix));

  // `wx` is exclusive-create: fails if the path already exists (UUID
  // collision is astronomically rare but a symlinked predictable path
  // is the real concern). `0o600` is honoured on POSIX; on Windows
  // we apply setRestrictiveAcl below.
  const fd = await promises.open(backupPath, "wx", 0o600);
  let writeFailed = false;
  try {
    try {
      await fd.write(content);
    } catch (writeErr) {
      writeFailed = true;
      throw writeErr;
    }
  } finally {
    await fd.close();
    if (writeFailed) {
      // Remove the partial/zero-byte file so it doesn't count against
      // MAX_BACKUPS or mislead a forensic read. Cleanup errors are
      // swallowed — the write failure is what the caller needs to see.
      await rm(backupPath, { force: true }).catch(() => {});
    }
  }

  if (process.platform === "win32") {
    try {
      await setRestrictiveAcl(backupPath);
    } catch (aclErr) {
      // ACL failure leaves a bearer-token-bearing file on disk at the
      // dir-inherited permissions. Remove it — the caller treats the
      // throw as "abort", so an orphan would be invisible.
      await rm(backupPath, { force: true }).catch(() => {});
      throw aclErr;
    }
  }

  return backupPath;
}

/**
 * Write every byte of `data` through `handle` from offset 0. `FileHandle.write`
 * may write fewer bytes than asked; a write that makes no progress throws.
 */
export async function writeAllThrough(handle: FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset, offset);
    if (bytesWritten <= 0) throw new Error("write made no progress");
    offset += bytesWritten;
  }
}

/** The suffix a reserved backup carries until it is filled (#2358 PR 2b). */
const PART_SUFFIX = ".part";

/**
 * A backup slot made before the bytes it will hold are known: an empty file,
 * created exclusively and restricted (POSIX 0600; on Windows the restrictive
 * DACL), whose handle stays open so the fill writes into exactly this file.
 * Nothing reopens it by path.
 */
export interface ReservedBackup {
  readonly partPath: string;
  readonly finalPath: string;
  readonly handle: FileHandle;
}

/**
 * Reserve a backup in `dir` (#2358 PR 2b). The boot sweep reserves before it
 * reads the config it will back up, so the slow Windows ACL step runs outside
 * the read-to-rename window. The file is named `<backup>.json.part` until
 * {@link commitReservedBackup} fills and renames it, so an unfilled slot is
 * never listed, counted or pruned as a backup; {@link sweepBackupsOnStartup}
 * removes one a killed run left behind.
 */
export async function reserveBackup(dir: string, prefix: string): Promise<ReservedBackup> {
  const finalPath = join(dir, backupFilename(new Date(), prefix));
  const partPath = finalPath + PART_SUFFIX;
  const handle = await promises.open(partPath, "wx", 0o600);
  if (process.platform === "win32") {
    try {
      // By path, with the handle still open: libuv opens with every share
      // flag, so icacls and Get-Acl can reach the file (measured by the
      // windows-acl-proof spec), and the DACL set here is the one the
      // handle's later writes land under.
      await setRestrictiveAcl(partPath);
    } catch (aclErr) {
      await discardReservedBackup({ partPath, finalPath, handle });
      throw aclErr;
    }
  }
  return { partPath, finalPath, handle };
}

/**
 * Fill a reserved backup through its handle, close it and rename it to its
 * final `.json` name (a rename keeps the file's DACL and mode). Returns the
 * final path. On any failure the slot is removed and the error re-thrown.
 */
export async function commitReservedBackup(
  reserved: ReservedBackup,
  content: Buffer,
): Promise<string> {
  try {
    await writeAllThrough(reserved.handle, content);
    await reserved.handle.close();
    await renameWithRetry(reserved.partPath, reserved.finalPath);
  } catch (err) {
    await discardReservedBackup(reserved);
    throw err;
  }
  return reserved.finalPath;
}

/**
 * `rename`, retried briefly on Windows' transient refusals. A file closed a
 * moment ago is often still open in an antivirus scan-on-close, and the rename
 * then fails EPERM, EBUSY or EACCES for a few hundred milliseconds. About 1 s
 * in all, then the error stands (the sweep then leaves the config for the next
 * start).
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await promises.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (process.platform !== "win32" || !transient || attempt >= 6) throw err;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}

/**
 * Close and remove a reserved backup. Idempotent and never throws; a removal
 * that fails is logged, because a filled `.part` holds the config's tokens
 * (still user-only, and reaped by the startup sweep after an hour).
 */
export async function discardReservedBackup(reserved: ReservedBackup): Promise<void> {
  await reserved.handle.close().catch(() => {});
  try {
    await rm(reserved.partPath, { force: true });
  } catch (err) {
    console.error(
      `[Tandem] Could not remove the unfinished backup ${reserved.partPath}: ` +
        `${err instanceof Error ? err.message : err}. Tandem removes it at a later start.`,
    );
  }
}

/** A `.part` this old cannot be another instance's slot in flight. */
const PART_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Remove reserved sweep backups (`sweep-claude-json-*.json.part`) older than
 * an hour: a run killed between reserving and renaming leaves one, empty or
 * partly written. The age gate keeps a slot another instance is filling.
 */
async function removeStaleReservedBackups(dir: string): Promise<void> {
  try {
    const cutoff = Date.now() - PART_MAX_AGE_MS;
    for (const name of await readdir(dir)) {
      if (!name.startsWith(SWEEP_BACKUP_PREFIX) || !name.endsWith(BACKUP_SUFFIX + PART_SUFFIX)) {
        continue;
      }
      const path = join(dir, name);
      try {
        if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true });
      } catch {
        // Gone already, or unreadable: the rest are still worth a look.
      }
    }
  } catch {
    // Best-effort, like the prune beside it.
  }
}

/**
 * List backups currently in `dir`, newest first. Files are matched by
 * the supplied prefix/suffix (defaults match the `.claude.json` backup
 * scheme) so stray non-backup files in the dir aren't touched.
 *
 * The prefix/suffix parameters let a second caller (the broken-
 * integrations.json backup sweep in `storage.ts`) share this
 * implementation. Both call sites filter by a constant pair.
 *
 * Sorting is by filename, which works because the timestamp segment is
 * lexicographically monotonic (`YYYYMMDD-HHMMSS` or `Date.now()`). The
 * UUID suffix is a tiebreaker within the same millisecond.
 */
export async function listBackups(
  dir: string,
  prefix: string = BACKUP_PREFIX,
  suffix: string = BACKUP_SUFFIX,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((e) => e.startsWith(prefix) && e.endsWith(suffix))
    .sort()
    .reverse();
}

/**
 * Delete backups beyond the `max` newest. Returns the list of paths
 * removed (best-effort — entries that failed to remove are still
 * reported in the return list and logged via `console.error`, but the
 * loop never throws).
 *
 * The aggregate-failure shape exists because this runs at server
 * startup: an AV-locked file on Windows or a transient EACCES MUST NOT
 * abandon the rest of the sweep. The previous shape threw on the first
 * `rm` failure and silently skipped the rest.
 *
 * Defaults match the `claude-json-...json` scheme; the broken-
 * integrations sweep passes its own constants.
 */
export async function pruneOldBackups(
  dir: string,
  prefix: string = BACKUP_PREFIX,
  suffix: string = BACKUP_SUFFIX,
  max: number = MAX_BACKUPS,
  /** A backup name never to remove — the one the caller just wrote. Names
   *  sort by a SECOND-resolution timestamp and then a random id, so several
   *  backups in one second sort arbitrarily, and the newest could otherwise be
   *  the one pruned. */
  protect?: string,
): Promise<string[]> {
  const all = await listBackups(dir, prefix, suffix);
  const kept = protect !== undefined && all.includes(protect) ? 1 : 0;
  const toRemove = all.filter((n) => n !== protect).slice(Math.max(0, max - kept));
  const failures: Array<{ path: string; err: unknown }> = [];
  for (const name of toRemove) {
    const fullPath = join(dir, name);
    try {
      await rm(fullPath, { force: true });
    } catch (err) {
      failures.push({ path: fullPath, err });
    }
  }
  if (failures.length > 0) {
    const summary = failures
      .map((f) => `${f.path}: ${f.err instanceof Error ? f.err.message : String(f.err)}`)
      .join("; ");
    console.error(
      `[tandem] backup sweep: ${failures.length} entries could not be removed (${summary})`,
    );
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
  await pruneOldBackups(backupDir(appDataDir), SWEEP_BACKUP_PREFIX);
  await removeStaleReservedBackups(backupDir(appDataDir));
}

/**
 * Decide whether overwriting `existing` with `newEntry` could lose
 * information the user might care about. The check is content-based,
 * not shape-based: shape-only checks miss the case where a user
 * hand-crafted `headers.Authorization` with a custom Bearer token —
 * Tandem's overwrite would silently destroy it because the entry's
 * SHAPE matches the default (URL identical, only known keys present).
 *
 * Returns `true` when:
 *   - existing entry exists, AND
 *   - existing != newEntry under canonical-JSON equality.
 *
 * This trades off: token rotation now triggers a backup (the bytes
 * change). That's acceptable churn — `MAX_BACKUPS=3` caps disk usage
 * and the user gets a strict history of recent token-bearing configs
 * as a side benefit. The alternative (shape-only check) had a
 * security review-flagged silent-destruction gap that we cannot close
 * without state we don't have (Tandem can't distinguish "token Tandem
 * itself wrote 5 minutes ago" from "token the user added by hand").
 */
export function shouldBackup(existing: unknown, newEntry: unknown): boolean {
  if (existing == null) return false;
  return canonicalJson(existing) !== canonicalJson(newEntry);
}

/**
 * Deterministic JSON-string with sorted object keys. Defeats key-order
 * false-positives (`{a:1,b:2}` vs `{b:2,a:1}` would otherwise
 * stringify differently).
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(",")}}`;
}
