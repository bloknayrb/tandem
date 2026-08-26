/**
 * Bounded, asynchronous health scan of the on-disk annotation store.
 *
 * **Why this is a scan and not a sample, and why that is not a regression in
 * bounded work.** The check this replaces read at most one file *in the healthy
 * case only*: its parse was gated on `sampleSchemaVersion === null`, and a file
 * that failed to parse — or simply carried no numeric `schemaVersion` — left
 * that null, so the loop went on to read and parse the next one. A store whose
 * active files are all unparseable therefore already performed a full,
 * unbounded, synchronous read of every file. The worst case being fixed here is
 * the one that already existed; what is new is that it now has a ceiling.
 *
 * That settles the conflict the remediation plan flagged (its "the two asks in
 * Unit 12 conflict" note). Counting malformed active envelopes and bounding
 * request-led work only *look* opposed if you assume today's cost is one read.
 * It is not, so the bounded full scan is a strict improvement on both axes: it
 * answers the question the check exists to answer — *will my annotations
 * load?* — which sampling structurally cannot, and it is the first version of
 * this code with any cap at all.
 *
 * **The verdict comes from the loader's own predicate, `parseAnnotationDoc`.**
 * Re-deriving a lighter "looks like JSON" test here would answer a different
 * question than the one the user cares about and would drift from the loader
 * the moment the schema moves. The cost is that `parseAnnotationDoc` logs its
 * own reason to stderr per failing file, without naming the file — so this
 * module carries a bounded sample of offending filenames in its result, which
 * is the half the loader's logging cannot supply.
 *
 * **What is NOT bounded: the directory listing itself.** One `readdir` returns
 * every entry, and there is no bounded alternative that also yields an honest
 * total. That is a single syscall and unchanged from before; the hazard being
 * fixed is the per-file `stat`/`read`/`parse` fan-out, which is capped here by
 * file count, per-file size, and a total byte budget.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseAnnotationDoc } from "../server/annotations/schema.js";
import { rejectUnsafeWindowsPrefix } from "../shared/windows-path-safety.js";

/**
 * Most active `<hash>.json` files examined in one scan.
 *
 * One file per document ever opened against this app-data dir — there is no
 * population cap on the writer side (`src/server/annotations/store.ts`), so a
 * long-lived install accumulates indefinitely. 512 is far above any plausible
 * real store and still bounds the fan-out.
 */
export const ANNOTATION_SCAN_MAX_FILES = 512;

/**
 * Largest single file read. `tests/server/annotations/perf.test.ts` exercises
 * 5,000 annotations in one doc, which lands around 3 MB; 8 MiB clears that with
 * room and turns anything past it into a reported `oversize` rather than a read.
 */
export const ANNOTATION_SCAN_MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Total bytes read across the whole scan, whichever cap is reached first. */
export const ANNOTATION_SCAN_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Files sampled into the result for the operator to go look at. */
export const ANNOTATION_SCAN_MAX_SAMPLE_NAMES = 5;

/**
 * Why one file could not be used.
 *
 * Carried in the result rather than left to `parseAnnotationDoc`'s stderr,
 * because the consumers that most need it never see stderr: `doctor --json`,
 * the `tandem_diagnostics` MCP tool, and `/api/diagnostics` all return the
 * structured report alone. "Five files are unreadable" is a different problem
 * from "five files are permission-denied", and only one of them is the user's
 * to fix.
 */
export type UnreadableReason = "io-error" | "not-json" | "invalid-envelope" | "validator-threw";

export interface UnreadableFile {
  name: string;
  reason: UnreadableReason;
  /** errno for `io-error`; absent otherwise. */
  code?: string;
}

/** Why a scan stopped short of examining every active file. */
export type ScanLimit = "files" | "bytes";

