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
 * saved.** Claude is stored as NO file (a missing file reads as Claude, in
 * this build and — a rule every later version must keep — in any later one).
 * A switch to Claude changes the effective value and tells the listeners
 * synchronously, so a local-model run in flight is stopped by the
 * collaborator's abort, and deletes the file synchronously, before the route
 * answers — so a quit or a crash straight after cannot bring the local model
 * back at the next start. It deletes it again behind any write still queued,
 * so a switch to the local model that was in flight cannot land after it. A
 * later build's file is deleted too: it holds only this switch. A switch to
 * the local model takes effect only after its own write succeeded, and only
 * if no later request arrived meanwhile. If the delete fails (a locked file,
 * a permission), `{ answerer: "claude" }` is written over it instead; only if
 * both fail can the disk still read "local", and that is logged and reported
 * `persisted: false`.
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
 * announced. A switch to Claude made in Tandem's own window is silent. Any
 * other way chat comes to be answered by Claude while the record says the user
 * chose the local model — the file removed, unreadable, changed or written by
 * a newer build, or a switch through the development allowance — raises one
 * notice saying so and why (Bryan, 2026-11-12: "Announce it"); a read that
 * failed keeps the record, so a later clean read of "local" restores the
 * choice silently.
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

import fs from "node:fs";
import path from "node:path";

