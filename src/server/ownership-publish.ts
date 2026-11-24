/**
 * The ownership state the editor reads, published and guarded (#2358 PR 5a-3,
 * ADR-054's 5a-3 amendment; ownership design §10.2, §10.3).
 *
 * **Ships dark.** Every export returns at its first line while ownership is
 * off: no observer is attached, no timer is armed, `Y_MAP_OPEN_DOCUMENTS`
 * entries carry no owner field (`publishedOwnerFields` answers undefined) and
 * `CTRL_ROOM` gains no key.
 *
 * Flag on, it owns three things:
 * - **The republish** ({@link requestOwnershipPublish}): step 4 of
 *   `setDocOwner`, a holder's grace starting or ending, presence, a new
 *   session, every change of the launcher's facts and a mode change ask it
 *   in full; a holder's check-in, a waiting-relevant user annotation event
 *   and an acknowledgement change ask it for those documents only. One microtask
 *   later it rewrites the owner fields of the last broadcast's tab list where
 *   they changed (`writePublishedOpenDocs`) and the composer summary where it
 *   changed. Coalesced, so a burst of changes costs one republish, and never
 *   inside a registry composite's synchronous run.
 * - **The chat republish** ({@link requestOwnershipChatPublish}, #2358 PR
 *   5d): any change to `CTRL_ROOM`'s chat map (a guard below, any origin),
 *   and a change of a message's owner, its loss, its carried-over status or a
 *   chat handover (the ownership module's chat sink), ask it. One microtask
 *   later it rewrites each unanswered message's facts under
 *   `Y_MAP_OWNERSHIP_CHAT` and the summary (its chat waiting and chat stale)
 *   where they changed, and the entries of the documents whose chat waiting
 *   time changed (`writePublishedOpenDocs`' narrow form). A full republish
 *   asked in the same run subsumes it.
 * - **The stale tick** (ownership design §10.2): every
 *   {@link OWNERSHIP_STALE_TICK_MS} the same republish, so a stale flag or a
 *   hint that turns on with time alone is published. It writes only on a
 *   change.
 * - **The guard** (ownership design §10.3): an observer on `documentMeta` in
 *   `CTRL_ROOM` and in every document room the broadcast writes, and on the
 *   summary key and (#2358 PR 5d) the per-message facts key in `CTRL_ROOM`'s
 *   `Y_MAP_USER_AWARENESS`. A transaction whose
 *   origin is not one of the server's own helpers (`shouldSkipChannel`'s set:
 *   `mcp`, `file-sync`, `internal`, `reload`, `mode-release`; a client's
 *   write arrives with its Hocuspocus connection, or no origin) that changes
 *   either key schedules a restore of that room, one per event-loop turn
 *   (`setImmediate`), however many writes arrive. The restore rebuilds from
 *   server state and writes only where the map differs, under `withInternal`
 *   (Bryan's pick "Yes, emit them (Recommended)", 2026-11-23: the resulting
 *   `document:*` events are accepted, #2069). It is attached when a broadcast
 *   writes a room and again from `onDocSwapped`, since Hocuspocus replaces
 *   the Y.Doc.
 */

import type * as Y from "yjs";
import {
  CTRL_ROOM,
  Y_MAP_CHAT,
  Y_MAP_DOCUMENT_META,
  Y_MAP_OPEN_DOCUMENTS,
  Y_MAP_OWNERSHIP_CHAT,
  Y_MAP_OWNERSHIP_SUMMARY,
  Y_MAP_USER_AWARENESS,
} from "../shared/constants.js";
import { shouldSkipChannel, withInternal } from "../shared/origins.js";
import { OWNERSHIP_STALE_TICK_MS } from "../shared/ownership-published.js";
import {
  publishedRoomIds,
  setOpenDocsWrittenListener,
  writePublishedOpenDocs,
} from "./documents/registry.js";
import { subscribe, unsubscribe } from "./events/queue.js";
import type { TandemEvent } from "./events/types.js";
import { CHAT_SCOPE, deliveryRegistry } from "./mcp/inbox-cursor.js";
import { ownershipEnabled } from "./ownership-flag.js";
import {
  chatDocumentsToRefresh,
  ownershipSummary,
  publishedChatOwners,
} from "./sessions/ownership.js";
import { getOrCreateDocument } from "./yjs/provider.js";