/** Test-only cap overrides. See {@link scanAnnotationStore}. */
export interface ScanLimits {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface AnnotationStoreCounts {
  /** Active `<hash>.json` files present in the listing — the full count, not the examined count. */
  docCount: number;
  /** Active files actually stat'd and (unless oversize) read. `<= docCount`. */
  examined: number;
  /**
   * Sum of `stat().size` over examined files, including oversize ones. This is
   * the store's reported footprint, NOT the scan's read budget — the two are
   * separate accumulators on purpose, because an oversize file contributes its
   * whole size to the footprint while contributing zero bytes read.
   */
  totalBytes: number;
  /** Examined active files the loader would refuse: unparseable, wrong shape, or unreadable. */
  unreadableActive: number;
  /** Examined active files carrying a `schemaVersion` newer than this build understands. */
  futureActive: number;
  /** Examined active files skipped because they exceed {@link ANNOTATION_SCAN_MAX_FILE_BYTES}. */
  oversize: number;
  /** Already-quarantined `<hash>.json.corrupt.<ts>` files (filename filter, no read). */
  quarantined: number;
  /** Already-parked `<hash>.json.future` files (filename filter, no read). */
  parkedFuture: number;
  /** Up to {@link ANNOTATION_SCAN_MAX_SAMPLE_NAMES} unreadable active files, with reasons. */
  unreadableSample: UnreadableFile[];
  /**
   * Active files that disappeared between the listing and the read.
   *
   * Benign and expected — the store rewrites constantly, and quarantining an
   * unloadable file is itself a `rename`, so a file doctor is mid-way through
   * examining can legitimately stop existing under that name. Counted rather
   * than dropped because otherwise it is the one failure that leaves no trace
   * anywhere in the report, and it is also the only honest explanation for
   * `examined < docCount` on a scan that reports itself complete.
   */
  vanished: number;
  /** First `schemaVersion` observed on any examined file, parseable or not. */
  schemaVersion: number | null;
  /** Most recently modified active file. */
  newest: { name: string; mtimeMs: number } | null;
}

/**
 * Outcome of one scan. Tagged rather than "counts plus an error string" so a
 * caller cannot read a zeroed count bag as a healthy store — the shape that
 * let the previous check report PASS over a directory it never opened.
 */
export type AnnotationStoreScan =
  | { kind: "unsafe-path"; reason: string }
  | { kind: "absent" }
  | { kind: "unreadable-dir"; error: string }
  | ({ kind: "scanned"; scan: "complete" } & AnnotationStoreCounts)
  | ({ kind: "scanned"; scan: "incomplete"; limit: ScanLimit } & AnnotationStoreCounts);

/**
 * Fill in the production caps for anything the caller left unset.
 *
 * Exported so the wiring is testable, which the constants alone are not: a
 * default written as a stray literal instead of its constant leaves every
 * exported value correct and every cap test — which passes explicit overrides
 * to stay fast — green. Pinning this function is what catches that.
 */
export function resolveScanLimits(limits: ScanLimits = {}): Required<ScanLimits> {
  return {
    maxFiles: limits.maxFiles ?? ANNOTATION_SCAN_MAX_FILES,
    maxFileBytes: limits.maxFileBytes ?? ANNOTATION_SCAN_MAX_FILE_BYTES,
    maxTotalBytes: limits.maxTotalBytes ?? ANNOTATION_SCAN_MAX_TOTAL_BYTES,
  };
}

/** Active store files: `<hash>.json`. Quarantined and parked names do not end in `.json`. */
function isActiveFile(name: string): boolean {
  return name.endsWith(".json") && !name.includes(".corrupt.");
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A file that vanished between `readdir` and the call that touched it. The
 * store rewrites and renames constantly, so this is an ordinary race and not a
 * health finding — every other failure is a file the loader would also refuse.
 */
function isBenignRace(err: unknown): boolean {
  return errCode(err) === "ENOENT";
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

/**
 * Scan `dir` for annotation-store health.
 *
 * Screens `dir` for hostile Windows prefixes **before the first syscall**. That
 * ordering is the whole point and is asserted directly
 * (`tests/cli/doctor-path-safety.test.ts`): reading a UNC path on Windows
 * performs the SMB handshake that leaks an NTLM hash, so a guard that runs
 * after `readdir` has already lost. The caller screens the raw app-data inputs
 * as well — see {@link resolveAppDataDir} in `doctor.ts` — because `posix.join`
 * neutralises the four pure forward-slash spellings, which would leave a
 * derived-path-only guard passing on Linux for the wrong reason (#1529).
 */
export async function scanAnnotationStore(
  dir: string,
  /**
   * Cap overrides, for tests only. Production passes nothing — a caller that
   * could raise these would defeat the bound, and a test that had to write 512
   * real files to reach the file cap would be slow enough that nobody keeps it.
   * `scanDefaultsMatchExportedCaps` in the suite pins the defaults separately,
   * so shrinking a cap here cannot hide a wrong constant.
   */
  limits: ScanLimits = {},
): Promise<AnnotationStoreScan> {
  const { maxFiles, maxFileBytes, maxTotalBytes } = resolveScanLimits(limits);

  const unsafe = rejectUnsafeWindowsPrefix(dir);
  if (unsafe !== null) return { kind: "unsafe-path", reason: unsafe };

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable-dir", error: errMsg(err) };
  }

  const active = entries.filter(isActiveFile);
  const counts: AnnotationStoreCounts = {
    docCount: active.length,
    examined: 0,
    totalBytes: 0,
    unreadableActive: 0,
    futureActive: 0,
    oversize: 0,
    quarantined: entries.filter((f) => f.includes(".corrupt.")).length,
    parkedFuture: entries.filter((f) => f.endsWith(".json.future")).length,
    unreadableSample: [],
    vanished: 0,
    schemaVersion: null,
    newest: null,
  };

  let limit: ScanLimit | null = null;
  let bytesRead = 0;
  for (const name of active) {
    if (counts.examined >= maxFiles) {
      limit = "files";
      break;
    }
    if (bytesRead >= maxTotalBytes) {
      limit = "bytes";
      break;
    }

    const path = join(dir, name);
    let size: number;
    let mtimeMs: number;
    try {
      const s = await stat(path);
      size = s.size;
      mtimeMs = s.mtimeMs;
    } catch (err) {
      if (isBenignRace(err)) counts.vanished++;
      else recordUnreadable(counts, name, "io-error", errCode(err));
      continue;
    }

    counts.examined++;
    counts.totalBytes += size;
    if (counts.newest === null || mtimeMs > counts.newest.mtimeMs) {
      counts.newest = { name, mtimeMs };
    }

    // Oversize is reported, never read. Reading it is exactly the unbounded
    // work this scan exists to cap, and its own size is the finding.
    if (size > maxFileBytes) {
      counts.oversize++;
      continue;
    }

    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
      bytesRead += size;
    } catch (err) {
      // The file was stat'd but never opened, so it is examined-but-unvalidated
      // either way. A vanished one is the quarantine rename racing this scan.
      if (isBenignRace(err)) counts.vanished++;
      else recordUnreadable(counts, name, "io-error", errCode(err));
      continue;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      recordUnreadable(counts, name, "not-json");
      continue;
    }

    // Read the version off the raw object rather than the parse result: a
    // future-schema file is refused by the loader but its version number is
    // the single most useful thing to show an operator who just downgraded.
    const declared = (parsedJson as { schemaVersion?: unknown } | null)?.schemaVersion;
    if (counts.schemaVersion === null && typeof declared === "number") {
      counts.schemaVersion = declared;
    }

    // Wrapped even though `parseAnnotationDoc` returns a tagged result and
    // contains its own migration failures today. Every other fallible step in
    // this loop is contained per file; leaving one uncontained means a future
    // migration that throws on some malformed-but-parseable input takes the
    // WHOLE check down — `Recorder.check` turns it into a bare "crashed" line
    // and the scan's findings for every other file are lost with it. One bad
    // file should cost one bad file.
    let result: ReturnType<typeof parseAnnotationDoc>;
    try {
      result = parseAnnotationDoc(parsedJson);
    } catch {
      recordUnreadable(counts, name, "validator-threw");
      continue;
    }
    if (result.ok) continue;
    if (result.error === "future") counts.futureActive++;
    else recordUnreadable(counts, name, "invalid-envelope");
  }

  return limit === null
    ? { kind: "scanned", scan: "complete", ...counts }
    : { kind: "scanned", scan: "incomplete", limit, ...counts };
}

function recordUnreadable(
  counts: AnnotationStoreCounts,
  name: string,
  reason: UnreadableReason,
  code?: string,
): void {
  counts.unreadableActive++;
  if (counts.unreadableSample.length < ANNOTATION_SCAN_MAX_SAMPLE_NAMES) {
    counts.unreadableSample.push(code === undefined ? { name, reason } : { name, reason, code });
  }
}