import type { ChatAnswerer } from "../../shared/models/contract.js";
import { atomicWriteConfigFile, readBoundedJsonFileSync } from "../integrations/storage.js";
import { resolveAppDataDir } from "../platform.js";
import {
  announceAnswererClaude,
  announceLocalModelChange,
  announceStartupMismatch,
  answererLocalWasAnnounced,
  recordAnswererClaude,
  recordSetByUser,
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
const listeners = new Set<(now: ChatAnswerer) => void>();

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
type DiskState = "missing" | "unreadable" | "newer" | "invalid" | "claude" | "local";

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
    if (obj.answerer === "claude") return "claude";
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

/** Is Claude what the disk says, as far as a write is concerned? */
const isClaudeOnDisk = (state: DiskState): boolean => state === "missing" || state === "claude";

function serialize(file: string, answerer: ChatAnswerer): string {
  const existing = readObject(file);
  const known = { version: CHAT_ANSWERER_VERSION, answerer };
  if (existing) {
    const carried: Record<string, unknown> = {};
    for (const key of Object.keys(existing)) {
      if (UNSAFE_KEYS.has(key) || key === "version" || key === "answerer") continue;
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
function removeSync(file: string): boolean {
  try {
    fs.rmSync(file, { force: true });
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
 *  failure, if Claude is now effective, remove the file. Never throws. */
async function writeLocal(): Promise<DiskOutcome> {
  const file = filePath();
  if (readState(file) === "newer") {
    // Never stamped into a later build's file; `settled` reports it unsaved.
    return { written: true, saved: false };
  }
  try {
    await atomicWriteConfigFile(file, serialize(file, "local"));
    return { written: true, saved: true };
  } catch (err) {
    console.error(
      `[tandem] ${CHAT_ANSWERER_FILE_NAME} could not be written (${
        err instanceof Error ? err.message : String(err)
      }).`,
    );
  }
  if (effective !== "local") removeSync(file);
  return { written: false, saved: false };
}

/** Make the disk read Claude: delete the file, and if that fails and the file
 *  is not known to say Claude, write Claude over it. Never throws. */
async function makeDiskClaude(): Promise<void> {
  const file = filePath();
  if (removeSync(file)) return;
  if (isClaudeOnDisk(readState(file))) return;
  try {
    await atomicWriteConfigFile(file, serialize(file, "claude"));
  } catch (err) {
    console.error(
      `[tandem] ${CHAT_ANSWERER_FILE_NAME} could not be switched to Claude on disk either (${
        err instanceof Error ? err.message : String(err)
      }); the local model may answer after a restart.`,
    );
  }
}

/** Why chat is answered by Claude again, in words for the notice. */
const CLAUDE_AGAIN_BECAUSE: Record<Exclude<DiskState, "local"> | "allowance", string> = {
  missing: "the file that held that choice was removed",
  claude: "the file that held that choice was changed",
  invalid: "the file that held that choice was changed",
  newer: "the file that holds that choice was written by a newer version of Tandem",
  unreadable:
    "the file that holds that choice could not be read (Tandem will read it again at the next start)",
  allowance: "a change was made outside Tandem's own window",
};

/** The notice that chat is answered by Claude again (#1123, Bryan's decision
 *  2026-11-12). Fixed strings: never a path. */
export function answererClaudeNotice(cause: keyof typeof CLAUDE_AGAIN_BECAUSE): string {
  return `Your chat is now answered by Claude, not by a local model as you chose, because ${CLAUDE_AGAIN_BECAUSE[cause]}. To have a local model answer it again, set who answers your chat in Settings → Models.`;
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = diskQueue.then(task, task);
  diskQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function setEffective(now: ChatAnswerer): void {
  if (effective === now) return;
  effective = now;
  for (const cb of [...listeners]) {
    try {
      cb(now);
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
  if (state === "local") {
    // The local model answers at start-up and the record does not say the
    // user chose it or was told: the file changed underneath, came from
    // another build or a restore, or the record of the user's own switch was
    // lost. The one start-up notice says chat is now answered by a local model.
    if (!answererLocalWasAnnounced()) announceStartupMismatch({ answererLocal: true });
    return;
  }
  if (answererLocalWasAnnounced()) {
    // The user's recorded choice was the local model and Claude answers now,
    // not by their own choice: say so (Bryan, 2026-11-12). A read that failed
    // may be transient (a Windows scanner holding the file), so the record is
    // kept and the next clean start that reads "local" restores the choice
    // with no "settings changed" warning.
    announceAnswererClaude(answererClaudeNotice(state), { keepRecord: state === "unreadable" });
    return;
  }
  // Claude at start-up and nothing recorded: clear a stale pending notice.
  recordAnswererClaude(ANSWERER_LOCAL_NOTICE_KEY);
}

/** Who answers chat now. Claude until primed (the dark guard). Synchronous. */
export function chatAnswerer(): ChatAnswerer {
  return primed ? effective : "claude";
}

/** Be told when who answers chat changes; returns the unsubscribe. */
export function onChatAnswererChanged(cb: (now: ChatAnswerer) => void): () => void {
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
  source: ModelsWriteSource | "unspecified",
): Promise<SetChatAnswererResult> {
  if (!primed) return { answerer: "claude", persisted: false };
  const mine = ++seq;
  if (value === "claude") {
    // Before any await: a local-model run in flight is stopped at once, and
    // the disk reads Claude before the route answers.
    setEffective("claude");
    if (source !== "own-window" && answererLocalWasAnnounced()) {
      // Not the user's own choice, and theirs was the local model: say so
      // (Bryan, 2026-11-12). The record is cleared once a window was told.
      announceAnswererClaude(answererClaudeNotice("allowance"), { keepRecord: false });
    } else {
      recordAnswererClaude(ANSWERER_LOCAL_NOTICE_KEY);
    }
    removeSync(filePath());
    // And again behind a local write still in flight; if the delete fails,
    // Claude is written over the file instead.
    await enqueue(makeDiskClaude);
    return settled("claude", seq !== mine);
  }
  await enqueue(async () => {
    const outcome = await writeLocal();
    if (outcome.written && seq === mine) {
      const wasLocal = effective === "local";
      setEffective("local");
      // Recorded as the user's choice only when it was saved: an unsaved
      // switch (a newer build's file) reads Claude again after a restart, and
      // a record saying "chosen" would let a "local" written meanwhile by
      // something else start silently.
      if (source === "own-window") {
        if (outcome.saved) recordSetByUser({ answererLocal: true }, ANSWERER_LOCAL_NOTICE_KEY);
      } else if (!wasLocal) {
        announceLocalModelChange(ANSWERER_LOCAL_NOTICE_KEY, ANSWERER_LOCAL_NOTICE, {
          answererLocal: true,
        });
      }
    }
  });
  return settled("local", seq !== mine);
}

/** Test seam: point the module at a temp dir (or reset it) and forget all
 *  state, listeners included. Does not reset the announced record. */
export function __resetChatAnswererForTests(base?: string): void {
  basePath = base ?? null;
  primed = false;
  effective = "claude";
  seq = 0;
  diskQueue = Promise.resolve();
  listeners.clear();
}
