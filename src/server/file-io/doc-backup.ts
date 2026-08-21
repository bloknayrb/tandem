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
 * without per-doc bookkeeping. When exceeded, THIS snapshot is skipped and its
 * path is not retried this run; every other path re-evaluates the cap on its
 * own first write, so it is not a global pause. Only the notification is
 * run-scoped (`sizeCapNotified`) — one per run, however many paths skip. The
 * cap clears when the tree shrinks, which in practice means the 30-day boot
 * sweep, i.e. across a restart rather than mid-session.
 */
export const MAX_DOC_BACKUP_BYTES = 500 * 1024 * 1024;

/** Snapshots older than this are removed by the boot sweep. Matches session GC. */
const SWEEP_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Matches a snapshot filename's `-YYYYMMDD-HHMMSS-<uuid8>` tail. The anchored
 * tail (not the variable stem) is the deletion boundary: `source.txt` and any
 * stray file can never match, so prune/sweep only ever touch files this module
 * wrote. Lexicographic sort on the full name is approximately newest-first
 * (constant stem + timestamp segment) but ties within the same second fall to
 * the random uuid8 — callers that need true recency order re-sort by mtime
 * (`listDocBackups`); prune avoids the tie by construction.
 */
const SNAPSHOT_TAIL_RE = /-\d{8}-\d{6}-[0-9a-f]{8}(\.[^.]*)?$/;

/** Paths (by hash) already snapshotted — or deliberately skipped — this run. */
const snapshottedPaths = new Set<string>();

/** One cap-exceeded notification per server run. */
let sizeCapNotified = false;

/**
 * Paths (by hash) whose snapshot failure was already toasted this run. Without
 * this latch a persistent failure would re-toast every 60s autosave tick (the
 * 6s toast auto-dismiss is far shorter than the retry interval, so dedupKey
 * alone only coalesces the activity tray, not the toasts). Cleared on success
 * so a NEW failure after recovery notifies again. stderr still logs every retry.
 */
const failureNotifiedPaths = new Set<string>();

/**
 * The one Windows ACL application for this run (it spawns icacls + PowerShell,
 * so once is enough), memoised as a promise rather than a boolean, and
 * resolving to whether the application actually SUCCEEDED.
 *
 * A boolean latch has to be set BEFORE the await, which leaves a window where a
 * second caller sees "done" and proceeds against a DACL still being rewritten.
 * With one call site that window was unobservable; the sweep (#1433) is a second
 * one. Memoising makes "once per run" mean once-and-settled.
 *
 * The stored promise is the wrapper below, which catches internally and can
 * therefore NEVER reject. That is load-bearing, not defensive: a stored rejected
 * promise would deliver its rejection to every awaiter, and the awaiter that
 * matters is `snapshotBeforeFirstWrite` — its outer catch would return "failed",
 * toast the user, and leave `snapshottedPaths` unset, so every 60s autosave
 * would retry and re-fail. That inverts this module's best-effort contract, in
 * which an ACL failure is hygiene the save never hears about.
 *
 * It resolves to a boolean rather than void because the sweep reports the
 * outcome to the user: `icacls` can fail (or `assertNoBroadAce` can reject its
 * result), and a log line claiming a repair that never happened is worse than
 * no log line at all.
 */
let aclPromise: Promise<boolean> | null = null;

