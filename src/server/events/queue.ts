/**
 * Event queue that observes Y.Map changes and emits TandemEvents.
 *
 * Observers filter by transaction origin — MCP-origin writes are skipped so
 * Claude doesn't see its own actions echoed back, and file-sync-origin writes
 * are skipped so disk reloads don't fire spurious SSE events. Only
 * browser-originated changes generate channel events.
 */

import * as Y from "yjs";
import {
  CHANNEL_EVENT_BUFFER_AGE_MS,
  CHANNEL_EVENT_BUFFER_SIZE,
  CTRL_ROOM,
} from "../../shared/constants.js";
import {
  resetForTesting as dirtyResetForTesting,
  registerDirtyObserver,
} from "../documents/dirty.js";
import { readModeState } from "../mode.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import {
  clearFileSyncContext,
  resetForTesting as fileSyncResetForTesting,
  reattachFileSyncObserver,
  setFileSyncContext,
} from "./file-sync-registry.js";
import { makeAnnotationsObserver } from "./observers/annotations.js";
import { makeAwarenessObserver } from "./observers/awareness.js";
import { makeCtrlChatObserver } from "./observers/ctrl-chat.js";
import { makeCtrlMetaObserver } from "./observers/ctrl-meta.js";
import { makeRepliesObserver } from "./observers/replies.js";
import type { BufferedSelection, TandemEvent } from "./types.js";
import { generateEventId } from "./types.js";

export { clearFileSyncContext, setFileSyncContext };

type EventCallback = (event: TandemEvent) => void;

/** Whether a subscriber represents a consumer outside this process. */
export type SubscriberKind = "external" | "internal";

const docObservers = new Map<string, Array<() => void>>();

/** Per-document selection buffer. Selections are stored here instead of being pushed as events. They get attached to the next chat:message for the same document. */
const selectionBuffer = new Map<string, BufferedSelection>();

/**
 * O(1) dedup: ref-counted annotation/message IDs that have been pushed via channel.
 *
 * Invariant: `count(id) === |{e ∈ buffer : tracked(e) ∧ getTrackableId(e) === id}|`.
 * `trackedEvents` is what makes that hold — tracking is conditional on having a
 * subscriber, so eviction must be conditional on the same fact (see `pushEvent`).
 *
 * Ids are process-global and NOT document-scoped. That matters because imported
 * Word annotation ids are deterministic across files: `importAnnotationId`
 * (file-io/docx-comments.ts) hashes only commentId + range + body text, by design,
 * so re-importing dedupes. The same Word comment living in two documents therefore
 * yields the same id in both, and promoting it in each ("Send to Claude") emits two
 * `annotation:created` events sharing that id. Consequence: `wasEmittedViaChannel`
 * can be true in document A because of a push that happened in document B. That is
 * within the advisory contract — the flag is a hint in both directions — but it is
 * why the ref count must be kept honest rather than treated as a per-item truth.
 */
const emittedPayloadIds = new Map<string, number>();

/**
 * Which buffered events actually incremented `emittedPayloadIds`.
 *
 * A side-table marker, not a weak reference — `buffer` strongly holds every event
 * until eviction, and eviction removes the entry explicitly. It lives here rather
 * than as a field on `TandemEvent` because that type is the SSE wire shape; a
 * bookkeeping boolean would serialize out to consumers.
 *
 * `let`, not `const`: `resetForTesting` must be able to reassign it. Clearing
 * `emittedPayloadIds` while this retained stale entries would reintroduce the very
 * asymmetry the pair exists to prevent — a retained event re-pushed after a reset
 * would take the delete branch on eviction with a count of zero and drop a
 * legitimately tracked sibling's id. The two are one invariant; reset them together.
 */
let trackedEvents = new WeakSet<TandemEvent>();

const buffer: TandemEvent[] = [];
const subscribers = new Set<EventCallback>();

