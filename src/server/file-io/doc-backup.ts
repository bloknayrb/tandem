/**
 * Pre-overwrite snapshots of user text documents (.md/.txt).
 *
 * The serializer has rewritten user files badly three separate times (#379,
 * #605, lesson #69). All fixed — but the recurrence pattern says round-trip
 * bugs will happen again, and until now the user had zero recovery path: the
 * 60s autosave overwrites their file with serializer output and the original
 * bytes are gone. This module copies the on-disk bytes verbatim (never through
 * the serializer — surviving serializer bugs is the point) before Tandem's
 * FIRST overwrite of a path per server run.
 *
 * Keyed by path-hash, not docId: docId is the Hocuspocus room name and stays
 * stable across rename, but the snapshot decision is about the bytes at a
 * path. Path-keying also covers `saveDocumentAsToDisk` landing on an existing
 * file — the one save path that can overwrite content Tandem never produced.
 *
 * Failure contract is the OPPOSITE of `integrations/backup.ts` (which must
 * abort the config rewrite if the backup fails): a failed snapshot must NOT
 * block the save, because the in-memory edits are the newer data. Warn once,
 * proceed, retry on the next save.
 *
 * Layout: `${appDataDir}/doc-backups/<pathHash>/<stem>-<YYYYMMDD-HHMMSS>-<uuid8><ext>`
 * plus `source.txt` recording the original absolute path. Plain copies —
 * restorable with any file manager, no Tandem needed.
 */

import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { generateNotificationId } from "../../shared/utils.js";
import { docHash } from "../annotations/doc-hash.js";
import { setRestrictiveAcl } from "../integrations/acl-win.js";
import { formatTimestamp } from "../integrations/backup.js";
import { pushNotification } from "../notifications.js";
import { WIN_RESERVED_NAMES } from "./filename-safety.js";

/** Directory name (under appDataDir) for pre-overwrite document snapshots. */
const DOC_BACKUP_DIR_NAME = "doc-backups";

/** Records the original absolute path inside each per-path subdir. */
const SOURCE_MARKER_FILENAME = "source.txt";

/** Keep at most this many snapshots per document path. */
export const MAX_DOC_BACKUPS = 3;

/**
 * Total-size ceiling for the whole doc-backups tree. Bounds confused-deputy
 * churn (an MCP client opening unlimited fresh paths, each earning a snapshot)
 * without per-doc bookkeeping. When exceeded, snapshotting pauses for the
 * rest of the server run (one notification).
 */
export const MAX_DOC_BACKUP_BYTES = 500 * 1024 * 1024;

/** Snapshots older than this are removed by the boot sweep. Matches session GC. */
const SWEEP_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Matches a snapshot filename's `-YYYYMMDD-HHMMSS-<uuid8>` tail. The anchored
 * tail (not the variable stem) is the deletion boundary: `source.txt` and any
 * stray file can never match, so prune/sweep only ever touch files this module
 * wrote. Lexicographic sort on the full name is newest-first-safe because the
 * stem is constant within a subdir and the timestamp segment is monotonic.
 */
const SNAPSHOT_TAIL_RE = /-\d{8}-\d{6}-[0-9a-f]{8}(\.[^.]*)?$/;

/** Paths (by hash) already snapshotted — or deliberately skipped — this run. */
const snapshottedPaths = new Set<string>();

/** One cap-exceeded notification per server run. */
let sizeCapNotified = false;

/** Windows ACL applied to the backup root this run (spawns subprocesses — once is enough). */
let aclEnsured = false;

/** Test-only: reset the per-run gate and notification/ACL latches. */
export function _resetDocBackupGateForTests(): void {
  snapshottedPaths.clear();
  sizeCapNotified = false;
  aclEnsured = false;
}

/** Resolve the doc-backups root under `appDataDir` (injectable for tests). */
export function docBackupsRoot(appDataDir: string): string {
  return path.join(appDataDir, DOC_BACKUP_DIR_NAME);
}

/**
 * Make a user-supplied basename stem safe to embed in a snapshot filename.
 * The stem is cosmetic (recovery identity lives in the path-hash subdir and
 * `source.txt`), so sanitization can be lossy: strip C0 controls, separators
 * and Windows-illegal chars, trim trailing dots/spaces (Windows silently drops
 * them, desyncing the constructed path from the on-disk name), cap length,
 * and dodge reserved device stems. Mirrors `validateRenameFilename`'s rules
 * (`filename-safety.ts`) in sanitize-don't-reject form.
 */