/** The Y.Docs whose `documentMeta` is guarded. A swapped room is a new Y.Doc. */
const guardedMeta = new WeakSet<Y.Doc>();
/** The `CTRL_ROOM` Y.Docs whose summary and per-message facts keys are guarded. */
const guardedSummary = new WeakSet<Y.Doc>();
/** The `CTRL_ROOM` Y.Docs whose chat map asks the chat republish (#2358 PR 5d). */
const watchedChat = new WeakSet<Y.Doc>();

const restoreRooms = new Set<string>();
let summaryRestoreOwed = false;
let restoreScheduled: ReturnType<typeof setImmediate> | undefined;
let publishQueued = false;
/** A full republish is owed by the queued microtask. */
let fullOwed = false;
/** The chat republish is owed by the queued microtask (#2358 PR 5d). */
let chatOwed = false;
/** The documents a narrow republish (a holder's check-in) owes, when no full one is. */
const narrowOwed = new Set<string>();
let tick: ReturnType<typeof setInterval> | undefined;
let restoresForTests = 0;

/** Fixed text: nothing from the error, no room and no record. */
const PUBLISH_FAILED =
  "[ownership] the published ownership state could not be written; the next change or tick writes it.";
const RESTORE_FAILED =
  "[ownership] a client's write to the published ownership state could not be restored; the next change or tick restores it.";
const GUARD_FAILED =
  "[ownership] the guard on the published ownership state could not be attached to a room; the next broadcast attaches it.";

/** A write the server's own helpers made: never restored. */
function serverOrigin(origin: unknown): boolean {
  return shouldSkipChannel(origin);
}

/**
 * Guard one room's published state (ownership design §10.3): its
 * `documentMeta`'s `Y_MAP_OPEN_DOCUMENTS` and, for `CTRL_ROOM`, the summary
 * key. Idempotent per Y.Doc. Flag off it attaches nothing.
 */
export function guardOwnershipRoom(room: string, doc: Y.Doc): void {
  if (!ownershipEnabled()) return;
  try {
    if (!guardedMeta.has(doc)) {
      guardedMeta.add(doc);
      doc.getMap(Y_MAP_DOCUMENT_META).observe((event, txn) => {
        if (serverOrigin(txn.origin) || !event.keysChanged.has(Y_MAP_OPEN_DOCUMENTS)) return;
        restoreRooms.add(room);
        scheduleRestore();
      });
    }
    if (room === CTRL_ROOM && !guardedSummary.has(doc)) {
      guardedSummary.add(doc);
      doc.getMap(Y_MAP_USER_AWARENESS).observe((event, txn) => {
        if (serverOrigin(txn.origin)) return;
        if (
          !event.keysChanged.has(Y_MAP_OWNERSHIP_SUMMARY) &&
          !event.keysChanged.has(Y_MAP_OWNERSHIP_CHAT)
        ) {
          return;
        }
        summaryRestoreOwed = true;
        scheduleRestore();
      });
    }
    // #2358 PR 5d: any change to chat, whatever its origin (a user's message,
    // a reply that answers one, a handover's re-owe, a delete), may change a
    // message's facts, the summary's chat or a document's chat waiting.
    if (room === CTRL_ROOM && !watchedChat.has(doc)) {
      watchedChat.add(doc);
      doc.getMap(Y_MAP_CHAT).observe(() => requestOwnershipChatPublish());
    }
  } catch (err) {
    console.error(GUARD_FAILED, err instanceof Error ? err.name : "");
  }
}

/** Guard `CTRL_ROOM` and every room the last broadcast wrote. */
function guardPublishedRooms(): void {
  for (const room of publishedRoomIds()) guardOwnershipRoom(room, getOrCreateDocument(room));
  guardOwnershipRoom(CTRL_ROOM, getOrCreateDocument(CTRL_ROOM));
}

function scheduleRestore(): void {
  if (restoreScheduled !== undefined) return;
  restoreScheduled = setImmediate(runRestore);
}

function runRestore(): void {
  restoreScheduled = undefined;
  // The registry writes only `CTRL_ROOM` and the published rooms still open,
  // so a closed document's room is never restored.
  const rooms = [...restoreRooms];
  restoreRooms.clear();
  const summary = summaryRestoreOwed;
  summaryRestoreOwed = false;
  if (!ownershipEnabled()) return;
  try {
    restoresForTests++;
    if (rooms.length > 0) writePublishedOpenDocs(rooms);
    if (summary) {
      writeOwnershipSummary();
      writeChatOwners();
    }
  } catch {
    console.error(RESTORE_FAILED);
  }
}

