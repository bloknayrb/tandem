/**
 * Event queue that observes Y.Map changes and emits TandemEvents.
 *
 * Observers filter by transaction origin — only browser-originated changes
 * (origin !== 'mcp') generate events. This prevents Claude from seeing its
 * own actions echoed back via the channel.
 */

import * as Y from "yjs";
import {
  CHANNEL_EVENT_BUFFER_AGE_MS,
  CHANNEL_EVENT_BUFFER_SIZE,
  CTRL_ROOM,
  SELECTION_DWELL_DEFAULT_MS,
  SELECTION_DWELL_MAX_MS,
  SELECTION_DWELL_MIN_MS,
  Y_MAP_CHAT,
  Y_MAP_DWELL_MS,
  Y_MAP_USER_AWARENESS,
} from "../../shared/constants.js";
import type { ChatMessage, FlatOffset } from "../../shared/types.js";
import { validateRange } from "../positions.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import {
  clearFileSyncContext,
  resetForTesting as fileSyncResetForTesting,
  reattachFileSyncObserver,
  setFileSyncContext,
} from "./file-sync-registry.js";
import { makeAnnotationsObserver } from "./observers/annotations.js";
import { makeCtrlMetaObserver } from "./observers/ctrl-meta.js";
import { makeRepliesObserver } from "./observers/replies.js";
import { FILE_SYNC_ORIGIN, MCP_ORIGIN } from "./origins.js";
import type { TandemEvent } from "./types.js";
import { generateEventId } from "./types.js";

export { clearFileSyncContext, FILE_SYNC_ORIGIN, MCP_ORIGIN, setFileSyncContext };

/**
 * Read the user's configured selection dwell time from CTRL_ROOM.
 *
 * Called at timer-schedule time (not fire time), so mid-dwell slider changes
 * don't affect an in-flight timer — the updated value takes effect on the
 * next selection change.
 *
 * Falls back to `SELECTION_DWELL_DEFAULT_MS` when:
 *   - CTRL_ROOM has no dwell key set (normal on cold startup, before the
 *     client's broadcast effect runs)
 *   - The stored value is the wrong type or outside [MIN, MAX] — the client
 *     clamps on write, so this branch indicates a bug or client/server
 *     constant drift. Logged as a warning so it can be diagnosed.
 */
function getDwellMs(): number {
  const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
  const awareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
  const val = awareness.get(Y_MAP_DWELL_MS);
  if (val === undefined) return SELECTION_DWELL_DEFAULT_MS;
  if (typeof val === "number" && val >= SELECTION_DWELL_MIN_MS && val <= SELECTION_DWELL_MAX_MS) {
    return val;
  }
  console.warn(
    `[EventQueue] Invalid dwell time in CTRL_ROOM awareness (type=${typeof val}, value=${String(val)}); using default ${SELECTION_DWELL_DEFAULT_MS}ms`,
  );
  return SELECTION_DWELL_DEFAULT_MS;
}

type EventCallback = (event: TandemEvent) => void;

const docObservers = new Map<string, Array<() => void>>();

/** Per-document selection buffer. Selections are stored here instead of being pushed as events. They get attached to the next chat:message for the same document. */
const selectionBuffer = new Map<string, { from: number; to: number; selectedText: string }>();

/** O(1) dedup: ref-counted annotation/message IDs that have been pushed via channel. */
const emittedPayloadIds = new Map<string, number>();

const buffer: TandemEvent[] = [];
const subscribers = new Set<EventCallback>();

function getTrackableId(event: TandemEvent): string | undefined {
  switch (event.type) {
    case "annotation:created":
    case "annotation:accepted":
    case "annotation:dismissed":
      return event.payload.annotationId;
    case "annotation:reply":
      return event.payload.replyId;
    case "chat:message":
      return event.payload.messageId;
    default:
      return undefined;
  }
}

