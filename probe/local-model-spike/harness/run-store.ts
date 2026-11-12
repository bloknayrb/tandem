/**
 * A run on disk: one directory per run, under the gitignored `runs/`.
 *
 *   identity.json   what was measured, on what, and each session that ran it
 *   trials.jsonl    one line per SCORED trial (never rewritten, only appended)
 *   infra.jsonl     one line per attempt that ended in an infrastructure error
 *   fixtures.json   each document's flat text exactly as the trials' model saw
 *                   it, with its SHA-256; the reading file and the report use
 *                   these, never the checkout's fixtures
 *   lock            the process writing this run
 *
 * Imports nothing from `src/`, so an entry script can use it before the
 * app-data directory is pointed at the run.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isSafeRunId } from "./paths.js";

export type RunMode = "full" | "screen";

/** Consecutive trials with nothing scorable after which a run stops itself (see `runner.ts`). */
export const MAX_CONSECUTIVE_INFRASTRUCTURE = 3;

/** The fields a resume must find unchanged. */
export interface RunIdentityKey {
  commit: string;
  modelDigest: string;
  ollamaVersion: string;
  fingerprint: string;
  tier: "chat" | "editing";
  mode: RunMode;
  repeats: number;
  scenarioSetHash: string;
  includeExtended: boolean;
}

/** Recorded again at every start: these may differ between sessions of one run. */
export interface RunSession {
  startedAt: string;
  dirty: boolean | "unknown";
  hardware: string;
  contextLength: number | "unknown";
  serverSettings: Record<string, string> | "unknown";
  toolSupport: "yes" | "unknown";
  host: string;
}

export interface RunIdentity extends RunIdentityKey {
  runId: string;
  modelTag: string;
  endpoint: string;
  sessions: RunSession[];
}

export const UNKNOWN = "unknown";

/**
 * Lines of a JSONL file that could not be parsed. Only the LAST line may be
 * torn (a process killed mid-append; that trial was not recorded, so it is
 * simply run again). Any other unreadable line was a recorded trial that has
 * been damaged since, and a reader of the file must say so, not drop it quietly.
 */
export interface JsonLines<T> {
  records: T[];
  /** 1-based line numbers of unreadable lines that are not the last line. */
  damaged: number[];
}

export function readJsonLinesChecked<T>(file: string): JsonLines<T> {
  if (!fs.existsSync(file)) return { records: [], damaged: [] };
  const records: T[] = [];
  const damaged: number[] = [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === "") last -= 1;
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      if (i !== last) damaged.push(i + 1);
    }
  });
  return { records, damaged };
}

function readJsonLines<T>(file: string): T[] {
  return readJsonLinesChecked<T>(file).records;
}

export function identityPath(runDir: string): string {
  return path.join(runDir, "identity.json");
}
export function trialsPath(runDir: string): string {
  return path.join(runDir, "trials.jsonl");
}
export function infraPath(runDir: string): string {
  return path.join(runDir, "infra.jsonl");
}
export function lockPath(runDir: string): string {
  return path.join(runDir, "lock");
}
export function fixturesPath(runDir: string): string {
  return path.join(runDir, "fixtures.json");
}

export function readIdentity(runDir: string): RunIdentity {
  return JSON.parse(fs.readFileSync(identityPath(runDir), "utf8")) as RunIdentity;
}

export function writeIdentity(runDir: string, identity: RunIdentity): void {
  fs.writeFileSync(identityPath(runDir), `${JSON.stringify(identity, null, 2)}\n`, "utf8");
}

export function readTrials<T>(runDir: string): T[] {
  return readJsonLines<T>(trialsPath(runDir));
}
export function readInfra<T>(runDir: string): T[] {
  return readJsonLines<T>(infraPath(runDir));
}

/**
 * Unreadable lines in the run's logs that are not a torn last line, in words.
 * The report counts each as a reason the run cannot be judged.
 */
