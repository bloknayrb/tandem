import type { ChatMessage } from "../../shared/types";
import type { ChatNotificationContent } from "../hooks/useTandemSettings";
import { NOTIFICATION_KIND_COMMENT } from "../tauri/notifications-invoke";
import type { NotificationKind, NotificationText, NotifierBackend } from "./chat-attention";
import { previewText } from "./chat-attention";
import {
  cleanNotificationText,
  NOTIFICATION_BODY_MAX_CHARS,
  NOTIFICATION_TITLE_MAX_CHARS,
} from "./notification-text";
import type { ThreadAnswer } from "./thread-answer-detector";

/**
 * The comment-answer half of Claude-reply attention (#2360): a second
 * `createChatAttention` instance announces a Claude answer inside the user's
 * own comment thread, with the same away/visibility rules, chime and flash as
 * a chat reply (#2168). This module holds what differs: the item shape, the
 * wording, one shared attention count, and click routing.
 */

/**
 * A thread answer in the shape `createChatAttention` dispatches. `id` is the
 * reply id (the `Y_MAP_REPLY_SEEN` key, so `isSeen` reads it directly);
 * `annotationId` is what a click opens.
 */
export type CommentAnswerItem = ChatMessage & { annotationId: string };

export function toCommentAnswerItem(answer: ThreadAnswer): CommentAnswerItem {
  return {
    id: answer.replyId,
    author: "claude",
    text: answer.text,
    timestamp: answer.timestamp,
    read: false,
    documentId: answer.documentId,
    annotationId: answer.annotationId,
  };
}

/**
 * What a comment-answer notification says, under the same content setting as
 * a chat reply: `generic` never names the document (lock screens), `document`
 * names it, `preview` adds the start of Claude's answer — never the user's own
 * comment. A batch naming more than one document names none. Both halves go
 * through `previewText` (whose input bound is load-bearing) and
 * `cleanNotificationText`, as chat's do.
 */
export function buildCommentNotificationText(
  items: readonly ChatMessage[],
  content: ChatNotificationContent,
  documentName: (documentId: string) => string | null,
): NotificationText {
  const count = items.length;
  const last = items[count - 1];
  const documentIds = new Set(items.map((item) => item.documentId ?? ""));
  const name =
    content !== "generic" && documentIds.size === 1 && last?.documentId
      ? documentName(last.documentId)
      : null;
  const lead =
    count > 1 ? `Claude sent ${count} replies to your comments` : "Claude replied to your comment";
  const title = name ? `${lead} in ${name}` : lead;
  const body = content === "preview" && last ? previewText(last.text) : "";
  return {
    title: cleanNotificationText(title, NOTIFICATION_TITLE_MAX_CHARS),
    body: cleanNotificationText(body, NOTIFICATION_BODY_MAX_CHARS),
  };
}

/**
 * One taskbar flash / `(N)` title count over two dispatchers. Each view's
 * `attention(n)` records its own count and shows the sum. A view's
 * `clearAttention` zeroes only its own count, so each count keeps matching
 * its instance's `pendingCount`, and shows what remains; the real flash is
 * withdrawn once both are zero. `notify` passes through with the view's kind,
 * so the backend picks the tag or command.
 */
export function combineAttention(backend: NotifierBackend): {
  chat: NotifierBackend;
  comment: NotifierBackend;
} {
  const counts: Record<NotificationKind, number> = { chat: 0, comment: 0 };
  const view = (kind: NotificationKind): NotifierBackend => ({
    notify(text, onClick) {
      backend.notify(text, onClick, kind);
    },
    attention(count) {
      counts[kind] = count;
      backend.attention(counts.chat + counts.comment);
    },
    clearAttention() {
      counts[kind] = 0;
      const remaining = counts.chat + counts.comment;
      // The remaining count keeps the title honest; on desktop a request on
      // the focused window it comes back to is a no-op, so this cannot
      // re-flash when the two instances reset one after the other.
      if (remaining > 0) backend.attention(remaining);
      else backend.clearAttention();
    },
  });
  return { chat: view("chat"), comment: view("comment") };
}

/**
 * Route a desktop notification click by the kind Rust put in the event
 * payload (`NotificationKind::as_str`). Anything but `"comment"` — including a
 * missing payload from a click the platform could not describe — goes to chat,
 * which is what every click did before #2360.
 */
export function routeNotificationActivation(
  payload: unknown,
  targets: { chat: () => void; comment: () => void },
): void {
  if (payload === NOTIFICATION_KIND_COMMENT) targets.comment();
  else targets.chat();
}

/**
 * A comment-answer notification click: switch to the answer's document (if it
 * is still open) FIRST, then show the annotations rail, and return what to
 * park for `resolvePendingReveal`. The order is load-bearing: the rail's
 * reveal remembers the document active when it opened and closes itself on a
 * document switch, so revealing first and switching second would open and
 * shut it in one flush and leave a collapsed rail.
 */
export function startCommentReveal(
  target: Pick<CommentAnswerItem, "documentId" | "annotationId"> | undefined,
  deps: {
    isOpen: (documentId: string) => boolean;
    switchTo: (documentId: string) => void;
    showAnnotationsRail: () => void;
  },
): PendingReveal | null {
  const documentId = target?.documentId;
  const reachable = target !== undefined && documentId !== undefined && deps.isOpen(documentId);
  if (reachable) deps.switchTo(documentId);
  deps.showAnnotationsRail();
  return reachable ? { documentId, annotationId: target.annotationId } : null;
}

/** A comment a notification click is waiting to reveal. */
export interface PendingReveal {
  documentId: string;
  annotationId: string;
}

/** How long a click waits for its document's annotations to arrive. */
export const PENDING_REVEAL_MS = 5_000;

/**
 * What to do with a parked reveal now. `wait` until the doc is active and the
 * annotation has arrived (switching tabs repopulates the active document's
 * annotations asynchronously); `reveal` once both hold; `drop` when the doc is
 * no longer open. The caller also drops it after `PENDING_REVEAL_MS` (the
 * comment was resolved, removed or filtered away) — the user is still left on
 * the annotations rail.
 */
export function resolvePendingReveal(
  pending: PendingReveal,
  state: {
    activeDocumentId: string | null;
    openDocumentIds: readonly string[];
    hasAnnotation: (id: string) => boolean;
  },
): "wait" | "reveal" | "drop" {
  if (!state.openDocumentIds.includes(pending.documentId)) return "drop";
  if (state.activeDocumentId === pending.documentId && state.hasAnnotation(pending.annotationId)) {
    return "reveal";
  }
  return "wait";
}
