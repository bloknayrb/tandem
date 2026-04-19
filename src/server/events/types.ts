/**
 * Event types for the Tandem → Claude Code channel.
 *
 * These events flow from browser-originated Y.Map changes through an SSE
 * endpoint to the channel shim, which pushes them into Claude Code as
 * `notifications/claude/channel` messages.
 */

import type { ReplyAuthor } from "../../shared/types.js";

// --- Per-event payload interfaces ---

export interface AnnotationCreatedPayload {
  annotationId: string;
  annotationType: string;
  content: string;
  textSnippet: string;
  hasSuggestedText?: boolean;
  directedAt?: "claude";
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
  /** Buffered selection context at the time the chat message was sent. */
  selection?: { from: number; to: number; selectedText: string } | { selectedText: string };
}

export interface DocumentOpenedPayload {
  fileName: string;
  format: string;
}

export interface DocumentClosedPayload {
  fileName: string;
}

export interface AnnotationReplyPayload {
  annotationId: string;
  replyId: string;
  replyText: string;
  replyAuthor: ReplyAuthor;
  textSnippet: string;
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
  | (TandemEventBase & { type: "annotation:reply"; payload: AnnotationReplyPayload })
  | (TandemEventBase & { type: "chat:message"; payload: ChatMessagePayload })
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
  "annotation:reply",
  "chat:message",
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
      const { annotationType, content, textSnippet, hasSuggestedText, directedAt } = event.payload;
      const snippet = textSnippet ? ` on "${textSnippet}"` : "";
      const label = hasSuggestedText
        ? "replacement"
        : directedAt === "claude"
          ? "question for Claude"
          : annotationType;
      return `User created ${label}${snippet}: ${content || "(no content)"}${doc}`;
    }
    case "annotation:accepted": {
      const { annotationId, textSnippet } = event.payload;
      return `User accepted annotation ${annotationId}${textSnippet ? ` ("${textSnippet}")` : ""}${doc}`;
    }
    case "annotation:dismissed": {
      const { annotationId, textSnippet } = event.payload;
      return `User dismissed annotation ${annotationId}${textSnippet ? ` ("${textSnippet}")` : ""}${doc}`;
    }
    case "annotation:reply": {
      const { annotationId, replyAuthor, replyText, textSnippet } = event.payload;
      const who = replyAuthor === "claude" ? "Claude" : "User";
      const snippet = textSnippet ? ` (on "${textSnippet}")` : "";
      return `${who} replied to annotation ${annotationId}${snippet}: ${replyText}${doc}`;
    }
    case "chat:message": {
      const { text, replyTo, selection } = event.payload;
      const reply = replyTo ? ` (replying to ${replyTo})` : "";
      const sel =
        selection && selection.selectedText
          ? ` [selection: "${selection.selectedText}"${"from" in selection ? ` (${selection.from}-${selection.to})` : ""}]`
          : "";
      return `User says${reply}: ${text}${sel}${doc}`;
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
    case "annotation:reply":
      meta.annotation_id = event.payload.annotationId;
      meta.reply_id = event.payload.replyId;
      break;
    case "chat:message":
      meta.message_id = event.payload.messageId;
      if (event.payload.selection?.selectedText) meta.has_selection = "true";
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
