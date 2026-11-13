/**
 * `local-model-announced.json` — what the user last set from Tandem's own
 * window, or was told, about the three things a local-model change can do
 * without their noticing: that local models may comment, which local model
 * would answer chat, and that the local model (not Claude) answers chat
 * (#1123, #2404; register entry #2410 in docs/security.md).
 *
 * **What each part means** (since the switch, ADR-039's 2026-11-12
 * amendment): `editing` — commenting is on, and the user chose it or was told;
 * `answering` — the fingerprint of the model that answers chat WHEN the local
 * model is chosen (the model's identity alone, whatever the switch says);
 * `adopted` — the first lit start's baseline model, not yet named to one of
 * Tandem's windows; `answererChosen` — the user chose the local model in
 * Tandem's own window (the only state the "answered by Claude again" notice
 * is raised for); `answererLocal` — the switch is at the local model, and
 * the user chose it or was told. The switch is never part of the baseline.
 *
 * **Who can change those settings now.** The two routes accept a request only
 * from Tandem's own window (`own-window.ts`), so a web page on another
 * loopback port can no longer change either. A change from Tandem's own window
 * is the user's: it raises no warning, and the record is updated to match it
 * at once (`recordSetByUser`). What is left that can make the settings on disk
 * differ from this record:
 *  - a process writing `models.json`, `local-model-settings.json` or
 *    `chat-answerer.json` directly;
 *  - data from another build, or a restored copy of Tandem's data;
 *  - a record write that failed after the user's own change;
 *  - a write admitted through the development allowance
 *    (`TANDEM_MODELS_DEV_ORIGIN`), which is NOT an own-window write and is
 *    announced as it happens, as #2403 built it (`announceLocalModelChange`).
 *
 * **The start-up check.** Start-up compares the settings it finds with this
 * record and, where they differ, raises ONE notice (`announceStartupMismatch`)
 * whose copy claims no more than is known. It is held for the first of
 * Tandem's own windows to connect, and "told" is recorded when it is written
 * to such a stream (`isTandemOwnWindow` in the notify-stream route). That is
 * still a stream write, not a person reading, and it is acceptable now for a
 * different reason than before: a page on another port can no longer create
 * the mismatch, and whoever can — a process writing the files — could rewrite
 * this record too. The one exception is the development allowance: a page on
 * the allowed port can make a change and then open Tandem's page in a pop-up,
 * whose stream counts. The register says so.
 *
 * The notice's parts are kept CURRENT while it waits: a later change to which
 * model answers replaces the fingerprint it will record, and Off or "no model
 * answers" removes its part. So what delivery records is the state as of
 * delivery, never a value captured at boot — otherwise the user's own change,
 * made before their window's stream connected, would be overwritten by the
 * older value and announced, falsely, at the next start.
 *
 * **The first start with the flag on** takes the answering model it finds as
 * the baseline, so nobody is warned at the flip for something they did not do:
 * a dark build's one-time reconcile writes `models.json` from the browser's
 * stored models, and nothing records it, because nothing here runs while dark.
 * "First" is a durable marker of its own (`local-model-baseline.json`), never
 * inferred from a missing record alone: the baseline is taken only when the
 * marker does not exist AND no record exists (both absent is the upgrading
 * cohort's state). Anything else found at either path — a file of any content,
 * a directory, a link, an unreadable entry — counts as present, so a lost
 * record or a lost marker fails toward announcing. The baseline covers the
 * answering model only: commenting found switched on at a first lit start is
 * still announced, because no dark build can write that file. **And the
 * baseline says what it adopted**: every release through v0.31.0 let a page on
 * any `127.0.0.1` port save a model while dark, so a silent baseline could
 * adopt a planted one. When a model is adopted, one neutral notice names it
 * (`announceBaselineAdopted`), held for the first of Tandem's own windows like
 * the start-up notice. Until such a window was sent it, the record keeps the
 * adopted fingerprint (`adopted`), so a later start raises it again; the
 * user's own choice of a model, or no model answering, ends it. The marker is
 * written at the end of the collaborator's wiring, after the baseline record
 * itself reached the disk; a crash before that repeats the baseline at the
 * next start, which is harmless. It is also written in a lit stdio-mode start,
 * where no window exists; that is harmless too.
 *
 * The read fails toward announcing: a missing, unreadable, linked, oversized,
 * malformed or newer-version file reads as "nothing was ever recorded". A
 * failed write is remembered (`unsaved`) and tried again by the next change,
 * Off, "no model answers" or announcement — including one that arrives while
 * the failing write is still in flight — and start-up clears the record again
 * whenever commenting is off or no local model answers. What is left is a disk
 * that refuses every one of those writes. That is logged; it costs a repeated
 * notice, and (because the marker is written only after the record) it also
 * makes every start a "first lit start" for the answering model, which only
 * matters if something else is writing the model file meanwhile.
 *
 * It lives in `models/` so that both the settings module and the collaborator
 * can use it (a file outside `local-model/` may not import the engine). A dark
 * build never reaches it: its callers are the settings setter and prime, and
 * the collaborator's wiring, all behind `BYO_MODELS_ENABLED`. The route
 * handlers never call it — `POST /api/models` runs while dark. Nothing here
 * touches the disk at import.
 */

