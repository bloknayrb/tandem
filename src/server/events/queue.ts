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
import { FILE_SYNC_ORIGIN, MCP_ORIGIN } from "./origins.js";
import type { BufferedSelection, TandemEvent } from "./types.js";

export { clearFileSyncContext, FILE_SYNC_ORIGIN, MCP_ORIGIN, setFileSyncContext };

type EventCallback = (event: TandemEvent) => void;

const docObservers = new Map<string, Array<() => void>>();

/** Per-document selection buffer. Selections are stored here instead of being pushed as events. They get attached to the next chat:message for the same document. */
const selectionBuffer = new Map<string, BufferedSelection>();

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

/** O(1) check if an annotation/message was already pushed via channel. Used for checkInbox dedup. */
export function wasEmittedViaChannel(payloadId: string): boolean {
  return emittedPayloadIds.has(payloadId);
}

/** Read the buffered selection for a document. For tests and checkInbox. */
export function getBufferedSelection(docName: string): BufferedSelection | undefined {
  return selectionBuffer.get(docName);
}

// --- Y.Map observer attachment ---

/** Attach observers to a document's Y.Maps. Call after doc swap in onLoadDocument. */
export function attachObservers(docName: string, doc: Y.Doc): void {
  detachObservers(docName);

  // Selections are buffered per-document and attached to the next chat:message,
  // rather than firing as standalone events (#188).
  const cleanups: Array<() => void> = [
    makeAnnotationsObserver({ docName, doc, pushEvent }),
    makeRepliesObserver({ docName, doc, pushEvent }),
    makeAwarenessObserver({ docName, doc, selectionBuffer }),
  ];

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
  emittedPayloadIds.clear();
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
}
