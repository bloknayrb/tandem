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
 * announced. A switch to Claude is never announced: it sends nothing anywhere.
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
  "Your chat was set to be answered by a local model instead of Claude. If you did not do this, switch it back to Claude in Settings → Models.";

export interface SetChatAnswererResult {
  /** The effective value once this request settled. */
  answerer: ChatAnswerer;
  /** Did the disk end up agreeing with `answerer`? */
  persisted: boolean;
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

/** What the file says, failing toward Claude. Never throws. */
function readDisk(file: string): ChatAnswerer {
  try {
    const obj = readObject(file);
    return obj !== null &&
      Object.hasOwn(obj, "version") &&
      obj.version === CHAT_ANSWERER_VERSION &&
      Object.hasOwn(obj, "answerer") &&
      obj.answerer === "local"
      ? "local"
      : "claude";
  } catch (err) {
    console.error(
      `[tandem] ${CHAT_ANSWERER_FILE_NAME} could not be read (${
        err instanceof Error ? err.message : String(err)
      }); Claude answers chat.`,
    );
    return "claude";
  }
}

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
  if (newerVersion(readObject(file)) !== null) {
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
  const read = readDisk(filePath());
  if (seq !== 0) return;
  effective = read;
  // The local model answers at start-up and the record does not say the user
  // chose it or was told: the file changed underneath, came from another
  // build or a restore, or the record of the user's own switch was lost.
  if (read === "local" && !answererLocalWasAnnounced()) {
    announceStartupMismatch({ answererLocal: true });
  }
  // Claude at start-up, whatever the record says: clear a stale "told", so
  // the next switch to the local model is compared afresh. Silent.
  if (read === "claude") recordAnswererClaude(ANSWERER_LOCAL_NOTICE_KEY);
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

/** What a request reports, taken after every queued write has finished. */
async function settled(requested: ChatAnswerer): Promise<SetChatAnswererResult> {
  await diskQueue;
  const onDisk = readDisk(filePath());
  const agrees = onDisk === effective;
  return {
    answerer: effective,
    persisted: agrees && (requested === "claude" || effective === "local"),
  };
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
    recordAnswererClaude(ANSWERER_LOCAL_NOTICE_KEY);
    removeSync(filePath());
    // And again behind a local write still in flight. If that delete fails,
    // write Claude into the file instead, so the disk cannot keep "local".
    await enqueue(async () => {
      if (removeSync(filePath())) return;
      if (readDisk(filePath()) === "claude") return;
      try {
        await atomicWriteConfigFile(filePath(), serialize(filePath(), "claude"));
      } catch (err) {
        console.error(
          `[tandem] ${CHAT_ANSWERER_FILE_NAME} could not be switched to Claude on disk either (${
            err instanceof Error ? err.message : String(err)
          }); the local model may answer after a restart.`,
        );
      }
    });
    return settled("claude");
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
  return settled("local");
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
