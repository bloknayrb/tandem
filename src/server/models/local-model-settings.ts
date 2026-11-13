/**
 * `local-model-settings.json` — whether a local model may comment on and suggest
 * changes to the document (#1123, ADR-039's tiers).
 *
 * ADR-039 ships chat on by default and makes commenting and replacement an
 * opt-in, experimental tier. This file holds that one opt-in. It is off unless
 * this module read `editing: true` from a well-formed file.
 *
 * **A file of its own, not a field in `models.json`.** That registry's schema is
 * `.strict()` with a literal version, `POST /api/models` replaces the whole file
 * from a client projection that copies fields one by one, and the reconcile
 * action posts through it even while the feature is dark — so a field there is
 * erased by any Models write. `GET /api/models` also spreads the file's
 * top-level fields to a non-loopback caller. `launcher-settings.json` is the
 * wrong owner, writes only the fields it knows, and a version bump there makes
 * every older build refuse all launcher writes.
 *
 * **It lives in `models/`, not `local-model/`**, so the route can import it:
 * the dark audit in `tests/server/local-model/collaborator.test.ts` fails any
 * server file outside `local-model/` that imports the engine.
 *
 * **The read fails toward off.** Missing, unreadable, not a regular file,
 * oversized, not JSON, not an object, a `version` that is not exactly this
 * build's (missing, not a number, or a later build's), or `editing` anything
 * but the boolean `true`: off.
 *
 * **Off is immediate and the last request wins.** `setLocalModelEditing(false)`
 * changes the effective value synchronously, before any disk work, and bumps
 * `offEpoch` so a run in flight can see that an Off happened even if editing is
 * switched back on before its next tool call. On takes effect only after its
 * own write succeeded, and only if no later request arrived meanwhile — so an
 * On whose write is still in flight can never overrule a later Off.
 *
 * **A failed write converges the disk toward off.** If a write fails and the
 * effective value is off, the file is deleted (a missing file reads as off), so
 * a failed Off, or an On that published its bytes and then threw, cannot leave
 * `true` behind for the next start.
 *
 * **A later build's file can always be switched off, and is never switched on.**
 * Refusing every write to a newer file, as the launcher's file does, would
 * make it impossible to switch editing off. So an Off is written into a newer
 * file with its `version` and unknown keys kept; an On is NOT written there at
 * all — this build has declared it cannot read that schema, so it must not
 * stamp `editing: true` into it for the newer build to find. The On still
 * takes effect for this run of the server and is reported `persisted: false`.
 * A file of this build's own version carries its unknown keys through a write.
 *
 * **Who switched it on decides whether it is announced** (#2404). The route
 * accepts a request only from Tandem's own window (`own-window.ts`). A switch
 * made there is the user's own: no notice, and `local-model-announced.ts`
 * records it at once. A switch admitted through the development allowance is
 * not an own-window change and is announced exactly as #2403 built it: a
 * notice now, replayed to a browser that connects later in this run, recorded
 * as told once one of Tandem's own windows was sent it. Switching off
 * withdraws the replay. At start-up, commenting found on with no record of
 * the user choosing or being told it raises the start-up notice: a file
 * changed underneath, or restored, cannot become the silent baseline.
 *
 * Nothing here touches the disk at import. A dark build never calls
 * `primeLocalModelSettings` (the call sits inside the `BYO_MODELS_ENABLED`
 * block in `src/server/index.ts`) and its routes answer 404 before reaching
 * `setLocalModelEditing`, so it neither reads nor writes this file.
 */

import fs from "node:fs";
import path from "node:path";

import { atomicWriteConfigFile, readBoundedJsonFileSync } from "../integrations/storage.js";
import { resolveAppDataDir } from "../platform.js";
import {
  __resetLocalModelAnnouncedForTests,
  announceLocalModelChange,
  announceStartupMismatch,
  editingOnWasAnnounced,
  isFirstLitStart,
  recordEditingOff,
  recordSetByUser,
} from "./local-model-announced.js";
import type { ModelsWriteSource } from "./own-window.js";

export const LOCAL_MODEL_SETTINGS_FILE_NAME = "local-model-settings.json";
const LOCAL_MODEL_SETTINGS_VERSION = 1;
/** Two short fields. Anything bigger is not this file. */
const MAX_SETTINGS_BYTES = 4096;
/** Keys never copied from a file on disk into the object this module writes. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface LocalModelEditingState {
  /** May a local model comment, suggest and reply in threads right now? */
  enabled: boolean;
  /** Bumped on every Off request. A run compares it with the value it started
   *  on, so an Off followed by an On does not re-enable that run. */
  offEpoch: number;
}