import fs from "node:fs";
import path from "node:path";

import type { TandemNotification } from "../../shared/types.js";
import { generateMessageId } from "../../shared/utils.js";
import { atomicWriteConfigFile, readBoundedJsonFileSync } from "../integrations/storage.js";
import { ownWindowSubscriberCount, pushNotification } from "../notifications.js";
import { resolveAppDataDir } from "../platform.js";
import {
  addStartupNotice,
  getStartupNotices,
  onStartupNoticeDelivered,
  removeStartupNotice,
} from "../startup-notices.js";

export const LOCAL_MODEL_ANNOUNCED_FILE_NAME = "local-model-announced.json";
/** Written once, at the first start with the flag on. See the module header. */
export const LOCAL_MODEL_BASELINE_FILE_NAME = "local-model-baseline.json";
const VERSION = 1;
const MAX_BYTES = 4096;

/** Replay key and text of the start-up notice (#2404). The text claims no
 *  more than is known, and carries no endpoint, path or credential. */
export const SETTINGS_CHANGED_NOTICE_KEY = "local-model-settings-changed";
export const SETTINGS_CHANGED_NOTICE =
  "Your local-model settings changed since Tandem last recorded them. If you did not change them, check Settings → Models: remove any model you do not recognise, switch commenting off, and set who answers your chat back to Claude. This can also appear after an upgrade or after restoring Tandem's data.";
/** The same notice when its parts include the switch: it says first that chat
 *  is now answered by a local model (#1123), which is what the user most needs
 *  to know. One replay key, so the parts still merge into one notice. */
export const SETTINGS_CHANGED_ANSWERER_LOCAL_NOTICE =
  "Your chat is now set to be answered by a local model, and your local-model settings changed since Tandem last recorded them. If you did not change them, check Settings → Models: set who answers your chat back to Claude, remove any model you do not recognise, and switch commenting off. This can also appear after an upgrade or after restoring Tandem's data.";

/** Replay key of the notice that chat is answered by Claude again although the
 *  user's recorded choice was the local model, by anything but their own
 *  choice in Tandem's own window (#1123, Bryan's decision 2026-11-12). */
export const ANSWERER_CLAUDE_NOTICE_KEY = "local-model-answerer-claude";

interface Announced {
  /** Did the user switch commenting on themselves, or were they told it is on? */
  editing: boolean;
  /** Fingerprint of the answering model the user last chose or was told about. */
  answering: string | null;
  /** Fingerprint of a model taken as the baseline at the first lit start whose
   *  "this model was adopted" notice no window of Tandem's has been sent yet.
   *  Written to the file only while set. */
  adopted: string | null;
  /** Did the user choose the local model to answer chat in Tandem's own
   *  window, or were they told it does? (`chat-answerer.ts`.) Written to the
   *  file only while set, so a record without it is byte-identical to one an
   *  older build wrote. An older build reads only the fields it knows and
   *  writes only those, so a downgrade drops it and the next start of this
   *  build announces a stored "local model" again: accepted. */
  answererLocal: boolean;
  /** Narrower: the user CHOSE the local model in Tandem's own window (not
   *  merely told). Only this makes "chat is answered by Claude again, not as
   *  you chose" true (#1123 review round 2). Written only while set. */
  answererChosen: boolean;
  /** An "answered by Claude again" notice is owed and no window of Tandem's
   *  has been sent it yet: its cause, kept so a restart cannot spend it
   *  (#1123 review round 3). Written only while set. */
  claudeAgainOwed: string | null;
  /** Tandem removed `chat-answerer.json` itself and could leave no marker
   *  beside it (#1123 A2, R7.3), so a missing file at the next start is not
   *  told as "was removed". Written only while set; cleared once the file
   *  holds a value again. */
  removedByTandem: boolean;
}