export function damagedLogLines(runDir: string): string[] {
  const out: string[] = [];
  for (const [name, file] of [
    ["trials.jsonl", trialsPath(runDir)],
    ["infra.jsonl", infraPath(runDir)],
  ] as const) {
    const { damaged } = readJsonLinesChecked<unknown>(file);
    if (damaged.length > 0) out.push(`${name} has unreadable line(s) ${damaged.join(", ")} that are not a torn last line`);
  }
  return out;
}

// --- the documents the model saw --------------------------------------------

export interface StoredFixture {
  sha256: string;
  text: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function readFixtures(runDir: string): Record<string, StoredFixture> {
  const file = fixturesPath(runDir);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, StoredFixture>;
}

/**
 * Record a document's flat text the first time a trial on it is scored. The
 * first text stored for a key is kept: a later trial on different text keeps
 * its own `documentHash`, and `fixtureProblems` then refuses the run.
 */
export function storeFixture(runDir: string, key: string, text: string): void {
  const all = readFixtures(runDir);
  if (all[key] !== undefined) return;
  all[key] = { sha256: sha256(text), text };
  const tmp = `${fixturesPath(runDir)}.tmp-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, fixturesPath(runDir));
}

/**
 * Why the stored documents cannot be shown to be the ones each trial ran on,
 * or [] when every trial's `documentHash` names a stored text that still
 * hashes to it. `read.ts` and `report.ts` refuse a run with any problem.
 */
export function fixtureProblems(
  stored: Record<string, StoredFixture>,
  trials: { trialId: string; fixture: string; documentHash?: string }[],
): string[] {
  const out: string[] = [];
  for (const [key, f] of Object.entries(stored)) {
    if (typeof f?.text !== "string" || sha256(f.text) !== f.sha256) {
      out.push(`fixtures.json: the stored text of ${JSON.stringify(key)} does not match its own hash`);
    }
  }
  for (const t of trials) {
    const f = stored[t.fixture];
    if (f === undefined) {
      out.push(`trial ${t.trialId}: its document ${JSON.stringify(t.fixture)} is not stored in fixtures.json`);
    } else if (t.documentHash !== f.sha256) {
      out.push(`trial ${t.trialId}: ran on a different text of ${JSON.stringify(t.fixture)} than the one stored`);
    }
  }
  return out;
}
/**
 * Append one record as one line. If a killed process left the file ending in
 * half a line, start a new line first: otherwise this record would be glued
 * onto the fragment and lost with it.
 */
function appendLine(file: string, record: unknown): void {
  let lead = "";
  if (fs.existsSync(file)) {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, "r");
      try {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) lead = "\n";
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  fs.appendFileSync(file, `${lead}${JSON.stringify(record)}\n`, "utf8");
}
export function appendTrial(runDir: string, record: unknown): void {
  appendLine(trialsPath(runDir), record);
}
export function appendInfra(runDir: string, record: unknown): void {
  appendLine(infraPath(runDir), record);
}

/**
 * The directory of an EXISTING run named on the command line. The id must be a
 * single safe segment and must name a directory that really sits directly
 * under `runsDir` (so a link cannot point a resume somewhere else).
 */
export function existingRunDir(runId: string, runsDir: string): string {
  if (!isSafeRunId(runId)) throw new Error(`not a run id: ${JSON.stringify(runId)}`);
  const dir = path.join(runsDir, runId);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`no such run: ${runId}`);
  }
  if (fs.realpathSync(path.dirname(fs.realpathSync(dir))) !== fs.realpathSync(runsDir)) {
    throw new Error(`run ${runId} is not directly inside the runs directory`);
  }
  return dir;
}

/** Why a resume is refused, or null when the stored run matches. */
export function resumeRefusal(stored: RunIdentityKey, now: RunIdentityKey): string | null {
  if (stored.modelDigest === UNKNOWN || now.modelDigest === UNKNOWN) {
    return "the model digest is unknown, so this run cannot be shown to be the same model";
  }
  const fields: (keyof RunIdentityKey)[] = [
    "commit",
    "modelDigest",
    "ollamaVersion",
    "fingerprint",
    "tier",
    "mode",
    "repeats",
    "scenarioSetHash",
    "includeExtended",
  ];
  const changed = fields.filter((f) => stored[f] !== now[f]);
  if (changed.length === 0) return null;
  return `these differ from the stored run: ${changed
    .map((f) => `${f} (was ${JSON.stringify(stored[f])}, now ${JSON.stringify(now[f])})`)
    .join("; ")}`;
}

// --- lock -------------------------------------------------------------------

interface LockBody {
  pid: number;
  host: string;
  startedAt: string;
}

function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process. Anything else (EPERM above all) means it exists.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export interface LockOptions {
  /** `--clear-stale-lock`: remove a lock whose process is no longer running. */
  clearStale?: boolean;
  /** Test seam: is this pid alive? */
  isRunning?: (pid: number) => boolean;
  pid?: number;
  host?: string;
}

/**
 * Take the run's lock or throw. Created with `wx`, so two processes cannot both
 * succeed. A stale lock is only ever cleared on request, only when it names
 * this host and a pid that is not running, and by RENAMING it aside first — so
 * a second clearer cannot unlink a lock a live process has just taken.
 */
export function acquireLock(runDir: string, opts: LockOptions = {}): () => void {
  const file = lockPath(runDir);
  const isRunning = opts.isRunning ?? pidIsRunning;
  const me: LockBody = {
    pid: opts.pid ?? process.pid,
    host: opts.host ?? os.hostname(),
    startedAt: new Date().toISOString(),
  };
  const create = () => fs.writeFileSync(file, `${JSON.stringify(me)}\n`, { flag: "wx" });

  try {
    create();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    let holder: LockBody | null = null;
    try {
      holder = JSON.parse(fs.readFileSync(file, "utf8")) as LockBody;
    } catch {
      holder = null;
    }
    const describe = holder
      ? `process ${holder.pid} on ${holder.host}, since ${holder.startedAt}`
      : "an unreadable lock file";
    const byHand = `If you are sure no harness process is writing this run (a process id can be reused by an unrelated program after a restart), delete ${file} by hand and start again.`;
    if (!opts.clearStale) {
      throw new Error(
        `this run is locked by ${describe}. If that process is no longer running, start again with --clear-stale-lock. ${byHand}`,
      );
    }
    if (!holder || holder.host !== me.host || isRunning(holder.pid)) {
      throw new Error(
        `this run is locked by ${describe}, and that lock cannot be shown to be stale (another computer, or a process with that id is running). Not cleared. ${byHand}`,
      );
    }
    const aside = `${file}.stale-${randomBytes(4).toString("hex")}`;
    fs.renameSync(file, aside);
    // What was moved aside must be the lock that was judged stale. If another
    // clearer got there first, this is its LIVE lock: put it back and refuse.
    let movedText: string | null = null;
    let moved: LockBody | null = null;
    try {
      movedText = fs.readFileSync(aside, "utf8");
      moved = JSON.parse(movedText) as LockBody;
    } catch {
      moved = null;
    }
    if (!moved || moved.pid !== holder.pid || moved.host !== holder.host || moved.startedAt !== holder.startedAt) {
      // Put it back with an EXCLUSIVE create, never a rename: on Windows
      // `renameSync` replaces an existing file, so a rename back could clobber
      // a lock a third process has taken in the meantime.
      let restored = false;
      if (movedText !== null) {
        try {
          fs.writeFileSync(file, movedText, { flag: "wx" });
          restored = true;
        } catch {
          restored = false;
        }
      }
      if (restored) fs.rmSync(aside, { force: true });
      throw new Error(
        restored
          ? "the lock changed while it was being cleared: another process has taken this run. Not cleared."
          : `the lock changed while it was being cleared, and could not be put back because another lock is in its place. The moved lock is at ${aside}; look at both before you resume. Not cleared.`,
      );
    }
    fs.rmSync(aside, { force: true });
    create(); // throws EEXIST if another process took the lock in between
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const now = JSON.parse(fs.readFileSync(file, "utf8")) as LockBody;
      if (now.pid === me.pid && now.host === me.host) fs.rmSync(file, { force: true });
    } catch {
      // Already gone.
    }
  };
}