/**
 * Write the composer summary into `CTRL_ROOM`'s `Y_MAP_USER_AWARENESS` where
 * it changed, under `withInternal`; delete a summary the server would not
 * write now (stdio mode, no launcher, or a client's forgery there). Flag off
 * it does nothing, so a dark server never writes the key.
 */
function writeOwnershipSummary(): void {
  if (!ownershipEnabled()) return;
  const summary = ownershipSummary();
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  guardOwnershipRoom(CTRL_ROOM, ctrl);
  const awareness = ctrl.getMap(Y_MAP_USER_AWARENESS);
  const current = awareness.get(Y_MAP_OWNERSHIP_SUMMARY);
  if (summary === undefined) {
    if (current !== undefined) {
      withInternal(ctrl, () => {
        awareness.delete(Y_MAP_OWNERSHIP_SUMMARY);
      });
    }
    return;
  }
  if (JSON.stringify(current ?? null) === JSON.stringify(summary)) return;
  withInternal(ctrl, () => {
    awareness.set(Y_MAP_OWNERSHIP_SUMMARY, summary);
  });
}

/**
 * Write each unanswered message's facts (#2358 PR 5d) under
 * `Y_MAP_OWNERSHIP_CHAT` in `CTRL_ROOM`'s `Y_MAP_USER_AWARENESS` where they
 * changed, under `withInternal`, in both transports (an empty object when no
 * message is unanswered, so a client tells "none" from "ownership off").
 * Flag off it does nothing, so a dark server never writes the key.
 */
function writeChatOwners(): void {
  if (!ownershipEnabled()) return;
  const owners = publishedChatOwners();
  if (owners === undefined) return;
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  guardOwnershipRoom(CTRL_ROOM, ctrl);
  const awareness = ctrl.getMap(Y_MAP_USER_AWARENESS);
  if (JSON.stringify(awareness.get(Y_MAP_OWNERSHIP_CHAT) ?? null) === JSON.stringify(owners)) {
    return;
  }
  withInternal(ctrl, () => {
    awareness.set(Y_MAP_OWNERSHIP_CHAT, owners);
  });
}

/** The republish: the owner fields, the summary and the chat facts, each only where changed. */
function publishNow(): void {
  if (!ownershipEnabled()) return;
  try {
    writePublishedOpenDocs();
    guardPublishedRooms();
    writeOwnershipSummary();
    writeChatOwners();
  } catch {
    console.error(PUBLISH_FAILED);
  }
}

/**
 * The chat republish (#2358 PR 5d): the per-message facts, the summary, and
 * the entries of the documents whose chat waiting time changed, each only
 * where it changed.
 */
function publishChatNow(): void {
  if (!ownershipEnabled()) return;
  try {
    writeChatOwners();
    writeOwnershipSummary();
    const documentIds = chatDocumentsToRefresh();
    if (documentIds.length > 0) writePublishedOpenDocs(undefined, new Set(documentIds));
  } catch {
    console.error(PUBLISH_FAILED);
  }
}

/**
 * Ask for a republish (step 4 of `setDocOwner` and the other askers in the
 * module doc), one microtask later and once however often it is asked in one
 * synchronous run. With `documentIds` (a holder's check-in) only those
 * entries are recomputed, unless a full republish is also asked in the same
 * run, which subsumes it. Flag off it does nothing.
 */
export function requestOwnershipPublish(documentIds?: readonly string[]): void {
  if (!ownershipEnabled()) return;
  if (documentIds === undefined) fullOwed = true;
  else for (const id of documentIds) narrowOwed.add(id);
  queuePublish();
}

/**
 * Ask for the chat republish (#2358 PR 5d): a change to chat, or to a
 * message's owner. Coalesced with {@link requestOwnershipPublish} into the
 * same microtask; a full republish owed there subsumes it. Flag off it does
 * nothing.
 */
export function requestOwnershipChatPublish(): void {
  if (!ownershipEnabled()) return;
  chatOwed = true;
  queuePublish();
}

function queuePublish(): void {
  if (publishQueued) return;
  publishQueued = true;
  queueMicrotask(() => {
    publishQueued = false;
    const full = fullOwed;
    const chat = chatOwed;
    const narrow = new Set(narrowOwed);
    fullOwed = false;
    chatOwed = false;
    narrowOwed.clear();
    // A full republish owed in the same run subsumes the narrow one and the chat one.
    if (full) {
      publishNow();
      return;
    }
    if (narrow.size > 0) publishDocsNow(narrow);
    if (chat) publishChatNow();
  });
}