let basePath: string | null = null;
let announced: Announced | null = null;
let writeQueue: Promise<void> = Promise.resolve();
/** The last write failed, so the file may say more than the record does. */
let unsaved = false;
/** What the file is known to say about `answererChosen`: set by each write
 *  that lands, and by the first load. */
let chosenOnDisk = false;
/** Writes queued and not yet settled. One of them may still fail. */
let inFlight = 0;
/** What the pending start-up notice will record when it is delivered. */
let startupParts: Partial<Announced> | null = null;
/** Memo of the first-lit-start decision, and whether the marker was missing. */
let firstLit: boolean | null = null;
let markerMissing = false;
let markerQueued = false;
let markerWrite: Promise<void> = Promise.resolve();

function dir(): string {
  return basePath ?? resolveAppDataDir();
}

function filePath(): string {
  return path.join(dir(), LOCAL_MODEL_ANNOUNCED_FILE_NAME);
}

function markerPath(): string {
  return path.join(dir(), LOCAL_MODEL_BASELINE_FILE_NAME);
}

function load(): Announced {
  if (announced) return announced;
  const fresh: Announced = {
    editing: false,
    answering: null,
    adopted: null,
    answererLocal: false,
    answererChosen: false,
    claudeAgainOwed: null,
    removedByTandem: false,
  };
  try {
    const parsed = readBoundedJsonFileSync(filePath(), MAX_BYTES);
    if (parsed && parsed !== "unreadable" && typeof parsed === "object" && !Array.isArray(parsed)) {
      const r = parsed as Record<string, unknown>;
      if (Object.hasOwn(r, "version") && r.version === VERSION) {
        if (Object.hasOwn(r, "editing") && r.editing === true) fresh.editing = true;
        if (Object.hasOwn(r, "answering") && typeof r.answering === "string") {
          fresh.answering = r.answering;
        }
        if (Object.hasOwn(r, "adopted") && typeof r.adopted === "string") {
          fresh.adopted = r.adopted;
        }
        if (Object.hasOwn(r, "answererLocal") && r.answererLocal === true) {
          fresh.answererLocal = true;
        }
        if (Object.hasOwn(r, "answererChosen") && r.answererChosen === true) {
          fresh.answererChosen = true;
        }
        if (
          Object.hasOwn(r, "claudeAgainOwed") &&
          typeof r.claudeAgainOwed === "string" &&
          r.claudeAgainOwed.length <= 32
        ) {
          fresh.claudeAgainOwed = r.claudeAgainOwed;
        }
        if (Object.hasOwn(r, "removedByTandem") && r.removedByTandem === true) {
          fresh.removedByTandem = true;
        }
      }
    }
  } catch (err) {
    console.error(`[tandem] ${LOCAL_MODEL_ANNOUNCED_FILE_NAME} could not be read:`, err);
  }
  announced = fresh;
  chosenOnDisk = fresh.answererChosen;
  return fresh;
}

/** Queue a write of the record as it stands WHEN THE WRITE RUNS, so a retry
 *  never publishes an older state. Resolves to whether it reached the disk. */