function trackPayloadId(event: TandemEvent): void {
  const id = getTrackableId(event);
  if (id) emittedPayloadIds.set(id, (emittedPayloadIds.get(id) ?? 0) + 1);
}

function untrackPayloadId(event: TandemEvent): void {
  const id = getTrackableId(event);
  if (!id) return;
  const count = emittedPayloadIds.get(id) ?? 0;
  if (count <= 1) emittedPayloadIds.delete(id);
  else emittedPayloadIds.set(id, count - 1);
}

function pushEvent(event: TandemEvent): void {
  buffer.push(event);
  trackPayloadId(event);

  while (buffer.length > CHANNEL_EVENT_BUFFER_SIZE) {
    const evicted = buffer.shift();
    if (evicted) untrackPayloadId(evicted);
  }

  const now = Date.now();
  while (buffer.length > 0 && now - buffer[0].timestamp > CHANNEL_EVENT_BUFFER_AGE_MS) {
    const evicted = buffer.shift();
    if (evicted) untrackPayloadId(evicted);
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

export function subscribe(cb: EventCallback): void {
  subscribers.add(cb);
}

export function unsubscribe(cb: EventCallback): void {
  subscribers.delete(cb);
}

/** Replay buffered events since a given event ID (for SSE reconnection). */
export function replaySince(lastEventId: string): TandemEvent[] {
  const idx = buffer.findIndex((e) => e.id === lastEventId);
  if (idx === -1) return [...buffer]; // ID not found — replay everything
  return buffer.slice(idx + 1);
}

/** O(1) check if an annotation/message was already pushed via channel. Intended for checkInbox dedup (not yet wired). */
export function wasEmittedViaChannel(payloadId: string): boolean {
  return emittedPayloadIds.has(payloadId);
}

/** Read the buffered selection for a document. For tests and checkInbox. */
export function getBufferedSelection(
  docName: string,
): { from: number; to: number; selectedText: string } | undefined {
  return selectionBuffer.get(docName);
}

// --- Y.Map observer attachment ---

/** Attach observers to a document's Y.Maps. Call after doc swap in onLoadDocument. */
export function attachObservers(docName: string, doc: Y.Doc): void {
  // Detach existing observers first (idempotent)
  detachObservers(docName);

  const cleanups: Array<() => void> = [];

  // 1. Annotations observer
  cleanups.push(makeAnnotationsObserver({ docName, doc, pushEvent }));

  // 2. Annotation replies observer
  cleanups.push(makeRepliesObserver({ docName, doc, pushEvent }));

  // 3. User awareness observer (selection buffering)
  // Selections are buffered per-document and attached to the next chat:message,
  // rather than firing as standalone events (#188).
  const userAwareness = doc.getMap(Y_MAP_USER_AWARENESS);
  let selectionDwellTimer: ReturnType<typeof setTimeout> | null = null;

  const awarenessObs = (event: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
    if (txn.origin === MCP_ORIGIN) return;

    if (event.keysChanged.has("selection")) {
      const selection = userAwareness.get("selection") as
        | { from: FlatOffset; to: FlatOffset; selectedText?: string }
        | undefined;

      // Cancel any pending dwell timer
      if (selectionDwellTimer) {
        clearTimeout(selectionDwellTimer);
        selectionDwellTimer = null;
      }

      // Skip cleared selections — also clear the buffer
      if (!selection || selection.from === selection.to) {
        selectionBuffer.delete(docName);
        return;
      }

      // Buffer after dwell to filter transient drag selections
      selectionDwellTimer = setTimeout(() => {
        selectionDwellTimer = null;
        selectionBuffer.set(docName, {
          from: selection.from,
          to: selection.to,
          selectedText: selection.selectedText ?? "",
        });
      }, getDwellMs());
    }
  };
  userAwareness.observe(awarenessObs);
  cleanups.push(() => {
    userAwareness.unobserve(awarenessObs);
    if (selectionDwellTimer) clearTimeout(selectionDwellTimer);
    selectionBuffer.delete(docName);
  });

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
export function reattachObservers(docName: string, newDoc: Y.Doc): void {
  attachObservers(docName, newDoc);

  // Annotation file-writer observer: if this doc has an active file-sync
  // context (registered by the file-opener after loadAndMerge), re-register
  // it against the NEW Y.Doc so disk persistence keeps flowing after the
  // Hocuspocus doc swap. The previous observer was attached to the old
  // Y.Doc and is no longer reachable (Hocuspocus destroyed the old doc
  // in onLoadDocument); the cleanup we stashed would be a no-op anyway.
  reattachFileSyncObserver(docName, newDoc);
}

// --- CTRL_ROOM observers (chat + document meta) ---

let ctrlCleanups: Array<() => void> = [];

/** Attach observers to the CTRL_ROOM Y.Doc for chat messages and document meta changes. */
export function attachCtrlObservers(): void {
  // Detach existing first
  for (const cleanup of ctrlCleanups) cleanup();
  ctrlCleanups = [];

  const ctrlDoc = getOrCreateDocument(CTRL_ROOM);

  // Chat message observer
  const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);
  const chatObs = (event: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
    if (txn.origin === MCP_ORIGIN) return;

    for (const [key, change] of event.changes.keys) {
      if (change.action !== "add") continue;
      const msg = chatMap.get(key) as ChatMessage | undefined;
      if (!msg || msg.author !== "user") continue;

      // Attach buffered selection context if available for this document
      let selection:
        | { from: number; to: number; selectedText: string }
        | { selectedText: string }
        | undefined;
      if (msg.documentId) {
        const buffered = selectionBuffer.get(msg.documentId);
        if (buffered) {
          selectionBuffer.delete(msg.documentId);
          // Validate range is still valid before attaching offsets
          try {
            const doc = getOrCreateDocument(msg.documentId);
            const validation = validateRange(
              doc,
              buffered.from as FlatOffset,
              buffered.to as FlatOffset,
            );
            if (validation.ok) {
              selection = buffered;
            } else {
              // Range went stale — attach text only (no offsets)
              selection = { selectedText: buffered.selectedText };
            }
          } catch (err) {
            console.warn(
              `[EventQueue] Failed to validate buffered selection for doc=${msg.documentId}:`,
              err,
            );
            selection = { selectedText: buffered.selectedText };
          }
        }
      }

      pushEvent({
        id: generateEventId(),
        type: "chat:message",
        timestamp: Date.now(),
        documentId: msg.documentId,
        payload: {
          messageId: msg.id,
          text: msg.text,
          replyTo: msg.replyTo ?? null,
          anchor: msg.anchor ?? null,
          ...(selection ? { selection } : {}),
        },
      });
    }
  };
  chatMap.observe(chatObs);
  ctrlCleanups.push(() => chatMap.unobserve(chatObs));

  // Document meta observer (open/close/switch)
  ctrlCleanups.push(makeCtrlMetaObserver({ ctrlDoc, pushEvent }));

  console.error("[EventQueue] Attached CTRL_ROOM observers (chat + documentMeta)");
}

/** Reattach CTRL_ROOM observers after doc replacement. */
export function reattachCtrlObservers(): void {
  attachCtrlObservers();
}

/** Reset all module state. For tests only — do not call in production. */
export function resetForTesting(): void {
  // 1. Clear data-only collections (observer cleanups don't touch these)
  buffer.length = 0;
  subscribers.clear();
  emittedPayloadIds.clear();
  selectionBuffer.clear();

  // 2. Run per-doc observer cleanups, then clear the map that holds them
  for (const cleanups of docObservers.values()) {
    for (const cleanup of cleanups) cleanup();
  }
  docObservers.clear();

  // 3. Run CTRL cleanups, then reset the array that holds them
  for (const cleanup of ctrlCleanups) cleanup();
  ctrlCleanups = [];

  // 4. Delegate registry reset (CRITICAL — do not forget)
  fileSyncResetForTesting();
}
