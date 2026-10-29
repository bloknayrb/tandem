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
 * its state is local and the source is public. #2231 asked that deleting
 * Tandem's own state file must not reset the first-failure date; this design
 * deliberately does NOT meet that (ADR-040 amendment 2026-10-28 says why).
 * Deleting `license-grace.json`, cycling distinct junk licence files (each
 * hashes to a new key), a clock set behind the recorded date, or an app-data
 * directory the record cannot be written to each re-grant a grace, exactly as
 * deleting `trial.json` re-grants a trial. The one reset it does hold against
 * is deleting `license.json` and putting the same bytes back, because the
 * record lives in its own file keyed by the licence's contents.
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
 * Is this stored value a real first-failure date? A string that `Date.parse`
 * reads, on or after 2020: a dead RTC writes 1970 or 2015-2016, and such a
 * value is junk that a later write may replace. `Date.parse` on a string only
 * — `new Date(0)` is a finite 1970. Says nothing about NOW: a plausible date
 * can still be ahead of a clock that is running behind.
 */
function plausibleStart(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < GRACE_EPOCH_FLOOR_MS) return null;
  return ms;
}

/**
 * Can this stored value run a clock NOW? A plausible date not more than a day
 * ahead of now: a dead-RTC date must not END a grace on first read, and a
 * far-future value must not EXTEND one.
 *
 * A plausible date that is merely ahead of now is not used, but it is never
 * overwritten either (`recordGraceStart`): the likelier cause is a clock that
 * has fallen behind (a CMOS reset to a firmware date), and replacing the real
 * date with the behind-clock "now" would end a paying customer's grace the
 * moment the clock is corrected.
 */
function usableStart(value: unknown, nowMs: number): number | null {
  const ms = plausibleStart(value);
  if (ms === null || ms > nowMs + GRACE_FUTURE_SLACK_MS) return null;
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
 * A usable date on disk wins; this process's memory stands in only when the
 * disk has none (an unwritable record, a record deleted mid-process, or a
 * stored date ahead of a clock that is running behind). The memory must not
 * win over a usable disk date: during a behind clock it holds that clock's
 * "now", which is EARLIER than the real first failure, and preferring it once
 * the clock is corrected would end the grace at once. Where the two disagree
 * otherwise (the record deleted and re-created by another process), the disk's
 * later date fails toward the user.
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
  return { startMs: fromFile ?? fromMemoUsable, onDisk };
}

/**
 * Remember `startMs` as this key's first failure, unless the record on disk
 * already holds a plausible date for it (on or after 2020 — even one ahead of
 * now, see `usableStart`). Only an absent, unparseable or pre-2020 entry is
 * written. Never throws.
 *
 * The write is a temp file plus a rename, synchronous, owner-only (`0o600`):
 * the stdio and HTTP servers both resolve licence state, and a torn
 * read-modify-write would read back as "no record" and restart the clock.
 * Two processes racing still lose one entry at worst, which fails toward the
 * user like everything else here.
 */
export function recordGraceStart(appDataDir: string, key: string, startMs: number): void {
  const mk = memoKey(appDataDir, key);
  const prior = memo.get(mk);
  if (prior === undefined || startMs < prior) memo.set(mk, startMs);
  if (writeFailed.has(mk)) return;

  const entries = readEntries(appDataDir);
  if (plausibleStart(entries[key]) !== null) return;

  // Cap: the key being written, plus the newest others by date.
  const others = Object.entries(entries)
    .filter(([k]) => k !== key)
    .sort(([, a], [, b]) => (Date.parse(a) || 0) - (Date.parse(b) || 0))
    .slice(-(GRACE_MAX_ENTRIES - 1));

  sweepOrphanedTemps(appDataDir);
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
 * Exactly the temp names `recordGraceStart` writes, and nothing else: this
 * regex is the sweep's safety boundary, since it runs in the app-data root.
 */
const ORPHAN_TEMP_RE = /^\.license-grace\.\d+\.[0-9a-f]{8}\.tmp$/;
/** Old enough that no live write can still own it (a write is one sync call). */
const ORPHAN_TEMP_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Remove `.license-grace.*.tmp` files a crash between write and rename left
 * behind. The boot reaper sweeps `annotations/` and `sessions/` only, so this
 * module cleans up after itself, best-effort, whenever it writes or clears the
 * record. The age gate keeps it off another process's in-flight temp file.
 * Never throws.
 */
function sweepOrphanedTemps(appDataDir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(appDataDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - ORPHAN_TEMP_MIN_AGE_MS;
  for (const name of names) {
    if (!ORPHAN_TEMP_RE.test(name)) continue;
    const p = path.join(appDataDir, name);
    try {
      const st = fs.lstatSync(p);
      if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(p);
    } catch {
      // Gone already, or not ours to remove.
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
  sweepOrphanedTemps(appDataDir);
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