/** Test-only: reset the per-run gate and notification/ACL latches. */
export function _resetDocBackupGateForTests(): void {
  snapshottedPaths.clear();
  sizeCapNotified = false;
  failureNotifiedPaths.clear();
  aclPromise = null;
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

/**
 * Create the doc-backups root and apply its restrictive Windows DACL, at most
 * once per server run.
 *
 * Best-effort by design: snapshots hold user document content (prose, not
 * tokens), so unlike `integrations/backup.ts` an ACL failure keeps the backup
 * — an existing backup beats no backup. `setRestrictiveAcl` spawns
 * icacls/whoami, hence the once-per-run latch rather than once-per-path.
 *
 * `inheritable` is load-bearing, not cosmetic: the ACL lands on the ROOT while
 * snapshots are written into per-path SUBDIRs, and the default grant strips
 * those subdirs to an EMPTY, deny-everyone DACL (#1299 — full mechanism in
 * `setRestrictiveAcl`'s docblock). It bit the first path snapshotted per
 * install, which on a fresh install is always the auto-opened `welcome.md`.
 * The inheritable grant also REPAIRS subdirs already poisoned by the old
 * behaviour — re-running icacls propagates the new ACE down to them.
 */
async function ensureBackupRootHardened(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await ensureBackupRootAcl(root);
}

/**
 * What the ACL application for this run actually did, from this caller's view.
 *
 * The sweep needs all four for its log line, and the distinctions are about not
 * lying to the user: `repaired` vs `already-repaired` stops every poisoned
 * subdir after the first from claiming its own repair, and `repair-failed`
 * stops us reporting a repair at all when `icacls` is itself what is broken —
 * which is a live possibility on the very installs this path exists for.
 */
type AclRepairOutcome =
  /** This call applied the ACL, and it succeeded. */
  | "repaired"
  /** An earlier call this run applied it successfully; this one only awaited. */
  | "already-repaired"
  /** The ACL application ran and FAILED (this call's or an earlier one's). */
  | "repair-failed"
  /** Not Windows — there is no ACL to apply and nothing was done. */
  | "unsupported";

/**
 * Apply the backup root's restrictive Windows DACL, at most once per run, and
 * wait for it to settle. Does NOT create the root — callers that need it created
 * use `ensureBackupRootHardened`; the sweep deliberately must not create a root
 * that does not exist.
 *
 * Never rejects (see `aclPromise`). Latches on ATTEMPT rather than on success,
 * matching the boolean it replaces: a failing icacls that we retried on every
 * poisoned subdir would spawn subprocesses in a loop for no gain.
 */
async function ensureBackupRootAcl(root: string): Promise<AclRepairOutcome> {
  if (process.platform !== "win32") return "unsupported";
  const startedHere = aclPromise === null;
  // `??=` assigns synchronously, before any await, so concurrent callers share
  // one application instead of racing two.
  aclPromise ??= (async () => {
    try {
      await setRestrictiveAcl(root, { inheritable: true });
      return true;
    } catch (aclErr) {
      console.error("[DocBackup] Restrictive ACL on backup root failed (continuing):", aclErr);
      return false;
    }
  })();
  const applied = await aclPromise;
  if (!applied) return "repair-failed";
  return startedHere ? "repaired" : "already-repaired";
}

/**
 * A directory refusing to be read because of its permissions — which for the
 * #1299 empty-DACL case is Windows `EPERM` (`scandir`), not the POSIX `EACCES`
 * spelling. Both are accepted; only the Windows one is repairable.
 */
function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES";
}

/**
 * Log a directory the sweep still cannot read after trying to repair it.
 *
 * Deliberately drops the stack for the repairable case: an unrepairable folder
 * prints this on EVERY boot, and a stack trace per boot is exactly the noise
 * that trains people to ignore startup errors (#1433). Where no repair was
 * possible (POSIX, or a non-permission error) the full error object is kept —
 * there the stack is the only diagnostic there is.
 */