/**
 * Subscribers that represent something OUTSIDE this process — an SSE consumer
 * (channel shim or plugin monitor). A subset of `subscribers`.
 *
 * The distinction is load-bearing, not bookkeeping. `src/server/local-model/
 * collaborator.ts` subscribes to the same fan-out; it is dark behind
 * `BYO_MODELS_ENABLED` today, but on that flip an enabled collaborator would hold
 * a permanent subscription with no external consumer attached. Counting it would
 * make `subscribers.size >= 1` always true, which (a) stamps every user comment
 * `alreadyPushed` on the strength of an in-process listener and (b) makes
 * `tandem doctor`'s "nothing is attached" branch unreachable — the exact false
 * signal both were written to remove. Anything answering "is push reaching
 * something outside this process?" must count THIS set.
 */
const externalSubscribers = new Set<EventCallback>();

export function getAnnotationEditedChannelKey(annotationId: string, editedAt: number): string {
  return `edited:${annotationId}:${editedAt}`;
}

function getTrackableId(event: TandemEvent): string | undefined {
  switch (event.type) {
    case "annotation:created":
    case "annotation:accepted":
    case "annotation:dismissed":
      return event.payload.annotationId;
    case "annotation:edited":
      return getAnnotationEditedChannelKey(event.payload.annotationId, event.payload.editedAt);
    case "annotation:reply":
      return event.payload.replyId;
    case "chat:message":
      return event.payload.messageId;
    default:
      return undefined;
  }
}

/** Returns whether this event actually carried a trackable id and was recorded. */
function trackPayloadId(event: TandemEvent): boolean {
  const id = getTrackableId(event);
  if (!id) return false;
  emittedPayloadIds.set(id, (emittedPayloadIds.get(id) ?? 0) + 1);
  return true;
}

/**
 * WS-A2: is this event the user's own annotation/reply CONTENT — the thing the
 * AI must not see in Solo? The three event types below are, by their observers'
 * own guards, only ever emitted for `author:"user"` (annotations.ts gates
 * created/edited on `author === "user"`; replies.ts gates on `reply.author ===
 * "user"`). The `replyAuthor` re-check is defensive, not load-bearing.
 *
 * Deliberately NARROW: accept/dismiss (status flips on Claude's OWN annotations)
 * and `document:*` lifecycle are NOT held here — they must still reach the
 * in-process collaborator (which uses `document:*` to abort in-flight runs) and
 * are suppressed from the external monitor at the SSE forwarder instead.
 */
