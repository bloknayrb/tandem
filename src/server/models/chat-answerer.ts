/**
 * `chat-answerer.json` — who answers chat: Claude, or the local model (#1123,
 * ADR-039's amendment of 2026-11-12, Bryan's decisions of 2026-11-11 and
 * 2026-11-12: "one switch, two positions").
 *
 * **The default is Claude, and only the user's own choice changes it.**
 * Saving, editing, defaulting, disabling or deleting a model never touches
 * this file: nothing in `models/store.ts`, `registry.ts` or the local-model
 * config resolution calls this module. With the local model chosen and no
 * local model resolving, the switch stays where the user put it, and every
 * chat is told that no local model can answer (decision 5).
 *
 * **A file of its own.** Not `models.json` (`POST /api/models` replaces it
 * whole from a client projection, so a field there is erased by any Models
 * write), and not `local-model-settings.json` (whose failed Off deletes the
 * file — sharing it would let a failed editing write drop the switch, or a
 * failed switch write drop commenting). Here a failed write can only ever
 * touch this one setting.
 *
 * **The read fails toward Claude.** Missing, unreadable, a link or anything
 * else not a regular file, oversized, not JSON, not an object, a `version`
 * that is not exactly this build's (missing, not a number, or a later
 * build's), or `answerer` anything but the string `"local"`: Claude. Any
 * failure to read: Claude.
 *
 * **Claude is immediate and durable; the local model takes effect only once
 * saved.** A switch to Claude changes the effective value and tells the
 * listeners synchronously, so a local-model run in flight is stopped by the
 * collaborator's abort, and writes `{ answerer: "claude" }` synchronously
 * (temp file, fsynced, then renamed) before the route answers — so a quit or
 * a crash straight after cannot bring the local model back. The user's own
 * switch adds `setBy: "own-window"`, which no other path writes, so the next
 * start can tell their choice of Claude (silent) from any other change
 * (announced). If that write fails the file is removed — renamed to a
 * `.removed-by-tandem` marker where it can be, so the next start does not say
 * "was removed", else deleted — and then the route's success waits for the
 * record write, because a missing file with a record still saying "chosen"
 * would be announced; and failing that it is
 * written asynchronously, inside the disk queue, so it can never overtake a
 * later request. It is done again inside the queue, behind any write still in
 * flight. Only a missing file or a parsed
 * Claude counts as Claude on disk; an unreadable file is reported
 * `persisted: false`. A switch to the local model takes effect only when it is
 * the latest request and the disk then reads "local" (its own write, or a
 * superseded one that landed; a request superseded before its step begins
 * writes nothing), and — for the user's own switch — only once the record of
 * their choice is written; if that record write fails the switch does not
 * happen and Claude goes back on disk (#1123 A2, R7.1, R7.2). A
 * missing file reads as Claude, in this build and — a rule every later
 * version must keep — in any later one.
 *
 * **A later build's file is never switched to the local model.** That switch
 * takes effect for this run of the server and is reported `persisted: false`,
 * and is not recorded as the user's choice, because this build has declared
 * it cannot read that schema.
 *
 * **Who switched it decides whether it is announced** (#2404, #2410). The
 * route accepts a request only from Tandem's own window (`own-window.ts`). A
 * switch to the local model made there is the user's own: no notice, and
 * `local-model-announced.ts` records it at once (withdrawing any pending
 * start-up part for it). One admitted through the development allowance is
 * announced. A switch to Claude made in Tandem's own window is silent, and so
 * is a Claude file carrying its mark at start-up; an unmarked Claude file is
 * a change like any other (a writer that copies the mark is #2410's accepted
 * residual of a process running as the user). When the user CHOSE the local model
 * in Tandem's own window (`answererChosen` in the record — not merely told),
 * any other way chat comes to be answered by Claude — the file removed,
 * unreadable, invalid or written by a newer build, or a switch through the
 * development allowance — raises one notice, worded true whoever made the change (Bryan,
 * 2026-11-12: "Announce it"); a read that failed keeps the record, so a later
 * clean read of "local" restores the choice silently. The notice, once owed,
 * is kept in the record until one of Tandem's own windows was sent it, so a
 * restart cannot spend it. Any switch back to the local model withdraws it.
 * At start-up, a stored "local model" the record does not show as the user's
 * raises the start-up notice; a stored Claude clears the record silently. The
 * switch is never part of the first-lit-start baseline: no dark build can
 * write this file, so a "local" found at the flip was written by something
 * else.
 *
 * **The dark guard (R1.4).** {@link chatAnswerer} answers Claude until
 * {@link primeChatAnswerer} has run, and only that function reads the disk.
 * It is called from one place, inside the `BYO_MODELS_ENABLED` block in
 * `src/server/index.ts` (pinned by `tests/server/local-model/production-wiring.test.ts`),
 * after `primeLocalModelSettings` has made the first-lit-start decision. So a
 * dark build never opens this file, even when a flag-on build left "local" in
 * it. {@link setChatAnswerer} refuses while unprimed too (the route answers
 * 404 before reaching it in a dark build). Removing the guard fails
 * `tests/server/models/chat-answerer.test.ts`'s "dark guard" cases.
 *
 * Lives in `models/` so the route can import it (the dark audit forbids any
 * server file outside `local-model/` importing the engine). Nothing here
 * touches the disk at import.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ChatAnswerer } from "../../shared/models/contract.js";
import { atomicWriteConfigFile, readBoundedJsonFileSync } from "../integrations/storage.js";
import { resolveAppDataDir } from "../platform.js";
import {
  announceAnswererClaude,
  announceLocalModelChange,
  announceStartupMismatch,
  answererChosenMayBeOnDisk,
  answererClaudeOwed,
  answererFileRemovedByTandem,
  answererLocalWasAnnounced,
  answererLocalWasChosen,
  clearAnswererFileRemovedByTandem,
  noteAnswererFileRemovedByTandem,
  recordAnswererClaude,
  recordAnswererLocalChosen,
  withdrawAnswererClaudeNotice,
} from "./local-model-announced.js";
import type { ModelsWriteSource } from "./own-window.js";

export type { ChatAnswerer } from "../../shared/models/contract.js";

export const CHAT_ANSWERER_FILE_NAME = "chat-answerer.json";
const CHAT_ANSWERER_VERSION = 1;
/** One short field. Anything bigger is not this file. */
const MAX_BYTES = 4096;
/** Keys never copied from a file on disk into the object this module writes. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Replay key and text of the notice for a switch to the local model that did
 *  not come from Tandem's own window (the development allowance). */