/**
 * The narrow republish (#2358 PR 5a-3; Bryan, 2026-11-24: "Recompute own
 * docs (Recommended)"): only `documentIds`' entries are recomputed, every
 * other entry keeps what was last published, and only `Y_MAP_OPEN_DOCUMENTS`
 * is written, where it differs, under `withInternal`
 * (`writePublishedOpenDocs`'s narrow form). The summary is not touched: a
 * check-in changes nothing it reads.
 */
function publishDocsNow(documentIds: ReadonlySet<string>): void {
  if (!ownershipEnabled()) return;
  try {
    writePublishedOpenDocs(undefined, documentIds);
  } catch {
    console.error(PUBLISH_FAILED);
  }
}

/**
 * Whether `event` can change what `documentWaiting` counts on its document
 * (#2358 PR 5a-3 review): a user comment created or edited, or a user reply
 * (the waiting rule counts only user comments and user replies on a
 * Claude-facing thread; the rule itself decides, this only picks what is
 * worth asking it again). In Solo or with the mode unknown, `pushEvent`'s
 * privacy hold drops these before any subscriber, which is the waiting rule's
 * own answer there (it counts nothing unless the mode reads Tandem); the mode
 * change that ends the hold asks a full republish (`noteModeObserved`).
 */
function changesWaiting(event: TandemEvent): boolean {
  switch (event.type) {
    case "annotation:created":
    case "annotation:edited":
      return true;
    case "annotation:reply":
      return event.payload.replyAuthor === "user";
    default:
      return false;
  }
}

/**
 * A waiting-relevant event landed (#2358 PR 5a-3 review): ask the narrow
 * republish of its one document, so an "unowned-waiting" hint and
 * `waitingSince` appear at once (ADR-054's 5a-3 amendment). An event with
 * no document asks the full republish.
 */
function onWaitingEvent(event: TandemEvent): void {
  if (!changesWaiting(event)) return;
  if (event.documentId) requestOwnershipPublish([event.documentId]);
  else requestOwnershipPublish();
}

/**
 * The registry changed an acknowledgement in `scope` (#2358 PR 5a-3 review):
 * a check-in acknowledged items there (or a refused claim took one back, or
 * a handover retired one), which moves that document's waiting. Ask its
 * narrow republish, so a terminal's check-in that acknowledges a claimable
 * unowned document's items clears its hint at once, not only the documents
 * the poller holds. Chat acknowledgements move no document's waiting.
 */
function onAckChanged(scope: string): void {
  if (scope === CHAT_SCOPE) return;
  requestOwnershipPublish([scope]);
}

/**
 * Start publishing (`src/server/index.ts`, once at boot, both transports):
 * guard `CTRL_ROOM` and every room each broadcast writes, write the summary,
 * arm the stale tick (unref'd), and attach the two waiting triggers: an
 * `"internal"` event subscriber ({@link onWaitingEvent}; never `"external"`,
 * which would be a new AI surface, CLAUDE.md Critical Rule 9) and the
 * delivery registry's acknowledgement listener ({@link onAckChanged}). Flag
 * off it does nothing: no subscriber, no listener. Returns a stop function
 * (tests).
 */
export function startOwnershipPublishing(): () => void {
  if (!ownershipEnabled()) return () => {};
  setOpenDocsWrittenListener(guardPublishedRooms);
  // The queue's subscriber set makes a second start's subscribe a no-op.
  subscribe(onWaitingEvent, "internal");
  deliveryRegistry.setAckListener(onAckChanged);
  publishNow();
  if (tick === undefined) {
    tick = setInterval(publishNow, OWNERSHIP_STALE_TICK_MS);
    tick.unref?.();
  }
  return stopOwnershipPublishingForTests;
}

/** Tests only: stop the tick, drop pending restores and forget the listener. */
export function stopOwnershipPublishingForTests(): void {
  if (tick !== undefined) clearInterval(tick);
  tick = undefined;
  if (restoreScheduled !== undefined) clearImmediate(restoreScheduled);
  restoreScheduled = undefined;
  restoreRooms.clear();
  summaryRestoreOwed = false;
  publishQueued = false;
  fullOwed = false;
  chatOwed = false;
  narrowOwed.clear();
  restoresForTests = 0;
  setOpenDocsWrittenListener(undefined);
  unsubscribe(onWaitingEvent);
  deliveryRegistry.setAckListener(undefined);
}

/** Tests only: how many restore passes have run since the last stop. */
export function ownershipRestoresForTests(): number {
  return restoresForTests;
}

/** Tests only: run the stale tick's work now. */
export function runOwnershipTickForTests(): void {
  publishNow();
}
