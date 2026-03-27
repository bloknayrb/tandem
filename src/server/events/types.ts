/**
 * Event types for the Tandem → Claude Code channel.
 *
 * These events flow from browser-originated Y.Map changes through an SSE
 * endpoint to the channel shim, which pushes them into Claude Code as
 * `notifications/claude/channel` messages.
 */

export type TandemEventType =
  | "annotation:created"
  | "annotation:accepted"
  | "annotation:dismissed"
  | "chat:message"
  | "selection:changed"
  | "document:opened"
  | "document:closed"
  | "document:switched";

export interface TandemEvent {
  /** Monotonic ID for SSE `Last-Event-ID` reconnection. Format: `evt_<timestamp>_<rand>` */
  id: string;
  type: TandemEventType;
  timestamp: number;
  /** Which document this event relates to (absent for global events). */
  documentId?: string;
  /** Type-specific payload — kept as a flat record for SSE serialization. */
  payload: Record<string, unknown>;
}

// Re-export from shared utils (single ID generation pattern)
export { generateEventId } from "../../shared/utils.js";

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
      return `User selected text (${from}-${to}): "${selectedText}"${doc}`;
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
  if (event.payload.annotationId) meta.annotation_id = String(event.payload.annotationId);
  if (event.payload.messageId) meta.message_id = String(event.payload.messageId);
  return meta;
}