function persist(overlay?: Partial<Announced>): Promise<boolean> {
  const file = filePath();
  inFlight += 1;
  const run = writeQueue
    .then(async () => {
      // `overlay`: a change that reaches memory only once this write lands
      // (#1123 A2, R7.1) — so a failed write leaves the record as it was, and
      // no later write can persist a change that never happened.
      const { adopted, answererLocal, answererChosen, claudeAgainOwed, removedByTandem, ...rest } =
        { ...load(), ...(overlay ?? {}) };
      const snapshot = {
        version: VERSION,
        ...rest,
        ...(adopted === null ? {} : { adopted }),
        ...(answererLocal ? { answererLocal: true } : {}),
        ...(answererChosen ? { answererChosen: true } : {}),
        ...(claudeAgainOwed !== null ? { claudeAgainOwed } : {}),
        ...(removedByTandem ? { removedByTandem: true } : {}),
      };
      await atomicWriteConfigFile(file, `${JSON.stringify(snapshot, null, 2)}\n`);
      chosenOnDisk = answererChosen;
      if (overlay) Object.assign(load(), overlay);
      unsaved = false;
      return true;
    })
    .catch((err: unknown) => {
      unsaved = true;
      // The cost is usually one repeated notice after the next start. Where a
      // lost write would instead mean silence — the user's own switch to the
      // local model, whose record is what lets a later change back to Claude
      // be announced — the caller waits on this result and fails (#1123
      // round 5 PD).
      console.error(
        `[tandem] ${LOCAL_MODEL_ANNOUNCED_FILE_NAME} could not be written (${
          err instanceof Error ? err.message : String(err)
        }).`,
      );
      return false;
    })
    .finally(() => {
      // Never below zero: a test reset may have zeroed it under this write.
      inFlight = Math.max(0, inFlight - 1);
    });
  writeQueue = run.then(() => undefined);
  return run;
}

/** Is the file possibly behind the record? True while a write is unsettled
 *  too: it may yet fail, and nothing later would know to try again. */
function needsRetry(): boolean {
  return unsaved || inFlight > 0;
}

/** Change the record and queue its write; resolves to whether it landed. */
function record(change: Partial<Announced>): Promise<boolean> {
  Object.assign(load(), change);
  return persist();
}

/** Keep the pending start-up notice's answering part current (module header). */
function refreshStartupAnswering(fingerprint: string): void {
  if (startupParts && Object.hasOwn(startupParts, "answering")) {
    startupParts.answering = fingerprint;
  }
}

function dropStartupPart(part: keyof Announced): void {
  if (!startupParts || !Object.hasOwn(startupParts, part)) return;
  delete startupParts[part];
  if (Object.keys(startupParts).length === 0) {
    startupParts = null;
    removeStartupNotice(SETTINGS_CHANGED_NOTICE_KEY);
    return;
  }
  // The waiting notice's text follows its parts: without the switch part it
  // must no longer say chat is answered by a local model.
  const waiting = getStartupNotices().find((n) => n.dedupKey === SETTINGS_CHANGED_NOTICE_KEY);
  if (waiting) addStartupNotice({ ...waiting, message: startupMessage() });
}

function startupMessage(): string {
  return startupParts && Object.hasOwn(startupParts, "answererLocal")
    ? SETTINGS_CHANGED_ANSWERER_LOCAL_NOTICE
    : SETTINGS_CHANGED_NOTICE;
}

/** Was commenting switched on by the user, or were they told it is on? */
export function editingOnWasAnnounced(): boolean {
  return load().editing;
}