export interface SetEditingResult {
  /** The effective value once this request settled. */
  editing: boolean;
  /** Did the disk end up agreeing with `editing`? */
  persisted: boolean;
}

let basePath: string | null = null;
let effective = false;
let offEpoch = 0;
/** Counts requests, so an On can tell whether a later request superseded it. */
let seq = 0;
let diskQueue: Promise<void> = Promise.resolve();

function filePath(): string {
  return path.join(basePath ?? resolveAppDataDir(), LOCAL_MODEL_SETTINGS_FILE_NAME);
}

function readObject(file: string): Record<string, unknown> | null {
  const parsed = readBoundedJsonFileSync(file, MAX_SETTINGS_BYTES);
  if (parsed === null || parsed === "unreadable") return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/** The file's `version` when it is one a LATER build wrote; else null. */
function newerVersion(obj: Record<string, unknown> | null): number | null {
  if (obj === null || !Object.hasOwn(obj, "version")) return null;
  const v = obj.version;
  return typeof v === "number" && Number.isFinite(v) && v > LOCAL_MODEL_SETTINGS_VERSION ? v : null;
}

function readEditing(file: string): boolean {
  const obj = readObject(file);
  // Own properties, exactly this build's version, and the boolean `true`.
  return (
    obj !== null &&
    Object.hasOwn(obj, "version") &&
    obj.version === LOCAL_MODEL_SETTINGS_VERSION &&
    Object.hasOwn(obj, "editing") &&
    obj.editing === true
  );
}

/** What was said when editing was last switched on; also its replay key. */
export const EDITING_ON_NOTICE_KEY = "local-model-editing-on";
export const EDITING_ON_NOTICE =
  "Local models were allowed to comment on and suggest changes to your documents. If you did not switch this on, switch it off in Settings → Models.";

function announceEditingOn(): void {
  // For a switch that did not come from Tandem's own window. Live for a browser
  // that is connected now, registered for one that connects later in this run,
  // and recorded as "told" only once one of Tandem's own windows was sent it —
  // so a switch nobody saw is announced again after a restart.
  announceLocalModelChange(EDITING_ON_NOTICE_KEY, EDITING_ON_NOTICE, { editing: true });
}

function serialize(file: string, editing: boolean): string {
  const existing = readObject(file);
  // Never lower a later build's version: keep it, so that build still
  // recognises its own file (and this one keeps reading it as off).
  const known = { version: newerVersion(existing) ?? LOCAL_MODEL_SETTINGS_VERSION, editing };
  if (existing) {
    const carried: Record<string, unknown> = {};
    for (const key of Object.keys(existing)) {
      if (UNSAFE_KEYS.has(key) || key === "version" || key === "editing") continue;
      carried[key] = existing[key];
    }
    const merged = `${JSON.stringify({ ...carried, ...known }, null, 2)}\n`;
    // A file past the read bound would read as off, so the carried keys are
    // dropped rather than let them push it over.
    if (Buffer.byteLength(merged, "utf8") <= MAX_SETTINGS_BYTES) return merged;
  }
  return `${JSON.stringify(known, null, 2)}\n`;
}

interface DiskOutcome {
  /** Did the requested value itself reach the disk? Only this lets an On take
   *  effect — the delete fallback converging the disk to off is not a saved On. */
  written: boolean;
  /** Does the disk now agree with the effective value? */
  agrees: boolean;
}

/** Write `editing`; on failure, if the effective value is off, remove the file
 *  so the next start cannot read `true`. Never throws. */
async function writeDisk(editing: boolean): Promise<DiskOutcome> {
  const file = filePath();
  if (editing && newerVersion(readObject(file)) !== null) {
    // An On is never stamped into a later build's file. It is "written" for
    // the purpose of taking effect now; `settled` reports it not persisted,
    // because this build reads that file as off.
    return { written: true, agrees: false };
  }
  try {
    await atomicWriteConfigFile(file, serialize(file, editing));
    return { written: true, agrees: true };
  } catch (err) {
    console.error(
      `[tandem] ${LOCAL_MODEL_SETTINGS_FILE_NAME} could not be written (${
        err instanceof Error ? err.message : String(err)
      }).`,
    );
  }
  if (effective) return { written: false, agrees: false };
  try {
    await fs.promises.rm(file, { force: true });
    return { written: false, agrees: !readEditing(file) };
  } catch (err) {
    console.error(
      `[tandem] ${LOCAL_MODEL_SETTINGS_FILE_NAME} could not be removed either (${
        err instanceof Error ? err.message : String(err)
      }); editing is off for this run of Tandem but may be on after a restart.`,
    );
    return { written: false, agrees: false };
  }
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = diskQueue.then(task, task);
  diskQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Read the file once at boot. Called only under `BYO_MODELS_ENABLED`. Never
 * throws. Applies its result only if no request has been made yet, so a prime
 * can never overrule an Off.
 */
export function primeLocalModelSettings(): void {
  // Decide "is this the first start with the flag on?" before anything in
  // this run could create either file it looks for (see the announced module).
  isFirstLitStart();
  let read = false;
  try {
    read = readEditing(filePath());
  } catch (err) {
    console.error(
      `[tandem] ${LOCAL_MODEL_SETTINGS_FILE_NAME} could not be read (${
        err instanceof Error ? err.message : String(err)
      }); local-model editing is off.`,
    );
  }
  if (seq !== 0) return;
  effective = read;
  // Commenting is on at start-up and the record does not say the user chose it
  // or was told: the file changed underneath, came from another build or a
  // restore, or the record of the user's own switch was lost. Say so now; the
  // first of Tandem's own windows to connect is sent it. Not part of the
  // first-lit-start baseline: no dark build can write this file.
  if (read && !editingOnWasAnnounced()) announceStartupMismatch({ editing: true });
  // Off at start-up, whatever the record says: clear a stale "told", so the
  // next On is announced (the record can outlive a failed write on Off, or a
  // settings file that fell back to off).
  if (!read) recordEditingOff(EDITING_ON_NOTICE_KEY);
}

/** The live setting plus the Off counter. Synchronous: read on every tool call. */
export function localModelEditingState(): LocalModelEditingState {
  return { enabled: effective, offEpoch };
}

export function isLocalModelEditingEnabled(): boolean {
  return effective;
}

/**
 * What a request reports. Taken AFTER every write queued so far has finished,
 * so a request that a later one superseded reports the value the server ended
 * on rather than its own stale view (an On overtaken by a second On must not
 * answer "off"). `persisted` is the disk agreeing with that value — and, for a
 * request that asked for On, the value actually being on: an On that left
 * editing off was not honoured, whatever the disk says.
 */
async function settled(requested: boolean): Promise<SetEditingResult> {
  await diskQueue;
  const onDisk = readEditing(filePath());
  const agrees = onDisk === effective;
  return { editing: effective, persisted: agrees && (effective || !requested) };
}

/**
 * Switch the setting. See the module header for the ordering guarantees.
 * `source` is how the request got in: `own-window` is the user's own change
 * (recorded, not announced); anything else is announced. Required, so a new
 * caller cannot default into either.
 */
export async function setLocalModelEditing(
  value: boolean,
  source: ModelsWriteSource | "unspecified",
): Promise<SetEditingResult> {
  const mine = ++seq;
  if (!value) {
    // Before any await: a run in flight stops writing at once.
    effective = false;
    offEpoch += 1;
    recordEditingOff(EDITING_ON_NOTICE_KEY);
    // A failed write that the delete fallback made good still leaves the disk
    // reading off, which is what was asked for.
    await enqueue(() => writeDisk(false));
    return settled(false);
  }
  await enqueue(async () => {
    const outcome = await writeDisk(true);
    // Only if the On itself was written, and nothing later arrived: an Off
    // issued while this write was in flight has already set `effective` and
    // queued its own write behind us.
    if (outcome.written && seq === mine) {
      const wasOn = effective;
      effective = true;
      // The user's own switch: the record says so at once, even when it was
      // already on (they have now chosen it themselves). Anything else is
      // announced on the transition.
      // The live notice is withdrawn: "if you did not switch this on" is no
      // longer a question once they have switched it on themselves.
      if (source === "own-window") void recordSetByUser({ editing: true }, EDITING_ON_NOTICE_KEY);
      else if (!wasOn) announceEditingOn();
    }
  });
  return settled(true);
}

/** Test seam: point the module at a temp dir (or reset it) and forget all state. */
export function __resetLocalModelSettingsForTests(base?: string): void {
  basePath = base ?? null;
  effective = false;
  offEpoch = 0;
  seq = 0;
  diskQueue = Promise.resolve();
  __resetLocalModelAnnouncedForTests(base);
}