function logUnreadable(dir: string, err: unknown, repair: AclRepairOutcome): void {
  const code = (err as NodeJS.ErrnoException).code;
  switch (repair) {
    case "repaired":
      console.error(
        `[DocBackup] sweep: ${dir} is still unreadable after repairing folder permissions (${code}) — skipping it`,
      );
      break;
    case "already-repaired":
      console.error(
        `[DocBackup] sweep: ${dir} is unreadable (${code}); folder permissions were already repaired once this run — skipping it`,
      );
      break;
    case "repair-failed":
      console.error(
        `[DocBackup] sweep: ${dir} is unreadable (${code}) and its folder permissions could not be repaired — skipping it`,
      );
      break;
    default:
      console.error(`[DocBackup] sweep: failed to read ${dir}:`, err);
  }
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

/**
 * Total size in bytes of regular files in the per-path subdirs directly under
 * the doc-backups root (fixed two-level walk: root → hash-subdirs → files —
 * this module never nests deeper).
 */
async function totalTreeBytes(root: string): Promise<number> {
  let total = 0;
  let subdirs: Dirent[];
  try {
    subdirs = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    // ENOENT = first run, root not created yet. Anything else (EACCES, EIO)
    // means the cap fails open — log it so the eventual mkdir failure has a
    // first-symptom trail.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[DocBackup] totalTreeBytes: failed to read backup root:", err);
    }
    return 0;
  }
  for (const sub of subdirs) {
    if (!sub.isDirectory()) continue;
    const subPath = path.join(root, sub.name);
    let files: Dirent[];
    try {
      files = await fs.readdir(subPath, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[DocBackup] totalTreeBytes: failed to read ${subPath}:`, err);
      }
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

/** One restorable snapshot, as surfaced to the restore tool / API (#1086). */
export interface DocBackupSnapshot {
  /** Snapshot filename inside the per-path subdir — pass back to restore it. */
  name: string;
  /** Snapshot file mtime as ISO 8601 (when the snapshot was taken). */
  timestamp: string;
  /** Snapshot size in bytes. */
  size: number;
}

/**
 * List the restorable snapshots for `filePath`, newest first, with timestamps
 * and sizes. Returns an empty array when the path has no backup subdir.
 *
 * Ordered by mtime, NOT filename: the name's timestamp segment is
 * second-granular, so two snapshots taken in the same second (e.g. a restore's
 * pre-overwrite snapshot landing right after the original) tie lexicographically
 * and fall to the random uuid8 — which can rank the older file "newest". mtime
 * carries millisecond resolution; the name is only the deterministic tiebreak.
 */
export async function listDocBackups(
  filePath: string,
  appDataDir: string,
): Promise<DocBackupSnapshot[]> {
  const subdir = path.join(docBackupsRoot(appDataDir), docHash(filePath));
  const names = await listSnapshots(subdir);
  const out: Array<DocBackupSnapshot & { mtimeMs: number }> = [];
  for (const name of names) {
    try {
      const st = await fs.stat(path.join(subdir, name));
      out.push({
        name,
        timestamp: new Date(st.mtimeMs).toISOString(),
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      // Raced away (concurrent prune/sweep) — skip the entry.
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return out.map(({ name, timestamp, size }) => ({ name, timestamp, size }));
}

/**
 * Resolve a caller-supplied snapshot name to its absolute path under
 * `filePath`'s backup subdir, or null when the name is not a plausible
 * snapshot filename. The bare-basename + tail-regex check is the traversal
 * boundary: separators, `..`, `source.txt`, and arbitrary names can never
 * resolve, so the returned path always points inside the per-path subdir at
 * a file this module wrote.
 */
export function docBackupSnapshotPath(
  filePath: string,
  appDataDir: string,
  name: string,
): string | null {
  if (name !== path.basename(name) || !SNAPSHOT_TAIL_RE.test(name)) return null;
  return path.join(docBackupsRoot(appDataDir), docHash(filePath), name);
}

/**
 * Human cause clause for a snapshot failure, keyed on errno. Deliberately
 * NOT the raw `err.message`: Node's fs errors serialize as
 * `EPERM: operation not permitted, open 'C:\\Users\\<name>\\AppData\\...'`,
 * which is stack-trace-shaped in a toast, leaks the user's account name and
 * an internal implementation path they have no reason to see, and tells them
 * nothing they can act on (#1299).
 *
 * Unmapped codes contribute no clause rather than a guess — the errno still
 * travels on the notification's `errorCode`, and the full error object is on
 * stderr for diagnostics.
 */
export function describeSnapshotFailure(err: unknown): string {
  switch ((err as NodeJS.ErrnoException | undefined)?.code) {
    case "EPERM":
    case "EACCES":
      return "Tandem does not have permission to write to its backup folder — antivirus or folder-permission software may be blocking it.";
    case "ENOSPC":
      return "There is no free disk space for the backup.";
    case "EROFS":
      return "The backup location is read-only.";
    case "EBUSY":
    case "ETXTBSY":
      return "The document is locked by another program.";
    case "EMFILE":
    case "ENFILE":
      return "Too many files are open on this system.";
    case "ENAMETOOLONG":
      return "The backup file path is too long for this filesystem.";
    default:
      return "";
  }
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
 * TOCTOU note: the read shares the existing save path's window. In
 * `saveDocumentToDisk` the external-mtime guard runs before it; in
 * `saveDocumentAsToDisk` and `convertToMarkdown` there is no mtime guard, but
 * those writes already clobbered a racing external writer before this module
 * existed. An external writer racing the read was a hazard at every call site
 * already — nothing new is introduced.
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

    // Position is load-bearing: harden BEFORE anything READS the tree, not
    // merely before the write. A poisoned subdir's empty DACL denies `readdir`
    // (`EPERM … scandir`) exactly as it denies `open`, so with hardening any
    // later than this `listSnapshots` below rethrows and the repair is never
    // reached — leaving the one document the bug always claims permanently
    // broken. This line is what makes the inheritable grant an actual repair
    // rather than a fix for fresh installs only.
    await ensureBackupRootHardened(root);

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
          // Past tense on the observation, future on the consequence — and the
          // consequence is the load-bearing half. `sizeCapNotified` latches for
          // the process and the `dedupKey` dedupes on top, so this fires EXACTLY
          // ONCE per run, while the cap is re-checked on every snapshot: every
          // document touched afterwards is overwritten with no pre-write copy.
          // An earlier draft past-tensed the whole sentence and reported that as
          // a singular "a backup was skipped", which reads as a resolved one-off
          // and invites a dismiss. See `TandemNotification.severity`: past tense
          // for what happened, future for what remains true.
          message:
            "A document backup was skipped: the backup folder had reached its size limit. " +
            "Further backups will be skipped until it shrinks, so documents may be " +
            "overwritten without a snapshot. Older backups are removed automatically after 30 days.",
          dedupKey: "doc-backup:size-cap",
          timestamp: Date.now(),
        });
      }
      console.error(
        `[DocBackup] Size cap reached (${maxTotalBytes} bytes) — skipping snapshot of ${filePath}`,
      );
      return "skipped-size-cap";
    }

    // 0o700 mode on the per-path subdir. Windows ignores it; the root's
    // inheritable DACL (see `ensureBackupRootHardened`) is what covers this
    // directory there, and it is already in force by the time we get here.
    await fs.mkdir(subdir, { recursive: true, mode: 0o700 });

    // `wx` exclusive-create: a pre-planted symlink or colliding name fails the
    // open instead of following it. UUID suffix makes the path unpredictable.
    const snapshotName = snapshotFilename(filePath);
    const snapshotPath = path.join(subdir, snapshotName);
    try {
      await fs.writeFile(snapshotPath, original, { flag: "wx", mode: 0o600 });
    } catch (writeErr) {
      // Remove any partial file so it never counts as a valid snapshot.
      // Best-effort: if the cleanup itself fails, the partial survives until
      // a later prune; writeErr below is the error the caller needs to see.
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
        .catch((err) => console.error("[DocBackup] prune failed for %s:", name, err));
    }

    snapshottedPaths.add(pathKey);
    // A success after earlier failures re-arms the notification: if the path
    // starts failing again later (disk refilled, ACL changed), notify anew.
    failureNotifiedPaths.delete(pathKey);
    console.error(`[DocBackup] Snapshotted ${path.basename(filePath)} -> ${snapshotPath}`);
    return "written";
  } catch (err) {
    // Gate stays unset — the next save retries. The console line fires on
    // every retry; the user-facing notification only once per path until a
    // snapshot succeeds (a 60s autosave would otherwise re-toast each minute).
    console.error("[DocBackup] Snapshot failed for %s (save proceeds):", filePath, err);
    if (!failureNotifiedPaths.has(pathKey)) {
      failureNotifiedPaths.add(pathKey);
      // Worth telling the user about even though the save itself is fine: a
      // silently-absent safety net is worse than a noisy one, because the
      // whole point of snapshots is that you find out you needed one later.
      // But the sentence must not claim the save succeeded — this runs
      // BEFORE the write, which can still fail and raise its own toast.
      const cause = describeSnapshotFailure(err);
      pushNotification({
        id: generateNotificationId(),
        type: "general-error",
        severity: "warning",
        message:
          `Couldn't store a backup copy of "${path.basename(filePath)}". ` +
          `Saving is unaffected.${cause ? ` ${cause}` : ""}`,
        documentId: opts.documentId,
        dedupKey: `doc-backup:${pathKey}`,
        errorCode: (err as NodeJS.ErrnoException | undefined)?.code,
        timestamp: Date.now(),
      });
    }
    return "failed";
  }
}

