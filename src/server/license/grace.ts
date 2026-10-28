/**
 * The licence grace record (#2231, ADR-040 amendment 2026-10-28).
 *
 * A licence file that is installed but fails its check keeps the AI features
 * on for `LICENSE_GRACE_DAYS` from the FIRST time it failed, so a paying
 * customer whose key breaks (a signing-key change, a damaged file, a schema
 * this build does not know) is never cut off mid-task. This module remembers
 * that first failure.
 *
 * **It is no stronger than the trial clock, and is not meant to be.** All of
 * its state is local and the source is public. Deleting `license-grace.json`,
 * cycling distinct junk licence files (each hashes to a new key), or an
 * app-data directory the record cannot be written to each re-grant a grace,
 * exactly as deleting `trial.json` re-grants a trial. What it does hold
 * against is the casual reset: deleting `license.json` and putting the same
 * bytes back keeps the original date, because the record lives in its own file
 * keyed by the licence's contents, not inside the licence file.
 *
 * Imported by `license-state.ts` alone.
 *
 * **Every export is total.** `resolveLicenseState` runs inside `aiRefusal()`,
 * whose catch fails CLOSED — so a throw from here would refuse a grace user,
 * or (from the clear on the licensed arm) a paying customer. Every filesystem
 * call is caught, and a failure fails toward the user: no record reads as
 * "the first failure is now".
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { licenseGraceFilePath } from "./paths.js";

/**
 * The key a read error that is not ENOENT (an AV or sync-client lock, or a
 * `chmod 000`) records under. A CONSTANT, not "no key": the file's bytes are
 * unknown, and a read error that never records would mean a grace that never
 * ends for anyone who can make the file permanently unreadable.
 */
export const GRACE_KEY_READ_ERROR = "read-error";

/**
 * How much of an unparseable licence file is hashed. The licence read is per
 * dispatch, so the hash is too; a real licence is under 2 KB and this bounds
 * the work for a huge junk file. The length is folded in so two junk files
 * that share a long prefix still key apart.
 */
const RAW_HASH_PREFIX_CHARS = 64 * 1024;

/** Most licence keys remembered at once; the oldest entry is dropped first. */
export const GRACE_MAX_ENTRIES = 8;

/** Same sanity bounds as `trial.json`'s `firstRunAt` (`trialBodyIsUsable`). */
const GRACE_EPOCH_FLOOR_MS = Date.UTC(2020, 0, 1);
const GRACE_FUTURE_SLACK_MS = 86_400_000;

function sha256(text: string): string {
  return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** The record key for a licence file that parsed and carries a `blob`: the blob's hash. */
export function graceKeyForBlob(blob: string): string {
  return sha256(blob);
}

/** The record key for a licence file that read but did not parse: its (bounded) bytes' hash. */
export function graceKeyForRaw(raw: string): string {
  return sha256(`${raw.length}:${raw.slice(0, RAW_HASH_PREFIX_CHARS)}`);
}

interface GraceFile {
  version: 1;
  entries: Record<string, string>;
}

/** The record's entries, or an empty map when it is absent, unreadable or not ours. */
function readEntries(appDataDir: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(licenseGraceFilePath(appDataDir), "utf-8"));
    const entries = (parsed as Partial<GraceFile> | null)?.entries;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(entries)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Can this stored value run a clock? A string that `Date.parse` reads, on or
 * after 2020 and not more than a day ahead of now: a dead RTC writes 1970 or
 * 2015-2016 and must not END a grace on first read, and a far-future value
 * must not EXTEND one forever. `Date.parse` on a string only — `new Date(0)`
 * is a finite 1970.
 */
function usableStart(value: unknown, nowMs: number): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  if (ms < GRACE_EPOCH_FLOOR_MS || ms > nowMs + GRACE_FUTURE_SLACK_MS) return null;
  return ms;
}

/**
 * In-process memory of each first failure, by app-data dir and key.
 *
 * Bounds the grace for the life of the process even when the record cannot
 * be written (an unwritable app-data dir would otherwise read "day 0" on every
 * dispatch), and stops a write being attempted on every dispatch.
 */
const memo = new Map<string, number>();
/** Keys whose write already failed in this process: never retried per dispatch. */
const writeFailed = new Set<string>();
let warnedWrite = false;

function memoKey(appDataDir: string, key: string): string {
  return `${appDataDir}\u0000${key}`;
}

