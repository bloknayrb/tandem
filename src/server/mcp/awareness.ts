import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CTRL_ROOM,
  TANDEM_MODE_DEFAULT,
  Y_MAP_ACTIVITY,
  Y_MAP_ANNOTATIONS,
  Y_MAP_CHAT,
  Y_MAP_MODE,
  Y_MAP_SELECTION,
  Y_MAP_USER_AWARENESS,
} from "../../shared/constants.js";
import type { Annotation, ChatMessage, FlatOffset } from "../../shared/types.js";
import { TandemModeSchema } from "../../shared/types.js";
import { generateMessageId } from "../../shared/utils.js";
import { docHash } from "../annotations/doc-hash.js";
import { isStoreReadOnly } from "../annotations/store.js";
import {
  getAnnotationEditedChannelKey,
  MCP_ORIGIN,
  wasEmittedViaChannel,
} from "../events/queue.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import { collectAnnotations, refreshRange } from "./annotations.js";
import { extractText, getCurrentDoc } from "./document.js";
import { mcpSuccess, noDocumentError, withErrorBoundary } from "./response.js";

// Track which annotation IDs have been surfaced to Claude via checkInbox.
// Value = lastSurfacedEditedAt (0 for unedited annotations).
// Allows re-surfacing when an annotation has been edited since last surfaced.
const surfacedIds = new Map<string, number>();

/** Reset surfaced IDs (exported for testing) */
export function resetInbox(): void {
  surfacedIds.clear();
}