/**
 * Boot sweep: delete snapshots older than 30 days, then remove empty per-path
 * subdirs. Never throws (caller fires it un-awaited). Callers must gate on
 * `!isStoreReadOnly()` like the orphaned-temp reaper — a read-only peer
 * instance must not race the owner's prune.
 *
 * A directory that refuses to be read because of its permissions is treated as
 * REPAIRABLE, not terminal: the root's inheritable grant is re-applied (once per
 * run) and the read is retried once. This is the #1299 recovery path, which
 * before #1433 hung off `snapshotBeforeFirstWrite` alone — so a run that never
 * saved a document could never reach it, and the sweep logged the same EPERM on
 * every boot with no route to recovery. Best-effort throughout: a folder that is
 * still unreadable after the repair is skipped, never fatal, and the rest of the
 * tree is swept normally.
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
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { cleaned, failed };
    if (!isPermissionError(err)) {
      console.error(`[DocBackup] sweep: failed to read ${root}:`, err);
      return { cleaned, failed };
    }
    // #1299 residue: an empty DACL denies `scandir` exactly as it denies
    // `open`. Re-applying the root's inheritable grant is the repair — the
    // same one the snapshot path has run since v0.21.0. The sweep just never
    // triggered it, so an install that ran without ever saving a document
    // stayed broken and logged this on every boot forever (#1433).
    const repair = await ensureBackupRootAcl(root);
    try {
      subdirs = await fs.readdir(root, { withFileTypes: true });
    } catch (retryErr) {
      // The retry gets its OWN try: this function is fired un-awaited and its
      // contract is "never throws", so an unwrapped retry would convert that
      // into throws-on-one-path, rejecting into the caller's `.catch()`.
      logUnreadable(root, retryErr, repair);
      return { cleaned, failed };
    }
  }

  for (const sub of subdirs) {
    if (!sub.isDirectory()) continue;
    const subPath = path.join(root, sub.name);

    let entries: Dirent[];
    try {
      entries = await fs.readdir(subPath, { withFileTypes: true });
    } catch (err) {
      if (!isPermissionError(err)) {
        console.error(`[DocBackup] sweep: failed to read ${subPath}:`, err);
        continue;
      }
      // The grant lands on the ROOT and Windows propagates it into every
      // non-protected child, so one repair fixes every poisoned subdir — the
      // memo means the first one pays for all of them.
      const repair = await ensureBackupRootAcl(root);
      try {
        entries = await fs.readdir(subPath, { withFileTypes: true });
      } catch (retryErr) {
        logUnreadable(subPath, retryErr, repair);
        continue;
      }
    }

    let liveSnapshots = 0;
    let unstattable = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !SNAPSHOT_TAIL_RE.test(entry.name)) continue;
      const fullPath = path.join(subPath, entry.name);
      let tooOld: boolean;
      try {
        tooOld = nowMs - (await fs.stat(fullPath)).mtimeMs > SWEEP_AGE_MS;
      } catch {
        // Raced away or unreadable — leave it alone, but don't count it as
        // live either: a permanently unstattable entry would otherwise block
        // the empty-dir cleanup below forever.
        unstattable++;
        continue;
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

    if (liveSnapshots === 0 && unstattable === 0) {
      // Only ever removes source.txt + the empty dir — the tail regex above
      // guarantees no unexpected file is in scope (an unstattable snapshot
      // also blocks this branch: deleting source.txt while its snapshot
      // lingers would orphan the bytes from their path metadata), and a
      // plain rmdir on a non-empty dir throws ENOTEMPTY, which is the
      // expected "keep" signal for stray files. Anything else (EACCES,
      // EPERM) is a real problem worth a log line.
      await fs.rm(path.join(subPath, SOURCE_MARKER_FILENAME), { force: true }).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`[DocBackup] sweep: failed to remove source.txt in ${subPath}:`, err);
        }
      });
      await fs.rmdir(subPath).catch((err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") {
          console.error(`[DocBackup] sweep: failed to remove ${subPath}:`, err);
        }
      });
    }
  }

  return { cleaned, failed };
}