function forgetDir(appDataDir: string): void {
  const prefix = `${appDataDir}\u0000`;
  for (const k of [...memo.keys()]) if (k.startsWith(prefix)) memo.delete(k);
  for (const k of [...writeFailed]) if (k.startsWith(prefix)) writeFailed.delete(k);
}

/** Test-only: forget the in-process memory and the one-shot warning. */
export function _resetGraceMemoForTests(): void {
  memo.clear();
  writeFailed.clear();
  warnedWrite = false;
}

/**
 * The epoch ms this key first failed, or `null` when nothing usable is
 * remembered (the caller reads that as "now" — day 0, as for `trial.json`).
 * The earlier of the record on disk and this process's memory wins.
 */
export function readGraceStart(appDataDir: string, key: string, nowMs: number): number | null {
  return readGraceRecord(appDataDir, key, nowMs).startMs;
}

/**
 * `readGraceStart`, plus whether the record on disk holds a usable date for
 * this key — so the per-dispatch caller writes only when it does not, without
 * reading the file a second time.
 */
export function readGraceRecord(
  appDataDir: string,
  key: string,
  nowMs: number,
): { startMs: number | null; onDisk: boolean } {
  const fromFile = usableStart(readEntries(appDataDir)[key], nowMs);
  const fromMemo = memo.get(memoKey(appDataDir, key));
  const fromMemoUsable = fromMemo !== undefined && Number.isFinite(fromMemo) ? fromMemo : null;
  const onDisk = fromFile !== null;
  if (fromFile === null) return { startMs: fromMemoUsable, onDisk };
  if (fromMemoUsable === null) return { startMs: fromFile, onDisk };
  return { startMs: Math.min(fromFile, fromMemoUsable), onDisk };
}

/**
 * Remember `startMs` as this key's first failure, unless the record on disk
 * already holds a usable date for it. Never throws.
 *
 * The write is a temp file plus a rename, synchronous, owner-only (`0o600`):
 * the stdio and HTTP servers both resolve licence state, and a torn
 * read-modify-write would read back as "no record" and restart the clock.
 * Two processes racing still lose one entry at worst, which fails toward the
 * user like everything else here.
 */
export function recordGraceStart(
  appDataDir: string,
  key: string,
  startMs: number,
  nowMs: number,
): void {
  const mk = memoKey(appDataDir, key);
  const prior = memo.get(mk);
  if (prior === undefined || startMs < prior) memo.set(mk, startMs);
  if (writeFailed.has(mk)) return;

  const entries = readEntries(appDataDir);
  if (usableStart(entries[key], nowMs) !== null) return;

  // Cap: the key being written, plus the newest others by date.
  const others = Object.entries(entries)
    .filter(([k]) => k !== key)
    .sort(([, a], [, b]) => (Date.parse(a) || 0) - (Date.parse(b) || 0))
    .slice(-(GRACE_MAX_ENTRIES - 1));

  const filePath = licenseGraceFilePath(appDataDir);
  const tmp = path.join(
    appDataDir,
    `.license-grace.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    // Inside the try: `toISOString` throws on a Date out of range.
    const iso = new Date(memo.get(mk) ?? startMs).toISOString();
    const body: GraceFile = { version: 1, entries: { ...Object.fromEntries(others), [key]: iso } };
    fs.mkdirSync(appDataDir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    writeFailed.add(mk);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Never created, or already gone.
    }
    if (!warnedWrite) {
      warnedWrite = true;
      console.error(
        "[license] Could not write license-grace.json — the licence grace period is " +
          "remembered for this run only:",
        (err as NodeJS.ErrnoException)?.code ?? String(err),
      );
    }
  }
}

/**
 * Forget every grace record for this app-data dir: on disk and in memory.
 * Called when a licence verifies (so a later, unrelated failure starts a fresh
 * grace rather than inheriting a stale date) and by deactivation. Never
 * throws; `true` when nothing is left on disk.
 */
export function clearGraceRecords(appDataDir: string): boolean {
  forgetDir(appDataDir);
  try {
    fs.unlinkSync(licenseGraceFilePath(appDataDir));
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT";
  }
}

/**
 * Is there anything for `clearGraceRecords` to do? The licensed arm runs per
 * dispatch, so it pays one `existsSync` rather than an `unlink` per call.
 */
export function hasGraceRecords(appDataDir: string): boolean {
  const prefix = `${appDataDir}\u0000`;
  for (const k of memo.keys()) if (k.startsWith(prefix)) return true;
  try {
    return fs.existsSync(licenseGraceFilePath(appDataDir));
  } catch {
    return false;
  }
}