function isUserPrivacyHeld(event: TandemEvent): boolean {
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

function untrackPayloadId(event: TandemEvent): void {
  const id = getTrackableId(event);
  if (!id) return;
  const count = emittedPayloadIds.get(id) ?? 0;
  if (count <= 1) emittedPayloadIds.delete(id);
  else emittedPayloadIds.set(id, count - 1);
}

function pushEvent(event: TandemEvent): void {
  // WS-A2 privacy hold: in Solo, drop the user's own annotation/reply content
  // BEFORE buffering, tracking, or fan-out — it reaches neither the SSE forwarder
  // nor the local-model collaborator. Skipping the track also keeps the released
  // item free of a stale `alreadyPushed` hint on the first post-release poll.
  // Release is pull-driven — `checkInbox` re-surfaces these once live mode reads
  // tandem (see mode.ts).
  if (isUserPrivacyHeld(event) && readModeState() === "solo") return;

  buffer.push(event);
  // Track only when the fan-out below is non-empty. "Pushed to nobody" is a fact
  // the server CAN establish, and asserting otherwise made `alreadyPushed` false
  // on every comment in the default install (no channel shim, no monitor, no SSE
  // consumer). What stays unknowable is whether an ATTACHED consumer's host did
  // anything with the notification — an inert channel shim accepts and discards.
  // So this narrows the lie, it does not eliminate it: `wasEmittedViaChannel` is
  // "handed to >=1 subscribed consumer", never "a model saw it". Nothing may
  // suppress on it.
  //
  // Record WHICH events were tracked. Eviction below must decrement only for those:
  // the gate above makes tracking conditional, so an unconditional untrack lets an
  // untracked event's eviction delete a tracked sibling's entry whenever the two
  // share a trackable id (see the `emittedPayloadIds` docblock — reachable today
  // via the same imported Word comment promoted in two documents).
  // Only mark events that actually recorded an id — `document:*` and friends have
  // no trackable id, so adding them would put entries in a set whose name promises
  // otherwise and send every one of them through an untrack call that early-returns.
  // EXTERNAL subscribers only. An in-process listener receiving the event says
  // nothing about whether it left this machine, and `alreadyPushed` exists to hint
  // that a model may already have seen it.
  if (externalSubscribers.size > 0 && trackPayloadId(event)) trackedEvents.add(event);

  while (buffer.length > CHANNEL_EVENT_BUFFER_SIZE) {
    const evicted = buffer.shift();
    if (evicted && trackedEvents.delete(evicted)) untrackPayloadId(evicted);
  }

  const now = Date.now();
  while (buffer.length > 0 && now - buffer[0].timestamp > CHANNEL_EVENT_BUFFER_AGE_MS) {
    const evicted = buffer.shift();
    if (evicted && trackedEvents.delete(evicted)) untrackPayloadId(evicted);
  }

  for (const cb of subscribers) {
    try {
      cb(event);
    } catch (err) {
      console.error("[EventQueue] Subscriber threw during event dispatch:", err);
    }
  }
}

// --- Public API ---

/**
 * How many EXTERNAL consumers are attached to the event fan-out. Diagnostics only.
 *
 * `0` is a sound negative — nothing outside this process is listening, so push
 * cannot possibly be reaching a model. Any positive value is NOT the converse: an
 * attached channel shim whose host never negotiated the channel accepts every
 * event and discards it, and the server cannot tell that apart from a live one.
 * Never drive a "push is working" indicator on this.
 *
 * In-process subscribers are deliberately excluded — see `externalSubscribers`.
 */
export function getSubscriberCount(): number {
  return externalSubscribers.size;
}

/**
 * @param kind `"external"` for a real consumer outside this process (SSE);
 *   `"internal"` for an in-process listener that must not count as push reach.
 *   Defaults to `"internal"` so a new caller that forgets is under-counted rather
 *   than over-counted — the failure direction that produces a false negative in
 *   diagnostics instead of a false claim of delivery.
 */
export function subscribe(cb: EventCallback, kind: SubscriberKind = "internal"): void {
  subscribers.add(cb);
  if (kind === "external") externalSubscribers.add(cb);
}

export function unsubscribe(cb: EventCallback): void {
  subscribers.delete(cb);
  externalSubscribers.delete(cb);
}

/** Replay buffered events since a given event ID (for SSE reconnection). */
export function replaySince(lastEventId: string): TandemEvent[] {
  const idx = buffer.findIndex((e) => e.id === lastEventId);
  if (idx === -1) return [...buffer]; // ID not found — replay everything
  return buffer.slice(idx + 1);
}

/**
 * O(1) check that an id was handed to at least one subscribed consumer and is
 * still in the channel buffer. NOT a delivery signal and NOT a dedup gate: an
 * attached consumer may be inert (a channel shim whose host never negotiated the
 * channel accepts and discards), and the id is untracked on buffer eviction, so
 * absence is not evidence the item was never pushed. `checkInbox` uses it to stamp
 * an advisory `alreadyPushed` hint only — nothing may suppress on it.
 *
 * "Subscribed consumer" is deliberately not "SSE consumer": `subscribe` is also
 * how the in-process local-model collaborator attaches (local-model/collaborator.ts,
 * dark behind BYO_MODELS_ENABLED). If that flag is ever flipped, an enabled
 * collaborator holds a permanent subscription with no external consumer attached,
 * and `pushEvent`'s gate above would stamp every comment — so the gate needs to
 * count external subscribers only, not `subscribers.size`.
 */
export function wasEmittedViaChannel(payloadId: string): boolean {
  return emittedPayloadIds.has(payloadId);
}

/** Content of the WS-A2 Solo→Tandem release wake — a nudge to pull the inbox. */
const MODE_RELEASE_WAKE_CONTENT =
  "Solo mode ended. Call tandem_checkInbox to see the comments and replies the user made while in Solo.";

/**
 * WS-A2: emit ONE synthetic wake so a version-pinned push monitor pulls the
 * inbox after a Solo→Tandem release. Modeled as `annotation:created` (a
 * VALID_EVENT_TYPES member so pinned monitors parse it) with a `wake_…`
 * annotationId in a DISJOINT namespace from real annotation ids — so
 * `trackPayloadId` records only the synthetic id and can't collide with a real
 * held item (which would mis-stamp its `alreadyPushed` hint on the first
 * post-release poll). The caller MUST have already set
 * mode to Tandem (the release route does this first); otherwise the pushEvent
 * Solo-hold would drop this `annotation:created`.
 */
export function emitModeReleaseWake(): void {
  pushEvent({
    id: generateEventId(),
    type: "annotation:created",
    timestamp: Date.now(),
    payload: {
      annotationId: `wake_${generateEventId()}`,
      annotationType: "comment",
      content: MODE_RELEASE_WAKE_CONTENT,
      textSnippet: "",
    },
  });
}

/** Read the buffered selection for a document. For tests and checkInbox. */
export function getBufferedSelection(docName: string): BufferedSelection | undefined {
  return selectionBuffer.get(docName);
}

// --- Y.Map observer attachment ---

/**
 * Attach observers to a document's Y.Maps. Call after doc swap in onLoadDocument.
 * Upload/scratchpad documents (opts.uploadDoc) get only the awareness observer
 * (selection buffering) — annotation and reply events are suppressed so
 * ephemeral scratch notes don't flood Claude's channel.
 */
export function attachObservers(docName: string, doc: Y.Doc, opts?: { uploadDoc?: boolean }): void {
  detachObservers(docName);

  const cleanups: Array<() => void> = [];

  if (!opts?.uploadDoc) {
    cleanups.push(
      makeAnnotationsObserver({ docName, doc, pushEvent }),
      makeRepliesObserver({ docName, doc, pushEvent }),
    );
  }

  // Selections are buffered per-document and attached to the next chat:message,
  // rather than firing as standalone events (#188).
  cleanups.push(makeAwarenessObserver({ docName, doc, selectionBuffer }));

  // Track body-content edits so autosave only writes dirty docs (#851). This
  // observes the ProseMirror XmlFragment directly, so it survives the
  // Hocuspocus Y.Doc swap (this function is re-run via reattachObservers).
  registerDirtyObserver(docName, doc);

  docObservers.set(docName, cleanups);
  console.error(`[EventQueue] Attached observers for document: ${docName}`);
}

/** Detach all observers for a document. Safe to call even if none are attached. */
export function detachObservers(docName: string): void {
  const cleanups = docObservers.get(docName);
  if (cleanups) {
    for (const cleanup of cleanups) cleanup();
    docObservers.delete(docName);
    console.error(`[EventQueue] Detached observers for document: ${docName}`);
  }
}

/** Reattach observers after Hocuspocus replaces a Y.Doc instance. */
export function reattachObservers(
  docName: string,
  newDoc: Y.Doc,
  opts?: { uploadDoc?: boolean },
): void {
  attachObservers(docName, newDoc, opts);
  reattachFileSyncObserver(docName, newDoc);
}

// --- CTRL_ROOM observers (chat + document meta) ---

let ctrlCleanups: Array<() => void> = [];

/** Attach observers to the CTRL_ROOM Y.Doc for chat messages and document meta changes. */
export function attachCtrlObservers(): void {
  for (const cleanup of ctrlCleanups) cleanup();

  const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
  ctrlCleanups = [
    makeCtrlChatObserver({ ctrlDoc, pushEvent, selectionBuffer }),
    makeCtrlMetaObserver({ ctrlDoc, pushEvent }),
  ];

  console.error("[EventQueue] Attached CTRL_ROOM observers (chat + documentMeta)");
}

/** Reattach CTRL_ROOM observers after doc replacement. */
export function reattachCtrlObservers(): void {
  attachCtrlObservers();
}

/** Reset all module state. For tests only — do not call in production. */
export function resetForTesting(): void {
  buffer.length = 0;
  subscribers.clear();
  externalSubscribers.clear();
  emittedPayloadIds.clear();
  // Reset as a pair with emittedPayloadIds — see the WeakSet's docblock.
  trackedEvents = new WeakSet<TandemEvent>();
  selectionBuffer.clear();

  for (const cleanups of docObservers.values()) {
    for (const cleanup of cleanups) cleanup();
  }
  docObservers.clear();

  for (const cleanup of ctrlCleanups) cleanup();
  ctrlCleanups = [];

  // Delegate to registry — its cleanup loop is the only way to dispose
  // in-flight tombstone debounces across tests.
  fileSyncResetForTesting();

  dirtyResetForTesting();
}