export const ANSWERER_LOCAL_NOTICE_KEY = "local-model-answerer-local";
export const ANSWERER_LOCAL_NOTICE =
  "Your chat was set to be answered by a local model. If you did not do this, set who answers your chat back to Claude in Settings → Models.";

export interface SetChatAnswererResult {
  /** The effective value once this request settled. */
  answerer: ChatAnswerer;
  /** Is the disk known to agree with what this request asked for? */
  persisted: boolean;
  /** A later request arrived before this one settled; `answerer` is that
   *  request's result, and nothing failed. */
  superseded?: true;
}

let basePath: string | null = null;
let primed = false;
let effective: ChatAnswerer = "claude";
/** Counts requests, so a local write can tell whether a later one superseded it. */
let seq = 0;
let diskQueue: Promise<void> = Promise.resolve();
/** Is the Claude now in effect the user's own (their switch in Tandem's own
 *  window this run, or their mark seen on disk when a local request's step
 *  began)? Decides whether Claude put back on disk after a failed own-window
 *  switch to the local model carries the user's mark (R7.1), so that switch
 *  failing never makes the next start announce a change the user did not
 *  make. Never seeded at start-up (R7.5: removed). */
let claudeIsOwn = false;
/** Set at start-up: the file was missing and Tandem had removed it itself (its
 *  fallback when a Claude write failed), so "was removed" is not said (round 5). */
let removedByTandem = false;
/** How a switch was made, as the listeners are told (#1123 A2): the user's own
 *  switch in Tandem's own window, or one admitted through the development
 *  allowance. A2 tells the user's switch back to Claude from every other. */
export type ChatAnswererSwitchSource = ModelsWriteSource | "unspecified";

const listeners = new Set<(now: ChatAnswerer, source: ChatAnswererSwitchSource) => void>();

function filePath(): string {
  return path.join(basePath ?? resolveAppDataDir(), CHAT_ANSWERER_FILE_NAME);
}