export function registerAwarenessTools(server: McpServer): void {
  server.tool(
    "tandem_getActivity",
    "Check if the user is actively editing and where their cursor is",
    {
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    withErrorBoundary("tandem_getActivity", async ({ documentId }) => {
      const current = getCurrentDoc(documentId);
      if (!current) return noDocumentError();

      const doc = getOrCreateDocument(current.docName);
      const userAwareness = doc.getMap(Y_MAP_USER_AWARENESS);
      const activity = userAwareness.get(Y_MAP_ACTIVITY) as
        | {
            isTyping: boolean;
            cursor: number;
            lastEdit: number;
          }
        | undefined;

      if (!activity) {
        return mcpSuccess({
          active: false,
          cursor: null,
          lastEdit: null,
          message: "No activity detected",
        });
      }

      // Consider user active if last edit was within 10 seconds
      const isActive = activity.isTyping || Date.now() - activity.lastEdit < 10000;

      return mcpSuccess({
        active: isActive,
        isTyping: activity.isTyping,
        cursor: activity.cursor,
        lastEdit: activity.lastEdit,
      });
    }),
  );

  server.tool(
    "tandem_checkInbox",
    "Check for user actions you haven't seen yet — new comments, notes, and responses to your annotations. Call this after completing any task, between steps, and whenever you pause. Low token cost.",
    {
      documentId: z
        .string()
        .optional()
        .describe("Target document ID (defaults to active document)"),
    },
    withErrorBoundary("tandem_checkInbox", async ({ documentId }) => {
      const current = getCurrentDoc(documentId);
      if (!current) return noDocumentError();

      const doc = getOrCreateDocument(current.docName);
      const annotationsMap = doc.getMap(Y_MAP_ANNOTATIONS);
      const allAnnotations = collectAnnotations(annotationsMap, docHash(current.filePath));
      const fullText = extractText(doc);

      // Refresh only unsurfaced annotations; batch Y.Map writes.
      // refreshRange returns a tagged RefreshResult (ADR-032); we extract
      // `.annotation` here because the inbox surfacer doesn't currently
      // distinguish refresh outcomes. A future enhancement could route
      // `degraded` / `failed` annotations into a separate notification.
      const unsurfaced: Annotation[] = [];
      doc.transact(() => {
        for (const raw of allAnnotations) {
          const lastSurfacedEditedAt = surfacedIds.get(raw.id);
          // Not yet surfaced
          if (lastSurfacedEditedAt === undefined) {
            unsurfaced.push(refreshRange(raw, doc, annotationsMap).annotation);
            continue;
          }
          // Already surfaced — check if it's been edited since
          if ((raw.editedAt ?? 0) > lastSurfacedEditedAt) {
            unsurfaced.push(refreshRange(raw, doc, annotationsMap).annotation);
          }
        }
      }, MCP_ORIGIN);

      const { userActions, userResponses } = processUnsurfacedInboxAnnotations(
        unsurfaced,
        fullText,
        surfacedIds,
        wasEmittedViaChannel,
      );

      // Bucket 3: unread chat messages from CTRL_ROOM
      const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
      const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);
      const chatMessages: Array<Omit<ChatMessage, "read" | "author">> = [];

      chatMap.forEach((value) => {
        const msg = value as ChatMessage;
        if (msg.author === "user" && !msg.read) {
          chatMessages.push({
            id: msg.id,
            text: msg.text,
            timestamp: msg.timestamp,
            ...(msg.documentId ? { documentId: msg.documentId } : {}),
            ...(msg.anchor ? { anchor: msg.anchor } : {}),
            ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
          });
          // Mark as read
          ctrlDoc.transact(() => chatMap.set(msg.id, { ...msg, read: true }), MCP_ORIGIN);
        }
      });

      // Current user activity
      const userAwareness = doc.getMap(Y_MAP_USER_AWARENESS);
      const selection = userAwareness.get(Y_MAP_SELECTION) as
        | { from: FlatOffset; to: FlatOffset; timestamp: number }
        | undefined;
      const activity = userAwareness.get(Y_MAP_ACTIVITY) as
        | {
            isTyping: boolean;
            cursor: number;
            lastEdit: number;
          }
        | undefined;

      const ctrlAwareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
      const mode = TandemModeSchema.catch(TANDEM_MODE_DEFAULT).parse(ctrlAwareness.get(Y_MAP_MODE));

      const hasSelection = selection && selection.from !== selection.to;
      const selectedText = hasSelection
        ? safeSlice(fullText, selection!.from, selection!.to)
        : null;

      // Build summary
      const parts: string[] = [];
      if (userActions.length > 0) {
        const typeCounts: Record<string, number> = {};
        for (const a of userActions) {
          typeCounts[a.type] = (typeCounts[a.type] || 0) + 1;
        }
        const typeList = Object.entries(typeCounts)
          .map(([t, n]) => `${n} ${t}${n > 1 ? "s" : ""}`)
          .join(", ");
        parts.push(`${userActions.length} new: ${typeList}`);
      }
      if (userResponses.length > 0) {
        const statusCounts: Record<string, number> = {};
        for (const r of userResponses) {
          statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
        }
        const statusList = Object.entries(statusCounts)
          .map(([s, n]) => `${n} ${s}`)
          .join(", ");
        parts.push(statusList);
      }
      if (chatMessages.length > 0) {
        parts.push(`${chatMessages.length} new chat message${chatMessages.length > 1 ? "s" : ""}`);
      }
      const summary = parts.length > 0 ? parts.join(". ") + "." : "No new actions.";

      const hasNew = userActions.length > 0 || userResponses.length > 0 || chatMessages.length > 0;

      return mcpSuccess({
        summary,
        hasNew,
        mode,
        storeReadOnly: isStoreReadOnly(),
        userActions,
        userResponses,
        chatMessages,
        activity: {
          isTyping: activity?.isTyping ?? false,
          cursor: activity?.cursor ?? null,
          lastEdit: activity?.lastEdit ?? null,
          selectedText,
        },
      });
    }),
  );
  server.tool(
    "tandem_reply",
    "Send a chat message to the user in the Tandem sidebar. Use this to respond to chat messages from tandem_checkInbox.",
    {
      text: z.string().describe("Your message to the user"),
      replyTo: z.string().optional().describe("ID of the user message you are replying to"),
      documentId: z
        .string()
        .optional()
        .describe("Document context for this reply (defaults to active document)"),
    },
    withErrorBoundary("tandem_reply", async ({ text, replyTo, documentId }) => {
      const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
      const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);

      const id = generateMessageId();
      const current = getCurrentDoc(documentId);
      const docId = documentId ?? current?.id ?? undefined;

      const msg: ChatMessage = {
        id,
        author: "claude",
        text,
        timestamp: Date.now(),
        ...(docId ? { documentId: docId } : {}),
        ...(replyTo ? { replyTo } : {}),
        read: true,
      };

      ctrlDoc.transact(() => chatMap.set(id, msg), MCP_ORIGIN);

      return mcpSuccess({ sent: true, messageId: id });
    }),
  );
}

