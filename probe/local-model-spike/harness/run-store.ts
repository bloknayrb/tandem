/**
 * A run on disk: one directory per run, under the gitignored `runs/`.
 *
 *   identity.json   what was measured, on what, and each session that ran it
 *   trials.jsonl    one line per SCORED trial (never rewritten, only appended)
 *   infra.jsonl     one line per attempt that ended in an infrastructure error
 *   lock            the process writing this run
 *
 * Imports nothing from `src/`, so an entry script can use it before the
 * app-data directory is pointed at the run.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isSafeRunId } from "./paths.js";

export type RunMode = "full" | "screen";

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

function readJsonLines<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A torn last line from a killed process: the trial was not recorded, so
      // it is simply run again.
    }
  }
  return out;
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
export function appendTrial(runDir: string, record: unknown): void {
  fs.appendFileSync(trialsPath(runDir), `${JSON.stringify(record)}\n`, "utf8");
}
export function appendInfra(runDir: string, record: unknown): void {
  fs.appendFileSync(infraPath(runDir), `${JSON.stringify(record)}\n`, "utf8");
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
    if (!opts.clearStale) {
      throw new Error(
        `this run is locked by ${describe}. If that process is no longer running, start again with --clear-stale-lock.`,
      );
    }
    if (!holder || holder.host !== me.host || isRunning(holder.pid)) {
      throw new Error(
        `this run is locked by ${describe}, and that lock cannot be shown to be stale (another computer, or the process is still running). Not cleared.`,
      );
    }
    const aside = `${file}.stale-${randomBytes(4).toString("hex")}`;
    fs.renameSync(file, aside);
    // What was moved aside must be the lock that was judged stale. If another
    // clearer got there first, this is its LIVE lock: put it back and refuse.
    let moved: LockBody | null = null;
    try {
      moved = JSON.parse(fs.readFileSync(aside, "utf8")) as LockBody;
    } catch {
      moved = null;
    }
    if (!moved || moved.pid !== holder.pid || moved.host !== holder.host || moved.startedAt !== holder.startedAt) {
      try {
        fs.renameSync(aside, file);
      } catch {
        // Someone holds the lock path again; leave the aside file for a person to look at.
      }
      throw new Error("the lock changed while it was being cleared: another process has taken this run. Not cleared.");
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
