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
  Y_MAP_ANNOTATIONS,
  Y_MAP_CHAT,
  Y_MAP_DOCUMENT_META,
  Y_MAP_DWELL_MS,
  Y_MAP_USER_AWARENESS,
} from "../../shared/constants.js";
import type { Annotation, ChatMessage, FlatOffset } from "../../shared/types.js";
import { sanitizeAnnotation } from "../mcp/annotations.js";
import { getOpenDocs } from "../mcp/document-service.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import type { TandemEvent } from "./types.js";
import { generateEventId } from "./types.js";

/** Origin tag for all MCP-initiated Y.Map writes. Import and use this — never use raw "mcp" strings. */
export const MCP_ORIGIN = "mcp";

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

// --- Y.Map observer attachment ---

/** Attach observers to a document's Y.Maps. Call after doc swap in onLoadDocument. */
export function attachObservers(docName: string, doc: Y.Doc): void {
  // Detach existing observers first (idempotent)
  detachObservers(docName);

  const cleanups: Array<() => void> = [];

  // 1. Annotations observer
  const annotationsMap = doc.getMap(Y_MAP_ANNOTATIONS);
  const annotationsObs = (event: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
    if (txn.origin === MCP_ORIGIN) return;

    for (const [key, change] of event.changes.keys) {
      const raw = annotationsMap.get(key) as Annotation | undefined;
      if (!raw) continue;
      const ann = sanitizeAnnotation(raw);

      if (change.action === "add" && ann.author === "user") {
        pushEvent({
          id: generateEventId(),
          type: "annotation:created",
          timestamp: Date.now(),
          documentId: docName,
          payload: {
            annotationId: ann.id,
            annotationType: ann.type,
            content: ann.content,
            textSnippet: ann.textSnapshot ?? "",
            ...(ann.suggestedText !== undefined ? { hasSuggestedText: true } : {}),
            ...(ann.directedAt ? { directedAt: ann.directedAt } : {}),
          },
        });
      } else if (change.action === "update" && ann.author === "claude") {
        if (ann.status === "accepted") {
          pushEvent({
            id: generateEventId(),
            type: "annotation:accepted",
            timestamp: Date.now(),
            documentId: docName,
            payload: {
              annotationId: ann.id,
              textSnippet: ann.textSnapshot ?? "",
            },
          });
        } else if (ann.status === "dismissed") {
          pushEvent({
            id: generateEventId(),
            type: "annotation:dismissed",
            timestamp: Date.now(),
            documentId: docName,
            payload: {
              annotationId: ann.id,
              textSnippet: ann.textSnapshot ?? "",
            },
          });
        }
      }
    }
  };
  annotationsMap.observe(annotationsObs);
  cleanups.push(() => annotationsMap.unobserve(annotationsObs));

  // 2. User awareness observer (selection changes)
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

      // Skip cleared selections
      if (!selection || selection.from === selection.to) return;

      // Start dwell timer — only emit after user holds selection steady
      selectionDwellTimer = setTimeout(() => {
        selectionDwellTimer = null;
        pushEvent({
          id: generateEventId(),
          type: "selection:changed",
          timestamp: Date.now(),
          documentId: docName,
          payload: {
            from: selection.from,
            to: selection.to,
            selectedText: selection.selectedText ?? "",
          },
        });
      }, getDwellMs());
    }
  };
  userAwareness.observe(awarenessObs);
  cleanups.push(() => {
    userAwareness.unobserve(awarenessObs);
    if (selectionDwellTimer) clearTimeout(selectionDwellTimer);
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
        },
      });
    }
  };
  chatMap.observe(chatObs);
  ctrlCleanups.push(() => chatMap.unobserve(chatObs));

  // Document meta observer (open/close/switch)
  const metaMap = ctrlDoc.getMap(Y_MAP_DOCUMENT_META);
  let lastActiveDocId: string | null = null;
  let lastOpenDocIds = new Set<string>();

  const metaObs = (event: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
    if (txn.origin === MCP_ORIGIN) return;

    // Check for activeDocumentId change (tab switch)
    if (event.keysChanged.has("activeDocumentId")) {
      const activeId = metaMap.get("activeDocumentId") as string | undefined;
      if (activeId && activeId !== lastActiveDocId) {
        const openDoc = getOpenDocs().get(activeId);
        pushEvent({
          id: generateEventId(),
          type: "document:switched",
          timestamp: Date.now(),
          documentId: activeId,
          payload: {
            fileName: openDoc?.filePath?.split(/[/\\]/).pop() ?? activeId,
          },
        });
        lastActiveDocId = activeId;
      }
    }

    // Check for openDocuments change (doc open/close)
    if (event.keysChanged.has("openDocuments")) {
      const docList =
        (metaMap.get("openDocuments") as Array<{ id: string; fileName?: string }>) ?? [];
      const currentIds = new Set(docList.map((d) => d.id));

      // Newly opened
      for (const doc of docList) {
        if (!lastOpenDocIds.has(doc.id)) {
          const openDoc = getOpenDocs().get(doc.id);
          pushEvent({
            id: generateEventId(),
            type: "document:opened",
            timestamp: Date.now(),
            documentId: doc.id,
            payload: {
              fileName: doc.fileName ?? openDoc?.filePath?.split(/[/\\]/).pop() ?? doc.id,
              format: openDoc?.format ?? "unknown",
            },
          });
        }
      }

      // Closed
      for (const oldId of lastOpenDocIds) {
        if (!currentIds.has(oldId)) {
          pushEvent({
            id: generateEventId(),
            type: "document:closed",
            timestamp: Date.now(),
            documentId: oldId,
            payload: {
              fileName: oldId,
            },
          });
        }
      }

      lastOpenDocIds = currentIds;
    }
  };
  metaMap.observe(metaObs);
  ctrlCleanups.push(() => metaMap.unobserve(metaObs));

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
  for (const cleanups of docObservers.values()) {
    for (const cleanup of cleanups) cleanup();
  }
  docObservers.clear();
  for (const cleanup of ctrlCleanups) cleanup();
  ctrlCleanups = [];
}