export function sanitizeBackupStem(stem: string): string {
  let safe = stem
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping C0 controls is the point
    .replace(/[\x00-\x1f/\\<>:"|?*]/g, "_")
    .slice(0, 40)
    .replace(/[ .]+$/, "");
  // Trailing-trim the FIRST-dot stem too: `con .tar` splits to `con `, which
  // Windows trims to the CON device on disk (see filename-safety.ts).
  const firstStem = safe
    .split(".")[0]
    .toLowerCase()
    .replace(/[ .]+$/, "");
  if (safe.length === 0 || WIN_RESERVED_NAMES.has(firstStem)) {
    safe = `doc${safe.length === 0 ? "" : `-${safe}`}`;
  }
  return safe;
}

/** Build a snapshot filename for `filePath` (e.g. `thesis-20260609-141500-ab12cd34.md`). */
export function snapshotFilename(filePath: string, now: Date = new Date()): string {
  const ext = path.extname(filePath);
  const stem = sanitizeBackupStem(path.basename(filePath, ext));
  // Extensions are server-validated at open/save-as time, but sanitize anyway
  // so this function is safe in isolation.
  const safeExt = sanitizeBackupStem(ext.replace(/^\./, ""));
  const uuid8 = randomUUID().slice(0, 8);
  return `${stem}-${formatTimestamp(now)}-${uuid8}${safeExt ? `.${safeExt}` : ""}`;
}

/** List snapshot filenames in a per-path subdir, newest first. */
async function listSnapshots(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((e) => SNAPSHOT_TAIL_RE.test(e))
    .sort()
    .reverse();
}

/** Total size in bytes of all regular files under the doc-backups root. */
async function totalTreeBytes(root: string): Promise<number> {
  let total = 0;
  let subdirs: Dirent[];
  try {
    subdirs = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const sub of subdirs) {
    if (!sub.isDirectory()) continue;
    const subPath = path.join(root, sub.name);
    let files: Dirent[];
    try {
      files = await fs.readdir(subPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile()) continue;
      try {
        total += (await fs.stat(path.join(subPath, f.name))).size;
      } catch {
        // Raced away or unreadable — uncounted is fine for a soft cap.
      }
    }
  }
  return total;
}

export type SnapshotOutcome =
  | "written"
  | "skipped-already-this-run"
  | "skipped-no-source"
  | "skipped-identical"
  | "skipped-size-cap"
  | "failed";

/**
 * Snapshot the current on-disk bytes of `filePath` before Tandem's first
 * overwrite of that path this server run. Never throws — the caller is mid
 * save and a snapshot failure must not block the disk write.
 *
 * Gate semantics: success and every deliberate skip (no source file /
 * byte-identical / size cap) mark the path done for this run. Only a FAILURE
 * leaves the gate unset so the next save retries.
 *
 * TOCTOU note: the read shares the existing save path's window — the external
 * -mtime guard in `saveDocumentToDisk` runs before it, and an external writer
 * racing the read was already a hazard for the save itself. Nothing new.
 */
export async function snapshotBeforeFirstWrite(
  filePath: string,
  opts: { appDataDir: string; documentId?: string; maxTotalBytes?: number },
): Promise<SnapshotOutcome> {
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_DOC_BACKUP_BYTES;
  const pathKey = docHash(filePath);
  if (snapshottedPaths.has(pathKey)) return "skipped-already-this-run";

  try {
    let original: Buffer;
    try {
      original = await fs.readFile(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // New file — nothing pre-existing to lose. Everything written to this
        // path later in the run is Tandem's own output.
        snapshottedPaths.add(pathKey);
        return "skipped-no-source";
      }
      throw err;
    }

    const root = docBackupsRoot(opts.appDataDir);
    const subdir = path.join(root, pathKey);

    // Byte-identical skip: nothing changed on disk since the newest snapshot
    // (typical across restarts with no external edits). ENOENT mid-read (e.g.
    // a peer instance pruning concurrently) means "no prior snapshot" —
    // proceed with the write.
    const existing = await listSnapshots(subdir);
    if (existing.length > 0) {
      try {
        const newest = await fs.readFile(path.join(subdir, existing[0]));
        if (newest.equals(original)) {
          snapshottedPaths.add(pathKey);
          return "skipped-identical";
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }

    if ((await totalTreeBytes(root)) + original.length > maxTotalBytes) {
      snapshottedPaths.add(pathKey);
      if (!sizeCapNotified) {
        sizeCapNotified = true;
        pushNotification({
          id: generateNotificationId(),
          type: "general-error",
          severity: "warning",
          message:
            "Document backups paused: the backup folder exceeds its size limit. " +
            "Older backups are removed automatically after 30 days.",
          dedupKey: "doc-backup:size-cap",
          timestamp: Date.now(),
        });
      }
      console.error(
        `[DocBackup] Size cap reached (${maxTotalBytes} bytes) — skipping snapshot of ${filePath}`,
      );
      return "skipped-size-cap";
    }

    // 0o700/0o600 + best-effort Windows ACL: snapshots hold user document
    // content (prose, not tokens), so unlike integrations/backup.ts an ACL
    // failure keeps the backup — an existing backup beats no backup. The ACL
    // spawns icacls/whoami, so apply it once per run, not once per path.
    await fs.mkdir(subdir, { recursive: true, mode: 0o700 });
    if (process.platform === "win32" && !aclEnsured) {
      aclEnsured = true;
      try {
        await setRestrictiveAcl(root);
      } catch (aclErr) {
        console.error("[DocBackup] Restrictive ACL on backup root failed (continuing):", aclErr);
      }
    }

    // `wx` exclusive-create: a pre-planted symlink or colliding name fails the
    // open instead of following it. UUID suffix makes the path unpredictable.
    const snapshotName = snapshotFilename(filePath);
    const snapshotPath = path.join(subdir, snapshotName);
    try {
      await fs.writeFile(snapshotPath, original, { flag: "wx", mode: 0o600 });
    } catch (writeErr) {
      // Remove any partial file so it never counts as a valid snapshot.
      await fs.rm(snapshotPath, { force: true }).catch(() => {});
      throw writeErr;
    }

    // Metadata, rewritten on every snapshot so post-rename staleness self-heals.
    await fs
      .writeFile(path.join(subdir, SOURCE_MARKER_FILENAME), `${filePath}\n`, { mode: 0o600 })
      .catch((err) => console.error("[DocBackup] source.txt write failed (continuing):", err));

    // Prune beyond MAX_DOC_BACKUPS, newest kept. The write added exactly one
    // file to the listing we already have — no second readdir needed. Do NOT
    // re-sort: the timestamp segment is second-granular, so two snapshots in
    // the same second tie and fall to the random uuid8 — which can rank the
    // just-written file "oldest" and prune it. By construction it is newest.
    const all = [snapshotName, ...existing];
    for (const name of all.slice(MAX_DOC_BACKUPS)) {
      await fs
        .rm(path.join(subdir, name), { force: true })
        .catch((err) => console.error(`[DocBackup] prune failed for ${name}:`, err));
    }

    snapshottedPaths.add(pathKey);
    console.error(`[DocBackup] Snapshotted ${path.basename(filePath)} -> ${snapshotPath}`);
    return "written";
  } catch (err) {
    // Gate stays unset — the next save retries. Notify once per path.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[DocBackup] Snapshot failed for ${filePath} (save proceeds):`, err);
    pushNotification({
      id: generateNotificationId(),
      type: "general-error",
      severity: "warning",
      message: `Could not back up ${path.basename(filePath)} before saving: ${msg}`,
      documentId: opts.documentId,
      dedupKey: `doc-backup:${pathKey}`,
      timestamp: Date.now(),
    });
    return "failed";
  }
}

/**
 * Boot sweep: delete snapshots older than 30 days, then remove empty per-path
 * subdirs. Never throws (caller fires it un-awaited). Callers must gate on
 * `!isStoreReadOnly()` like the orphaned-temp reaper — a read-only peer
 * instance must not race the owner's prune.
 */
export async function sweepDocBackups(
  appDataDir: string,
  nowMs: number = Date.now(),
): Promise<{ cleaned: number; failed: number }> {
  let cleaned = 0;
  let failed = 0;
  const root = docBackupsRoot(appDataDir);

  let subdirs: Dirent[];
  try {
    subdirs = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[DocBackup] sweep: failed to read ${root}:`, err);
    }
    return { cleaned, failed };
  }

  for (const sub of subdirs) {
    if (!sub.isDirectory()) continue;
    const subPath = path.join(root, sub.name);

    let entries: Dirent[];
    try {
      entries = await fs.readdir(subPath, { withFileTypes: true });
    } catch (err) {
      console.error(`[DocBackup] sweep: failed to read ${subPath}:`, err);
      continue;
    }

    let liveSnapshots = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !SNAPSHOT_TAIL_RE.test(entry.name)) continue;
      const fullPath = path.join(subPath, entry.name);
      let tooOld = false;
      try {
        tooOld = nowMs - (await fs.stat(fullPath)).mtimeMs > SWEEP_AGE_MS;
      } catch {
        // Raced away or unreadable — leave it alone.
      }
      if (!tooOld) {
        liveSnapshots++;
        continue;
      }
      try {
        await fs.unlink(fullPath);
        cleaned++;
      } catch (err) {
        failed++;
        console.error(`[DocBackup] sweep: failed to delete ${fullPath}:`, err);
      }
    }

    if (liveSnapshots === 0) {
      // Only ever removes source.txt + the empty dir — the tail regex above
      // guarantees no unexpected file is in scope, and a plain rmdir on a
      // non-empty dir throws, which the catch swallows as "keep".
      await fs.rm(path.join(subPath, SOURCE_MARKER_FILENAME), { force: true }).catch(() => {});
      await fs.rmdir(subPath).catch(() => {});
    }
  }

  return { cleaned, failed };
}