/** Did the user choose this answering model, or were they told about it? */
export function answeringWasAnnounced(fingerprint: string): boolean {
  return load().answering === fingerprint;
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch (err) {
    // Only "there is nothing here" is absent. Anything else found, or any
    // other failure to look, counts as present: fail toward announcing.
    return (err as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
}

/**
 * Is this the first start with the flag on? Decided once per process, from
 * `lstat` alone: true only when neither the marker nor the record exists.
 * Called at the top of `primeLocalModelSettings`, before anything could write
 * either file, and consulted by the collaborator's wiring.
 */
export function isFirstLitStart(): boolean {
  if (firstLit === null) {
    markerMissing = !exists(markerPath());
    firstLit = markerMissing && !exists(filePath());
  }
  return firstLit;
}

/**
 * The end of the collaborator's wiring. Writes the marker if it was missing —
 * at a first lit start only after the record itself (the baseline, even an
 * empty one) reached the disk, so either file alone ends the baseline and a
 * crash in between cannot leave a marker with no record.
 */
export function finishFirstLitStart(): void {
  const first = isFirstLitStart();
  if (!markerMissing || markerQueued) return;
  markerQueued = true;
  const file = markerPath();
  const recorded = first ? persist() : Promise.resolve(true);
  markerWrite = recorded.then(async (ok) => {
    if (!ok) return;
    try {
      await atomicWriteConfigFile(file, `${JSON.stringify({ version: VERSION }, null, 2)}\n`);
    } catch (err) {
      console.error(
        `[tandem] ${LOCAL_MODEL_BASELINE_FILE_NAME} could not be written (${
          err instanceof Error ? err.message : String(err)
        }).`,
      );
    }
  });
}

/** The first lit start found this model answering: take it as the baseline,
 *  and remember that the user has not yet been told which model that was. */
export function recordBaselineAnswering(fingerprint: string): void {
  void record({ answering: fingerprint, adopted: fingerprint });
}

/** Replay key of the "this model was adopted at the first lit start" notice. */
export const BASELINE_ADOPTED_NOTICE_KEY = "local-model-baseline-adopted";

/** Is `fingerprint` a baseline whose notice no window of Tandem's was sent? */
export function baselineAdoptionPending(fingerprint: string): boolean {
  return load().adopted === fingerprint;
}

/**
 * Say which model the baseline adopted. Raised at the first lit start, and
 * again at any later start while `adopted` still names the answering model;
 * recorded as told once one of Tandem's own windows was sent it.
 */
export function announceBaselineAdopted(message: string): TandemNotification {
  return raise(BASELINE_ADOPTED_NOTICE_KEY, message, () => {
    if (load().adopted !== null) void record({ adopted: null });
  });
}

/** The adopted model is no longer the question because the USER settled it:
 *  they chose a model in Tandem's own window, or none answers any more. In
 *  memory; the caller's own write carries it to the file. */
function forgetAdoption(): void {
  removeStartupNotice(BASELINE_ADOPTED_NOTICE_KEY);
  load().adopted = null;
}

/**
 * Another writer changed which model answers (the development allowance, or
 * the files underneath). The adopted notice names a model that may no longer
 * answer, so its replay is withdrawn — but `adopted` STAYS in the record until
 * the user is actually told about the new state. Dropping it here would let an
 * unrelated write persist "answering: X" with no "not yet told", and X coming
 * back undelivered would then start silently.
 */
function withdrawAdoptionNotice(): void {
  removeStartupNotice(BASELINE_ADOPTED_NOTICE_KEY);
}

/**
 * A change accepted from Tandem's own window: the user's own. No notice; the
 * record matches it at once. `withdrawKey` names a pending LIVE notice that
 * this change makes stale (the answering one names a model).
 */
export function recordSetByUser(
  change: Partial<Announced>,
  withdrawKey?: string,
): Promise<boolean> {
  if (withdrawKey !== undefined) removeStartupNotice(withdrawKey);
  if (typeof change.answering === "string") {
    refreshStartupAnswering(change.answering);
    forgetAdoption();
  }
  // Their own On answers "your settings changed … switch commenting off" for
  // the commenting half: that part of a pending start-up notice is withdrawn.
  if (change.editing === true) dropStartupPart("editing");
  // Their own switch to the local model answers the start-up notice's "set
  // who answers your chat back to Claude" half: that part is withdrawn, and so
  // is a waiting "your chat is answered by Claude again" notice.
  if (change.answererLocal === true) {
    dropStartupPart("answererLocal");
    removeStartupNotice(ANSWERER_CLAUDE_NOTICE_KEY);
  }
  return record(change);
}

/**
 * The user's own switch to the local model (#1123 A2, R7.1): recorded as
 * chosen, and the notices it answers withdrawn, only once the write LANDS.
 * Until then memory is unchanged, so a failed write leaves no trace a later
 * write could persist: a switch that did not happen is never on record, and
 * a waiting start-up or "answered by Claude again" notice still stands.
 */
export async function recordAnswererLocalChosen(withdrawKey: string): Promise<boolean> {
  const landed = await persist({ answererLocal: true, answererChosen: true });
  if (!landed) return false;
  removeStartupNotice(withdrawKey);
  dropStartupPart("answererLocal");
  removeStartupNotice(ANSWERER_CLAUDE_NOTICE_KEY);
  return true;
}

/** Tandem removed the switch file and could leave no marker (R7.3). */
export function noteAnswererFileRemovedByTandem(): void {
  if (!load().removedByTandem) void record({ removedByTandem: true });
}

/** Did Tandem remove the switch file itself with no marker left? */
export function answererFileRemovedByTandem(): boolean {
  return load().removedByTandem;
}

/** The switch file holds a value again: a removal record no longer applies. */
export function clearAnswererFileRemovedByTandem(): void {
  if (load().removedByTandem) void record({ removedByTandem: false });
}

/** An own-window write that changed nothing recorded here: nothing to record,
 *  but a record write that failed (or may yet fail) is tried again now. */
export function retryUnsavedRecord(): void {
  if (needsRetry()) void persist();
}

function raise(dedupKey: string, message: string, onDelivered: () => void): TandemNotification {
  const notice: TandemNotification = {
    id: generateMessageId(),
    type: "general-error",
    severity: "warning",
    message,
    dedupKey,
    timestamp: Date.now(),
  };
  addStartupNotice(notice);
  onStartupNoticeDelivered(dedupKey, onDelivered);
  // Count BEFORE pushing: a stream that connects during the push gets the
  // replay instead, and reports its own delivery.
  const listening = ownWindowSubscriberCount() > 0;
  pushNotification(notice);
  if (listening) onDelivered();
  // Nobody was sent this, so nothing new is recorded — but if an earlier write
  // failed, or is still in flight and may fail, the file may still say "told"
  // about exactly this state (a failed clear on Off, then On again). Write the
  // record as it stands, or the next start would read the stale file and stay
  // silent.
  else if (needsRetry()) void persist();
  return notice;
}

/**
 * Raise one of the two LIVE notices, for a change that was not made from
 * Tandem's own window (the development allowance): live to every connected
 * browser, and registered for replay to one that connects later in this run.
 * The record on disk is updated only once the notice has actually been written
 * to one of Tandem's own windows, so a change nobody saw is announced again
 * after a restart.
 */
export function announceLocalModelChange(
  dedupKey: string,
  message: string,
  delivered: Partial<Announced>,
): TandemNotification {
  const aboutAnswering = typeof delivered.answering === "string";
  if (aboutAnswering) {
    refreshStartupAnswering(delivered.answering as string);
    withdrawAdoptionNotice();
  }
  // Told about a model: whatever was adopted earlier is no longer pending.
  return raise(dedupKey, message, () =>
    record(aboutAnswering ? { ...delivered, adopted: null } : delivered),
  );
}

/**
 * Start-up found the settings on disk differing from the record. Both callers
 * (commenting on; a model answering) merge into ONE notice.
 */
export function announceStartupMismatch(part: Partial<Announced>): TandemNotification {
  if (Object.hasOwn(part, "answering")) withdrawAdoptionNotice();
  startupParts = { ...(startupParts ?? {}), ...part };
  return raise(SETTINGS_CHANGED_NOTICE_KEY, startupMessage(), () => {
    // The parts as they stand NOW, not as they were when this was raised. Once
    // told which model answers, an earlier adoption is no longer pending.
    if (!startupParts) return;
    record(
      Object.hasOwn(startupParts, "answering")
        ? { ...startupParts, adopted: null }
        : { ...startupParts },
    );
  });
}

/** No local model would answer any more: forget which one the user chose or
 *  was told about, so that one answering again — the same one included — is
 *  compared afresh. */
export function recordAnsweringNone(dedupKey?: string): void {
  // Withdraw a notice still waiting to be replayed: it names a model that no
  // longer answers, and its delivery would record that model as told.
  if (dedupKey !== undefined) removeStartupNotice(dedupKey);
  dropStartupPart("answering");
  const hadAdoption = load().adopted !== null;
  forgetAdoption();
  if (load().answering !== null || hadAdoption) void record({ answering: null });
  // Nothing to change in memory, but an earlier clearing write may have failed:
  // the file could still name a model, and this is the next chance to fix it.
  else retryUnsavedRecord();
}

/**
 * Commenting was switched off. Off needs no announcement, so the pending
 * replay is withdrawn and the record cleared at once — the next On is then
 * compared afresh.
 */
export function recordEditingOff(dedupKey: string): void {
  removeStartupNotice(dedupKey);
  dropStartupPart("editing");
  if (load().editing) void record({ editing: false });
  // A repeated Off: the earlier clearing write may have failed. Try it again.
  else retryUnsavedRecord();
}

/** Is the record file possibly behind memory (a write failed, or is still in
 *  flight and may fail)? */
export function answererRecordUnsaved(): boolean {
  return needsRetry();
}

/** May the record FILE still say the user chose the local model (memory says
 *  not, but the write that cleared it failed or has not landed)? */
export function answererChosenMayBeOnDisk(): boolean {
  return chosenOnDisk || (inFlight > 0 && load().answererChosen);
}

/** Did the user choose the local model to answer chat, or were they told? */
export function answererLocalWasAnnounced(): boolean {
  return load().answererLocal;
}

/** Did the user CHOOSE the local model in Tandem's own window? */
export function answererLocalWasChosen(): boolean {
  return load().answererChosen;
}

/** Withdraw a waiting "answered by Claude again" notice, and forget that it
 *  is owed: the local model answers again, however that came about. */
export function withdrawAnswererClaudeNotice(): void {
  removeStartupNotice(ANSWERER_CLAUDE_NOTICE_KEY);
  if (load().claudeAgainOwed !== null) void record({ claudeAgainOwed: null });
}

/** The cause of an "answered by Claude again" notice still owed, or null. */
export function answererClaudeOwed(): string | null {
  return load().claudeAgainOwed;
}

export function recordAnswererClaude(dedupKey: string): Promise<boolean> {
  removeStartupNotice(dedupKey);
  removeStartupNotice(ANSWERER_CLAUDE_NOTICE_KEY);
  dropStartupPart("answererLocal");
  const r = load();
  if (r.answererLocal || r.answererChosen || r.claudeAgainOwed !== null) {
    return record({ answererLocal: false, answererChosen: false, claudeAgainOwed: null });
  }
  // A repeated switch: the earlier clearing write may have failed. Try again.
  if (needsRetry()) return persist();
  return Promise.resolve(true);
}

/**
 * Chat is answered by Claude again although the record says the user chose
 * the local model, and the user did not choose Claude in Tandem's own window
 * (Bryan, 2026-11-12: "Announce it"). A warning of the existing kind, live and
 * for replay. When one of Tandem's own windows was sent it, the record's
 * `answererLocal` is cleared — unless `keepRecord` (a read that failed at
 * start-up, which may be transient: the next clean start that reads "local"
 * then restores the user's choice with no false "settings changed" warning).
 * Until it is delivered the record keeps the choice, so a restart before any
 * window connected announces it again.
 */
export function announceAnswererClaude(
  message: string,
  opts: { keepRecord: boolean; cause: string },
): TandemNotification {
  dropStartupPart("answererLocal");
  // Owed durably until one of Tandem's own windows was sent it: a restart in
  // between raises it again from the record (#1123 review round 3).
  if (load().claudeAgainOwed !== opts.cause) void record({ claudeAgainOwed: opts.cause });
  return raise(ANSWERER_CLAUDE_NOTICE_KEY, message, () => {
    void record(
      opts.keepRecord
        ? { claudeAgainOwed: null }
        : { answererLocal: false, answererChosen: false, claudeAgainOwed: null },
    );
  });
}

/** Wait for queued writes, the marker included. Tests only. */
export async function __flushLocalModelAnnouncedForTests(): Promise<void> {
  await writeQueue;
  await markerWrite;
  await writeQueue;
}

/** Test seam: point the module at a temp dir (or reset it) and forget state. */
export function __resetLocalModelAnnouncedForTests(base?: string): void {
  basePath = base ?? null;
  announced = null;
  unsaved = false;
  chosenOnDisk = false;
  inFlight = 0;
  startupParts = null;
  firstLit = null;
  markerMissing = false;
  markerQueued = false;
  markerWrite = Promise.resolve();
  writeQueue = Promise.resolve();
}