/** Safely slice text and truncate to 100 chars. Exported for testing. */
export function safeSlice(text: string, from: number, to: number): string {
  const start = Math.max(0, Math.min(from, text.length));
  const end = Math.max(start, Math.min(to, text.length));
  const snippet = text.slice(start, end);
  return snippet.length > 100 ? snippet.slice(0, 97) + "..." : snippet;
}

/** Determine if user is active based on activity data. Exported for testing. */
export function isUserActive(
  activity: { isTyping: boolean; lastEdit: number } | undefined,
): boolean {
  if (!activity) return false;
  return activity.isTyping || Date.now() - activity.lastEdit < 10000;
}

/**
 * Process annotations into inbox buckets. Exported for testing.
 * Mutates surfacedIds to track which annotations have been surfaced.
 */
export function processInboxAnnotations(
  allAnnotations: Annotation[],
  fullText: string,
  surfaced: Map<string, number>,
  refreshFn: (ann: Annotation) => Annotation,
  wasChannelEmitted: (payloadId: string) => boolean = () => false,
): {
  userActions: Array<Annotation & { textSnippet: string; edited?: boolean }>;
  userResponses: Array<Annotation & { textSnippet: string }>;
} {
  const unsurfaced: Annotation[] = [];
  for (const raw of allAnnotations) {
    const lastSurfacedEditedAt = surfaced.get(raw.id);
    if (lastSurfacedEditedAt === undefined) {
      unsurfaced.push(refreshFn(raw));
    } else if ((raw.editedAt ?? 0) > lastSurfacedEditedAt) {
      unsurfaced.push(refreshFn(raw));
    }
  }

  return processUnsurfacedInboxAnnotations(unsurfaced, fullText, surfaced, wasChannelEmitted);
}

function processUnsurfacedInboxAnnotations(
  unsurfaced: Annotation[],
  fullText: string,
  surfaced: Map<string, number>,
  wasChannelEmitted: (payloadId: string) => boolean,
): {
  userActions: Array<Annotation & { textSnippet: string; edited?: boolean }>;
  userResponses: Array<Annotation & { textSnippet: string }>;
} {
  const userActions: Array<Annotation & { textSnippet: string; edited?: boolean }> = [];
  const userResponses: Array<Annotation & { textSnippet: string }> = [];

  for (const ann of unsurfaced) {
    const snippet = safeSlice(fullText, ann.range.from, ann.range.to);
    if (ann.author === "user" && ann.type === "comment") {
      const lastSurfacedEditedAt = surfaced.get(ann.id);
      const alreadySurfaced = lastSurfacedEditedAt !== undefined;
      const edited = alreadySurfaced && (ann.editedAt ?? 0) > lastSurfacedEditedAt;
      const channelKey = edited ? getAnnotationEditedChannelKey(ann.id, ann.editedAt ?? 0) : ann.id;

      if (wasChannelEmitted(channelKey)) {
        surfaced.set(ann.id, ann.editedAt ?? 0);
        continue;
      }

      userActions.push({ ...ann, textSnippet: snippet, ...(edited ? { edited: true } : {}) });
      surfaced.set(ann.id, ann.editedAt ?? 0);
    } else if (ann.author === "claude" && ann.status !== "pending") {
      userResponses.push({ ...ann, textSnippet: snippet });
      surfaced.set(ann.id, ann.editedAt ?? 0);
    }
  }

  return { userActions, userResponses };
}
