/**
 * `local-model-announced.json` — what a browser has actually been told about the
 * two things #2404 makes visible: that local models may comment, and which
 * local model answers chat (#1123, register entry in docs/security.md).
 *
 * Both are changed through routes whose origin and loopback gates do not prove
 * the user made the request, so each change is announced in the app. An
 * in-memory notice is not enough on its own: the same local actor that can call
 * those routes can also restart the server (`POST /api/shutdown` takes the same
 * callers), and after a restart an in-memory "already announced" is gone — the
 * changed state would simply be what the server starts with.
 *
 * So this file records the state as of the last announcement that **reached a
 * browser**, and start-up compares against it: anything saved that no browser
 * was told about is announced again, and registered for the first browser that
 * connects. "Reached a browser" means the notice was written to a notify
 * stream — either one that was connected when it was raised, or one that
 * connected later and was sent the replay.
 *
 * The read fails toward announcing: a missing, unreadable or malformed file
 * reads as "nothing was ever announced", so the cost of losing it is one
 * repeated notice, never a silent change. A failed write has the same cost.
 *
 * It lives in `models/` so that both the settings module and the collaborator
 * can use it (a file outside `local-model/` may not import the engine). A dark
 * build never reaches it: its callers are the settings setter and prime, and
 * the collaborator's wiring, all behind `BYO_MODELS_ENABLED`. Nothing here
 * touches the disk at import.
 */

import path from "node:path";

import type { TandemNotification } from "../../shared/types.js";
import { generateMessageId } from "../../shared/utils.js";
import { atomicWriteConfigFile, readBoundedJsonFileSync } from "../integrations/storage.js";
import { notificationSubscriberCount, pushNotification } from "../notifications.js";
import { resolveAppDataDir } from "../platform.js";
import {
  addStartupNotice,
  onStartupNoticeDelivered,
  removeStartupNotice,
} from "../startup-notices.js";

export const LOCAL_MODEL_ANNOUNCED_FILE_NAME = "local-model-announced.json";
const VERSION = 1;
const MAX_BYTES = 4096;

interface Announced {
  /** Has a browser been told that commenting is on? */
  editing: boolean;
  /** Fingerprint of the answering model a browser was last told about. */
  answering: string | null;
}

let basePath: string | null = null;
let announced: Announced | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function filePath(): string {
  return path.join(basePath ?? resolveAppDataDir(), LOCAL_MODEL_ANNOUNCED_FILE_NAME);
}

function load(): Announced {
  if (announced) return announced;
  const fresh: Announced = { editing: false, answering: null };
  try {
    const parsed = readBoundedJsonFileSync(filePath(), MAX_BYTES);
    if (parsed && parsed !== "unreadable" && typeof parsed === "object" && !Array.isArray(parsed)) {
      const r = parsed as Record<string, unknown>;
      if (Object.hasOwn(r, "version") && r.version === VERSION) {
        if (Object.hasOwn(r, "editing") && r.editing === true) fresh.editing = true;
        if (Object.hasOwn(r, "answering") && typeof r.answering === "string") {
          fresh.answering = r.answering;
        }
      }
    }
  } catch (err) {
    console.error(`[tandem] ${LOCAL_MODEL_ANNOUNCED_FILE_NAME} could not be read:`, err);
  }
  announced = fresh;
  return fresh;
}

function persist(): void {
  const snapshot = { version: VERSION, ...load() };
  const file = filePath();
  writeQueue = writeQueue
    .then(() => atomicWriteConfigFile(file, `${JSON.stringify(snapshot, null, 2)}\n`))
    .catch((err: unknown) => {
      // The cost is one repeated notice after the next start, never silence.
      console.error(
        `[tandem] ${LOCAL_MODEL_ANNOUNCED_FILE_NAME} could not be written (${
          err instanceof Error ? err.message : String(err)
        }).`,
      );
    });
}

function record(change: Partial<Announced>): void {
  Object.assign(load(), change);
  persist();
}

/** Was a browser already told that commenting is on? */
export function editingOnWasAnnounced(): boolean {
  return load().editing;
}

/** Was a browser already told about this answering model (by fingerprint)? */
export function answeringWasAnnounced(fingerprint: string): boolean {
  return load().answering === fingerprint;
}

/**
 * Raise one of the two notices: live to every connected browser, and
 * registered for replay to one that connects later in this run. The record on
 * disk is updated only once the notice has actually been written to a stream,
 * so a change nobody saw is announced again after a restart.
 */
export function announceLocalModelChange(
  dedupKey: string,
  message: string,
  delivered: Partial<Announced>,
): TandemNotification {
  const notice: TandemNotification = {
    id: generateMessageId(),
    type: "general-error",
    severity: "warning",
    message,
    dedupKey,
    timestamp: Date.now(),
  };
  addStartupNotice(notice);
  onStartupNoticeDelivered(dedupKey, () => record(delivered));
  // Count BEFORE pushing: a stream that connects during the push gets the
  // replay instead, and reports its own delivery.
  const listening = notificationSubscriberCount() > 0;
  pushNotification(notice);
  if (listening) record(delivered);
  return notice;
}

/**
 * Commenting was switched off. Off needs no announcement, so the pending
 * replay is withdrawn and the record cleared at once — the next On is then
 * announced afresh.
 */
export function recordEditingOff(dedupKey: string): void {
  removeStartupNotice(dedupKey);
  if (load().editing) record({ editing: false });
}

/** Wait for queued writes. Tests only. */
export function __flushLocalModelAnnouncedForTests(): Promise<void> {
  return writeQueue;
}

/** Test seam: point the module at a temp dir (or reset it) and forget state. */
export function __resetLocalModelAnnouncedForTests(base?: string): void {
  basePath = base ?? null;
  announced = null;
  writeQueue = Promise.resolve();
}
