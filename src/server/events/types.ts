/**
 * Event types for the Tandem → Claude Code channel.
 *
 * These events flow from browser-originated Y.Map changes through an SSE
 * endpoint to the channel shim, which pushes them into Claude Code as
 * `notifications/claude/channel` messages.
 */

// --- Per-event payload interfaces ---

export interface AnnotationCreatedPayload {
  annotationId: string;
  annotationType: string;
  content: string;
  textSnippet: string;
}

export interface AnnotationAcceptedPayload {
  annotationId: string;
  textSnippet: string;
}

export interface AnnotationDismissedPayload {
  annotationId: string;
  textSnippet: string;
}

export interface ChatMessagePayload {
  messageId: string;
  text: string;
  replyTo: string | null;
  anchor: { from: number; to: number; textSnapshot: string } | null;
}

export interface SelectionChangedPayload {
  from: number;
  to: number;
  selectedText: string;
}

export interface DocumentOpenedPayload {
  fileName: string;
  format: string;
}

export interface DocumentClosedPayload {
  fileName: string;
}

export interface DocumentSwitchedPayload {
  fileName: string;
}

// --- Discriminated union ---

interface TandemEventBase {
  /** Timestamp-based unique ID for SSE `Last-Event-ID` reconnection. Format: `evt_<timestamp>_<rand>`. Roughly ordered but not strictly monotonic. */
  id: string;
  timestamp: number;
  /** Which document this event relates to (absent for global events). */
  documentId?: string;
}

export type TandemEvent =
  | (TandemEventBase & { type: "annotation:created"; payload: AnnotationCreatedPayload })
  | (TandemEventBase & { type: "annotation:accepted"; payload: AnnotationAcceptedPayload })
  | (TandemEventBase & { type: "annotation:dismissed"; payload: AnnotationDismissedPayload })
  | (TandemEventBase & { type: "chat:message"; payload: ChatMessagePayload })
  | (TandemEventBase & { type: "selection:changed"; payload: SelectionChangedPayload })
  | (TandemEventBase & { type: "document:opened"; payload: DocumentOpenedPayload })
  | (TandemEventBase & { type: "document:closed"; payload: DocumentClosedPayload })
  | (TandemEventBase & { type: "document:switched"; payload: DocumentSwitchedPayload });

/** Union of all event type discriminants. */
export type TandemEventType = TandemEvent["type"];

// Re-export from shared utils (single ID generation pattern)
export { generateEventId } from "../../shared/utils.js";

// --- Parse guard for SSE consumers ---

const VALID_EVENT_TYPES = new Set<TandemEventType>([
  "annotation:created",
  "annotation:accepted",
  "annotation:dismissed",
  "chat:message",
  "selection:changed",
  "document:opened",
  "document:closed",
  "document:switched",
]);

/**
 * Validate a JSON-parsed value as a TandemEvent.
 * Used by the event-bridge to safely consume SSE data.
 */
export function parseTandemEvent(raw: unknown): TandemEvent | null {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("id" in raw) ||
    typeof (raw as Record<string, unknown>).id !== "string" ||
    !("type" in raw) ||
    !VALID_EVENT_TYPES.has((raw as Record<string, unknown>).type as TandemEventType) ||
    !("timestamp" in raw) ||
    typeof (raw as Record<string, unknown>).timestamp !== "number" ||
    !("payload" in raw) ||
    typeof (raw as Record<string, unknown>).payload !== "object"
  ) {
    return null;
  }
  return raw as TandemEvent;
}

/**
 * Convert a TandemEvent into a human-readable string for the channel `content` field.
 * Claude sees this text inside `<channel source="tandem-channel">` tags.
 */
export function formatEventContent(event: TandemEvent): string {
  const doc = event.documentId ? ` [doc: ${event.documentId}]` : "";

  switch (event.type) {
    case "annotation:created": {
      const { annotationType, content, textSnippet } = event.payload;
      const snippet = textSnippet ? ` on "${textSnippet}"` : "";
      return `User created ${annotationType}${snippet}: ${content || "(no content)"}${doc}`;
    }
    case "annotation:accepted": {
      const { annotationId, textSnippet } = event.payload;
      return `User accepted annotation ${annotationId}${textSnippet ? ` ("${textSnippet}")` : ""}${doc}`;
    }
    case "annotation:dismissed": {
      const { annotationId, textSnippet } = event.payload;
      return `User dismissed annotation ${annotationId}${textSnippet ? ` ("${textSnippet}")` : ""}${doc}`;
    }
    case "chat:message": {
      const { text, replyTo } = event.payload;
      const reply = replyTo ? ` (replying to ${replyTo})` : "";
      return `User says${reply}: ${text}${doc}`;
    }
    case "selection:changed": {
      const { from, to, selectedText } = event.payload;
      if (!selectedText) return `User cleared selection${doc}`;
      return `User is pointing at text (${from}-${to}): "${selectedText}"${doc} — respond via tandem_reply`;
    }
    case "document:opened": {
      const { fileName, format } = event.payload;
      return `User opened document: ${fileName} (${format})${doc}`;
    }
    case "document:closed": {
      const { fileName } = event.payload;
      return `User closed document: ${fileName}${doc}`;
    }
    case "document:switched": {
      const { fileName } = event.payload;
      return `User switched to document: ${fileName}${doc}`;
    }
    default: {
      const _exhaustive: never = event;
      return `Unknown event${doc}`;
    }
  }
}

/**
 * Build the `meta` record for a channel notification.
 * Keys use underscores only (Channels API silently drops hyphenated keys).
 */
export function formatEventMeta(event: TandemEvent): Record<string, string> {
  const meta: Record<string, string> = {
    event_type: event.type,
  };
  if (event.documentId) meta.document_id = event.documentId;

  switch (event.type) {
    case "annotation:created":
    case "annotation:accepted":
    case "annotation:dismissed":
      meta.annotation_id = event.payload.annotationId;
      break;
    case "chat:message":
      meta.message_id = event.payload.messageId;
      break;
    case "selection:changed":
      meta.respond_via = "tandem_reply";
      break;
    case "document:opened":
    case "document:closed":
    case "document:switched":
      break;
    default: {
      const _exhaustive: never = event;
      break;
    }
  }

  return meta;
}