function readObject(file: string): Record<string, unknown> | null {
  const parsed = readBoundedJsonFileSync(file, MAX_BYTES);
  if (parsed === null || parsed === "unreadable") return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/** The file's `version` when it is one a LATER build wrote; else null. */
function newerVersion(obj: Record<string, unknown> | null): number | null {
  if (obj === null || !Object.hasOwn(obj, "version")) return null;
  const v = obj.version;
  return typeof v === "number" && Number.isFinite(v) && v > CHAT_ANSWERER_VERSION ? v : null;
}

/**
 * What is on disk. Only `local` makes the local model answer; every other
 * state reads Claude. The states are kept apart because they mean different
 * things when deciding whether a write landed (only `missing` and `claude`
 * are Claude on disk — `unreadable` is not known to be anything) and what the
 * user is told when their recorded choice of the local model is lost.
 */
type DiskState =
  | "missing"
  | "unreadable"
  | "newer"
  | "invalid"
  /** Claude, written by something other than Tandem's own-window route. */
  | "claude"
  /** Claude, carrying the marker only the own-window route writes. */
  | "claude-own"
  | "local";

/**
 * The marker the own-window route writes into a Claude file, so a later start
 * can tell the user's own choice (silent) from any other writer's (announced
 * when the local model was the user's choice). It is not a secret: a process
 * running as the user can copy it, which is #2410's accepted residual.
 */
const OWN_WINDOW_MARKER = { setBy: "own-window" } as const;

/** Never throws. */
function readState(file: string): DiskState {
  try {
    // Not `readBoundedJsonFileSync`, which folds a failed read and bad
    // content into one answer: here a failed read may be transient (a scanner
    // holding the file) and keeps the user's recorded choice, while content
    // that is not this file's — a link, a directory, oversized, not JSON — is
    // a change.
    let st: fs.Stats;
    try {
      st = fs.lstatSync(file);
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unreadable";
    }
    if (!st.isFile() || st.size > MAX_BYTES) return "invalid";
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unreadable";
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return "invalid";
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "invalid";
    const obj = parsed as Record<string, unknown>;
    if (newerVersion(obj) !== null) return "newer";
    if (!Object.hasOwn(obj, "version") || obj.version !== CHAT_ANSWERER_VERSION) return "invalid";
    if (!Object.hasOwn(obj, "answerer")) return "invalid";
    if (obj.answerer === "local") return "local";
    if (obj.answerer === "claude") {
      return Object.hasOwn(obj, "setBy") && obj.setBy === OWN_WINDOW_MARKER.setBy
        ? "claude-own"
        : "claude";
    }
    return "invalid";
  } catch (err) {
    console.error(
      `[tandem] ${CHAT_ANSWERER_FILE_NAME} could not be read (${
        err instanceof Error ? err.name : "error"
      }); Claude answers chat.`,
    );
    return "unreadable";
  }
}

/** Is Claude what the disk says, as far as a write is concerned? An emptied
 *  file (`invalid`, the fallback when the removal's rename fails, R7.3) reads
 *  Claude in this build and every later one, as a missing file does. */
const isClaudeOnDisk = (state: DiskState): boolean =>
  state === "missing" || state === "invalid" || state === "claude" || state === "claude-own";

function serialize(file: string, answerer: ChatAnswerer): string {
  const existing = readObject(file);
  const known = { version: CHAT_ANSWERER_VERSION, answerer };
  if (existing) {
    const carried: Record<string, unknown> = {};
    for (const key of Object.keys(existing)) {
      // `setBy` is the own-window Claude mark: only that write may carry it,
      // so no other write of this file keeps it (#1123 review round 4).
      if (UNSAFE_KEYS.has(key) || key === "version" || key === "answerer" || key === "setBy") {
        continue;
      }
      carried[key] = existing[key];
    }
    const merged = `${JSON.stringify({ ...carried, ...known }, null, 2)}\n`;
    // A file past the read bound would read as Claude; drop the carried keys
    // rather than let them push it over.
    if (Buffer.byteLength(merged, "utf8") <= MAX_BYTES) return merged;
  }
  return `${JSON.stringify(known, null, 2)}\n`;
}

interface DiskOutcome {
  /** May the requested value take effect? (A local switch into a newer
   *  file may, for this run only.) */
  written: boolean;
  /** Did its bytes actually reach the disk? Only then is a switch to the
   *  local model recorded as the user's choice. */
  saved: boolean;
}

/** Remove the file (Claude). Never throws; logs a failure. */
/** Where Tandem's own removal of the file leaves it: a marker, read only for
 *  whether it exists. */
function removedMarkerPath(): string {
  return path.join(path.dirname(filePath()), `.${CHAT_ANSWERER_FILE_NAME}.removed-by-tandem`);
}

/** The file holds a value again: a marker of Tandem's own removal no longer
 *  applies. Best effort; never throws. */
function markerExists(): boolean {
  try {
    // A plain file, or a link: Tandem's rename moves whatever was at the
    // file's path, so a linked settings file leaves the link here (#1123 A2,
    // R7.3). Anything else at that path (a directory a delete cannot remove,
    // say) would otherwise hide a real removal. A marker planted or left stale
    // by a process running as the user only ever omits the "was removed"
    // clause, never the notice (#2410).
    const st = fs.lstatSync(removedMarkerPath());
    return st.isFile() || st.isSymbolicLink();
  } catch {
    return false;
  }
}

function clearRemovedMarker(): void {
  clearAnswererFileRemovedByTandem();
  try {
    fs.rmSync(removedMarkerPath(), { force: true });
  } catch {
    // A marker left behind only ever omits a cause clause.
  }
}

function removeSync(file: string): boolean {
  // Renamed rather than unlinked where it can be: the marker it leaves tells
  // the next start that Tandem removed the file itself, so its notice does not
  // say "was removed" (round 5). A rename needs no free space.
  try {
    fs.renameSync(file, removedMarkerPath());
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
  }
  // The rename failed. Emptying a regular file in place needs no free space
  // and leaves a file that reads as not this file's (Claude), never as
  // missing, so the next start cannot say "was removed" of Tandem's own
  // removal (#1123 A2, R7.3). Only a regular file with one name, and only the
  // very file checked: the descriptor is re-checked (same device and inode,
  // a regular file, one link) before anything is written, so a link swapped
  // in between the check and the open — which `O_NOFOLLOW` would refuse where
  // the platform has it, and Windows does not — is never emptied.
  try {
    const st = fs.lstatSync(file);
    if (st.isFile() && st.nlink <= 1) {
      const fd = fs.openSync(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const now = fs.fstatSync(fd);
        if (now.isFile() && now.nlink <= 1 && now.dev === st.dev && now.ino === st.ino) {
          fs.ftruncateSync(fd, 0);
          return true;
        }
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    // Fall through to the delete.
  }
  try {
    fs.rmSync(file, { force: true });
    // The rename failed but the delete worked: leave an empty marker, which
    // needs almost no space, so the next start still knows (round 5 review).
    try {
      // Only its existence matters. Created exclusively, so nothing is ever
      // opened through a link planted at this path — `O_EXCL` refuses an
      // existing name, a link included, on every platform (Windows has no
      // `O_NOFOLLOW`) — and what is already there counts only when it is a
      // regular file (review round 1, item 23 and its re-review).
      try {
        fs.closeSync(fs.openSync(removedMarkerPath(), "wx", 0o600));
      } catch (err) {
        if (
          (err as NodeJS.ErrnoException).code !== "EEXIST" ||
          !fs.lstatSync(removedMarkerPath()).isFile()
        ) {
          throw err;
        }
      }
    } catch {
      // No marker: say so in the announced record instead, so the next start
      // still does not say "was removed" of Tandem's own removal (R7.3). The
      // record write is queued, not awaited: a quit in that moment, or that
      // write failing too, is the one way the clause can still be said.
      noteAnswererFileRemovedByTandem();
    }
    return true;
  } catch (err) {
    console.error(
      `[tandem] ${CHAT_ANSWERER_FILE_NAME} could not be removed (${
        err instanceof Error ? err.message : String(err)
      }); Claude answers chat for this run of Tandem, but the local model may answer after a restart.`,
    );
    return false;
  }
}

/** Write "local" (only ever into this build's own version or no file). On
 *  failure the file is left as it was: an atomic write that failed changed
 *  nothing, and a Claude file must stay Claude. Never throws. */
async function writeLocal(): Promise<DiskOutcome> {
  const file = filePath();
  if (readState(file) === "newer") {
    // Never stamped into a later build's file; `settled` reports it unsaved.
    return { written: true, saved: false };
  }
  try {
    await atomicWriteConfigFile(file, serialize(file, "local"));
    clearRemovedMarker();
    return { written: true, saved: true };
  } catch (err) {
    console.error(
      `[tandem] ${CHAT_ANSWERER_FILE_NAME} could not be written (${
        err instanceof Error ? err.message : String(err)
      }).`,
    );
  }
  return { written: false, saved: false };
}

/**
 * Write `{ answerer: "claude" }` synchronously, with the own-window marker
 * when `own`: a temp file, fsynced, then a rename (which replaces a link at
 * the path rather than following it). Synchronous so the disk says Claude
 * before the route answers — a quit straight after cannot bring the local
 * model back — and a FILE rather than no file, so the next start can tell the
 * user's own choice of Claude (silent) from any other change (announced, when
 * the user had chosen the local model). Never throws; false when it did not
 * land.
 */
function writeClaudeSync(file: string, own: boolean): boolean {
  const tmp = path.join(path.dirname(file), `.${CHAT_ANSWERER_FILE_NAME}.${randomUUID()}.tmp`);
  const body = `${JSON.stringify(
    { version: CHAT_ANSWERER_VERSION, answerer: "claude", ...(own ? OWN_WINDOW_MARKER : {}) },
    null,
    2,
  )}\n`;
  let fd: number | null = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error(
      `[tandem] ${CHAT_ANSWERER_FILE_NAME} could not be set to Claude (${
        err instanceof Error ? err.name : "error"
      }).`,
    );
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {
      // Already failing; the temp file is removed below.
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best effort: an orphaned temp file reads as nothing.
    }
    return false;
  }
}

/** How the synchronous step made the disk read Claude, if it did. */
type ClaudeOnDisk = "already" | "written" | "deleted" | "failed";

/** Make the disk read Claude now, synchronously: Claude (with the marker when
 *  `own`) written over the file; failing that the file removed. */
function makeDiskClaudeSync(own: boolean): ClaudeOnDisk {
  const file = filePath();
  const state = readState(file);
  // Own: only the marked file will do. Not own: any Claude file already is
  // Claude — a non-own write never strips the user's own mark (round 4 P12).
  if (own ? state === "claude-own" : state === "claude" || state === "claude-own") return "already";
  if (writeClaudeSync(file, own)) {
    clearRemovedMarker();
    return "written";
  }
  if (removeSync(file)) return "deleted";
  return isClaudeOnDisk(readState(file)) ? "already" : "failed";
}

/** The last resort, inside the disk queue: an async write of Claude. */
async function writeClaudeAsync(own: boolean): Promise<void> {
  const file = filePath();
  try {
    await atomicWriteConfigFile(
      file,
      `${JSON.stringify({ version: CHAT_ANSWERER_VERSION, answerer: "claude", ...(own ? OWN_WINDOW_MARKER : {}) }, null, 2)}\n`,
    );
    clearRemovedMarker();
  } catch (err) {
    console.error(
      `[tandem] ${CHAT_ANSWERER_FILE_NAME} could not be switched to Claude on disk either (${
        err instanceof Error ? err.message : String(err)
      }); the local model may answer after a restart.`,
    );
  }
}

/**
 * The notice that chat is answered by Claude again (#1123, Bryan's decision
 * 2026-11-12; wording by the review session's ruling in round 4). True
 * whoever made the switch — it never says the user chose the local model or
 * who changed it — so a notice raised in a rare case the user did cause
 * themselves (a lost record write, a disk that refused the marked write, a
 * restored backup) is redundant, never false. A cause clause appears only
 * where Tandem knows the cause for certain, judged from the disk at the
 * moment the notice is raised: "missing" only for a removal Tandem did not
 * make itself, and "will try again" only where the record is kept for that
 * retry (round 5). Fixed strings: never a path.
 */
export function answererClaudeNotice(
  cause: "missing" | "unreadable" | "unreadable-no-retry" | null,
): string {
  const clause =
    cause === "missing"
      ? " The file that held this setting was removed."
      : cause === "unreadable"
        ? " Tandem could not read the file that holds this setting, and will try again at the next start."
        : cause === "unreadable-no-retry"
          ? " Tandem could not read the file that holds this setting."
          : "";
  return `Chat in Tandem is now answered by Claude, not by a local model.${clause} If you did not make this change, check Settings → Models.`;
}

/** The cause clause the disk supports right now, if any. `kept`: the record
 *  is kept for a retry at the next start. */
function certainCause(
  state: DiskState,
  kept: boolean,
): "missing" | "unreadable" | "unreadable-no-retry" | null {
  if (state === "missing") return removedByTandem ? null : "missing";
  if (state === "unreadable") return kept ? "unreadable" : "unreadable-no-retry";
  return null;
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = diskQueue.then(task, task);
  diskQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function setEffective(now: ChatAnswerer, source: ChatAnswererSwitchSource): void {
  if (effective === now) return;
  effective = now;
  // The local model answers again, however that came about: a waiting
  // "answered by Claude again" notice is no longer true.
  if (now === "local") withdrawAnswererClaudeNotice();
  for (const cb of [...listeners]) {
    try {
      cb(now, source);
    } catch (err) {
      console.error("[tandem] A chat-answerer listener failed:", err);
    }
  }
}

/**
 * Read the file once at boot. Called only under `BYO_MODELS_ENABLED`, after
 * `primeLocalModelSettings` (which decides "is this the first lit start?"
 * before anything could write the record). Never throws. Applies its result
 * only if no request has been made yet.
 */
export function primeChatAnswerer(): void {
  primed = true;
  const state = readState(filePath());
  if (seq !== 0) return;
  effective = state === "local" ? "local" : "claude";
  // Not seeded from this read (#1123 A2, R7.5 — removed rather than pinned):
  // a local request observes the user's mark on disk when its step begins,
  // which also covers a start-up read that failed over the mark (review item
  // 25).
  claudeIsOwn = false;
  if (state === "missing") {
    removedByTandem = markerExists() || answererFileRemovedByTandem();
  } else {
    removedByTandem = false;
    if (state !== "unreadable") clearRemovedMarker();
  }
  if (state === "local") {
    // The local model answers again: an owed "answered by Claude again"
    // notice is no longer true.
    withdrawAnswererClaudeNotice();
    // The local model answers at start-up and the record does not say the
    // user chose it or was told: the file changed underneath, came from
    // another build or a restore, or the record of the user's own switch was
    // lost. The one start-up notice says chat is set to be answered by a
    // local model.
    if (!answererLocalWasAnnounced()) announceStartupMismatch({ answererLocal: true });
    return;
  }
  // The user's own choice of Claude (the marked file) is silent whatever the
  // record says — even one whose clearing write was lost, and even with a
  // notice still owed from before it: that notice is moot once the user chose
  // Claude themselves (only the own-window route writes the mark).
  if (state === "claude-own") {
    void recordAnswererClaude(ANSWERER_LOCAL_NOTICE_KEY);
    return;
  }
  // A notice owed from an earlier run that no window was sent: raise it again
  // (#1123 review round 3: a restart must not spend it). Its record is kept
  // on delivery only when the notice is itself about a failed read; a cause
  // recorded as a failed read that now reads cleanly is told as what it is.
  // Its words are judged afresh from the disk now, never replayed.
  // The record is kept on delivery only when the notice was owed for a
  // failed read and the read fails again (round 3 M2): a notice owed for
  // another cause and shown during a failed read is still spent once seen.
  const owed = answererClaudeOwed();
  if (owed !== null) {
    const keep = state === "unreadable" && owed === "unreadable";
    announceAnswererClaude(answererClaudeNotice(certainCause(state, keep)), {
      keepRecord: keep,
      cause: owed,
    });
    return;
  }
  if (answererLocalWasChosen()) {
    // The user CHOSE the local model in Tandem's own window, and Claude
    // answers now by something else — the file removed, changed (an unmarked
    // Claude file included), invalid, from a newer build, or unreadable: say
    // so (Bryan, 2026-11-12). A read that failed may be transient (a Windows
    // scanner holding the file), so the record is kept and the next clean
    // start that reads "local" restores the choice with no warning.
    announceAnswererClaude(answererClaudeNotice(certainCause(state, state === "unreadable")), {
      keepRecord: state === "unreadable",
      cause: state,
    });
    return;
  }
  // A read that failed keeps whatever the record says (told or chosen), so a
  // next clean start that reads "local" gives no false "settings changed".
  if (state === "unreadable") return;
  // Claude at start-up otherwise: clear the record and any pending notice.
  void recordAnswererClaude(ANSWERER_LOCAL_NOTICE_KEY);
}

/** Has the start-up read run (#1123 A2: the local period's boot step reads it,
 *  so a failed prime neither begins nor ends a persisted period)? */
export function chatAnswererPrimed(): boolean {
  return primed;
}

/** Who answers chat now. Claude until primed (the dark guard). Synchronous. */
export function chatAnswerer(): ChatAnswerer {
  return primed ? effective : "claude";
}

/** Be told when who answers chat changes, and how the switch was made
 *  (`source`, #1123 A2); returns the unsubscribe. Priming at start-up tells
 *  nobody. */
export function onChatAnswererChanged(
  cb: (now: ChatAnswerer, source: ChatAnswererSwitchSource) => void,
): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** What a request reports, taken after every queued write has finished.
 *  `persisted` only when the disk is KNOWN to agree: an unreadable file is
 *  not Claude for this purpose. */
async function settled(
  requested: ChatAnswerer,
  superseded: boolean,
): Promise<SetChatAnswererResult> {
  await diskQueue;
  const state = readState(filePath());
  const persisted =
    effective === requested && (requested === "claude" ? isClaudeOnDisk(state) : state === "local");
  return { answerer: effective, persisted, ...(superseded ? { superseded: true } : {}) };
}

/**
 * Switch who answers chat. See the module header for the ordering guarantees.
 * `source` is how the request got in: `own-window` is the user's own change
 * (recorded, not announced); anything else switching to the local model is
 * announced. Required, so a new caller cannot default into either.
 */
export async function setChatAnswerer(
  value: ChatAnswerer,
  source: ChatAnswererSwitchSource,
): Promise<SetChatAnswererResult> {
  if (!primed) return { answerer: "claude", persisted: false };
  const mine = ++seq;
  if (value === "claude") {
    // Before any await: a local-model run in flight is stopped at once, and
    // the disk reads Claude before the route answers.
    setEffective("claude", source);
    const own = source === "own-window";
    claudeIsOwn = own;
    // Was the local model the user's own choice before this switch? Only then
    // can a missing or unmarked file be announced at the next start.
    const wasChosen = answererLocalWasChosen();
    let recorded: Promise<boolean> = Promise.resolve(true);
    if (!own && wasChosen) {
      // Not the user's own choice, and theirs was the local model: say so
      // (Bryan, 2026-11-12). Owed durably; the record is cleared once a
      // window of Tandem's was told.
      announceAnswererClaude(answererClaudeNotice(null), {
        keepRecord: false,
        cause: "allowance",
      });
    } else {
      recorded = recordAnswererClaude(ANSWERER_LOCAL_NOTICE_KEY);
    }
    // Synchronously, before the route answers; and again inside the queue,
    // behind a local write still in flight, where the async last resort runs
    // too — so it can never overtake a later request.
    let how = makeDiskClaudeSync(own);
    // Not skipped when a later request arrived: the queue keeps order, so a
    // later local write still lands after this one (round 4 P11).
    let recordedInQueue = false;
    await enqueue(async () => {
      how = makeDiskClaudeSync(own);
      if (how === "failed") await writeClaudeAsync(own);
      // The user's own switch to Claude, after every local step queued ahead
      // of it: a superseded own-window request may have recorded "chosen"
      // after this request read the record, and the clear that undoes it may
      // have failed. Clear it here, or write again what failed, so the next
      // start does not announce a change the user did not make (round-1
      // re-review, the generated sequence seed 63).
      if (own && (answererLocalWasChosen() || answererChosenMayBeOnDisk())) {
        recordedInQueue = true;
        recorded = recordAnswererClaude(ANSWERER_LOCAL_NOTICE_KEY);
      }
    });
    const result = await settled("claude", seq !== mine);
    // The user's own switch is silent at the next start only if the file
    // carries its mark, or the record was cleared: a missing or unmarked file
    // with a record still saying "chosen" would be announced. So when the
    // mark did not land, its success waits for that record write (#1123
    // review round 3).
    if (
      own &&
      (wasChosen || recordedInQueue) &&
      result.persisted &&
      readState(filePath()) !== "claude-own" &&
      !(await recorded)
    ) {
      return { ...result, persisted: false };
    }
    return result;
  }
  // The local model (#1123 A2, R7.1 and R7.2). Every step runs inside the disk
  // queue, so requests settle in the order they arrived. A request a later one
  // has superseded before its step begins writes nothing at all; the latest
  // request writes, then reconciles toward ITS OWN request by reading the
  // disk — it never needs to know what a superseded write found or left. A
  // "local" on disk (its own write, or a superseded one that landed while it
  // was queued) takes effect, once the user's own switch is recorded; anything
  // else changes nothing. A Claude request is never undone here: it writes
  // Claude synchronously and again inside the queue, after any local write
  // that was already in flight.
  let failedRecord = false;
  let savedButUnreadable = false;
  await enqueue(async () => {
    if (seq !== mine) return;
    // The user's own marked Claude is on disk and in effect: what a failed
    // switch puts back must carry the mark, even when the start-up read failed
    // and did not seed it (#1123 A2 review, item 25).
    if (effective === "claude" && readState(filePath()) === "claude-own") claudeIsOwn = true;
    const outcome = await writeLocal();
    // A later request arrived while this one wrote: it reconciles.
    if (seq !== mine) return;
    const read = readState(filePath());
    // A write known to have landed whose read-back fails (a scanner holding
    // the file a moment) is "local" on disk: a restart would read it, so it
    // is taken as what the disk says (review item 9).
    const state: DiskState = outcome.saved && read === "unreadable" ? "local" : read;
    if (outcome.saved && read === "unreadable") savedButUnreadable = true;
    // A newer build's file: the switch takes effect for this run only,
    // unsaved and unrecorded, as before.
    const unsavedThisRun = outcome.written && !outcome.saved && state === "newer";
    if (state !== "local" && !unsavedThisRun) return;
    const wasLocal = effective === "local";
    if (source === "own-window" && state === "local") {
      // R7.1: the user's own switch counts as made only once the record says
      // they chose it, because that record is what lets a later change back
      // to Claude be announced. A record write that fails fails the switch:
      // Claude stays in effect, and goes back on disk, with the user's mark
      // when the Claude in effect was their own.
      const recorded = await recordAnswererLocalChosen(ANSWERER_LOCAL_NOTICE_KEY);
      if (seq !== mine) {
        // Superseded while its choice was being recorded: the local model did
        // not take effect, so the record must not say "chosen" (round-1
        // re-review B1). A Claude request that arrived meanwhile read the
        // record before this write landed; a later local request queues
        // behind this clear and records its own choice again.
        if (recorded && effective !== "local" && answererLocalWasChosen()) {
          await recordAnswererClaude(ANSWERER_LOCAL_NOTICE_KEY);
        }
        return;
      }
      if (!recorded) {
        failedRecord = true;
        if (effective !== "local") {
          if (makeDiskClaudeSync(claudeIsOwn) === "failed") await writeClaudeAsync(claudeIsOwn);
          // The record says "chosen" only while the local model is in effect
          // (review item 1): an earlier request of this run that recorded its
          // choice and was superseded by this failed one leaves it behind.
          if (answererLocalWasChosen()) await recordAnswererClaude(ANSWERER_LOCAL_NOTICE_KEY);
        }
        return;
      }
    }
    setEffective("local", source);
    if (source !== "own-window" && !wasLocal) {
      announceLocalModelChange(ANSWERER_LOCAL_NOTICE_KEY, ANSWERER_LOCAL_NOTICE, {
        answererLocal: true,
      });
    }
  });
  const result = await settled("local", seq !== mine);
  if (failedRecord && !result.superseded) return { ...result, persisted: false };
  // Its write is known to have landed: a read-back that still fails does not
  // make it unsaved (item 9).
  if (
    savedButUnreadable &&
    !result.persisted &&
    result.answerer === "local" &&
    !result.superseded
  ) {
    return { ...result, persisted: true };
  }
  return result;
}

/** Test seam: point the module at a temp dir (or reset it) and forget all
 *  state, listeners included. Does not reset the announced record. */
export function __resetChatAnswererForTests(base?: string): void {
  basePath = base ?? null;
  primed = false;
  effective = "claude";
  seq = 0;
  diskQueue = Promise.resolve();
  claudeIsOwn = false;
  removedByTandem = false;
  listeners.clear();
}
