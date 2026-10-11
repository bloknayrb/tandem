import type { ChatMessage } from "../../shared/types";
import type { ChatNotificationContent, ChatSound } from "../hooks/useTandemSettings";

/**
 * Turns live Claude replies into attention (#2168): a chime, and — only while
 * this window is not the one the user is looking at — an OS notification plus
 * a taskbar flash (desktop) or a `(N)` tab-title count (browser).
 *
 * Pure orchestration over injected dependencies, so every branch is testable
 * without a DOM, a Tauri runtime or Web Audio.
 *
 * **Multi-window rule.** Every open Tandem window (desktop app, browser tabs)
 * sees the same reply. Only one can be focused, and that one always gets the
 * chime. An unfocused window drops any reply already in the shared chat-seen
 * map: a focused window with chat visible acknowledges a reply as soon as it
 * renders it, and the coalescing window gives that write time to arrive. What
 * this cannot see: two unfocused windows both announce, and a focused window
 * with chat hidden does not acknowledge, so an unfocused sibling still
 * announces alongside its chime.
 */

export interface ChatAttentionSettings {
  chatNotifications: boolean;
  chatNotificationContent: ChatNotificationContent;
  chatAttentionFlash: boolean;
  chatSound: ChatSound;
  chatSoundVolume: number;
}

/** The platform half: desktop (`tauri-notifier.ts`) or browser (`web-notifier.ts`). */
export interface NotifierBackend {
  /** Post an OS notification. `onClick` runs if the platform reports a click to the page. */
  notify(text: NotificationText, onClick: () => void): void;
  /** Flash the taskbar (desktop) or show `count` in the tab title (browser). */
  attention(count: number): void;
  /** Undo `attention` once the user is back. */
  clearAttention(): void;
}

export interface NotificationText {
  title: string;
  body: string;
}

export interface ChatAttentionDeps {
  getSettings(): ChatAttentionSettings;
  /** Is this window focused and visible? Read at flush time. */
  isActive(): boolean;
  /** Has any window acknowledged this message (shared `Y_MAP_CHAT_SEEN`)? */
  isSeen(messageId: string): boolean;
  /** Path-free file name for a document id, or null. */
  documentName(documentId: string): string | null;
  backend: NotifierBackend;
  playChime(sound: ChatSound, volume: number): void;
  /** Bring the user to the reply: switch to its document if open, open chat. */
  openChat(documentId: string | undefined): void;
  coalesceMs?: number;
  /** Minimum gap between OS notifications while unfocused. */
  notifyIntervalMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ChatAttention {
  /** Queue live replies; announced together after the coalescing window. */
  push(replies: readonly ChatMessage[]): void;
  /** The user is back on this window: clear the flash / title count. */
  windowActivated(): void;
  /** A desktop notification was clicked (payload-free event). */
  notificationActivated(): void;
  destroy(): void;
}

const PREVIEW_MAX_CHARS = 140;

export function createChatAttention(deps: ChatAttentionDeps): ChatAttention {
  const coalesceMs = deps.coalesceMs ?? 750;
  const notifyIntervalMs = deps.notifyIntervalMs ?? 30_000;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let queue: ChatMessage[] = [];
  let timer: unknown = null;
  let pendingCount = 0;
  // Where a click should take the user: the NEWEST announced reply's document,
  // whichever notification is clicked (an older one may still sit in the OS
  // notification centre). Held here, never sent over IPC.
  let pendingDocumentId: string | undefined;
  // Rate limit. An MCP client looping `tandem_reply` while the user is away
  // would otherwise post one OS notification per coalescing window — and on
  // macOS each unclicked one parks a thread plus a main-run-loop timer in the
  // plugin. Replies held back here ride along in the next notification; the
  // flash / title count still tracks every one.
  let lastNotifiedAt = Number.NEGATIVE_INFINITY;
  let unnotified: ChatMessage[] = [];

  function flush(): void {
    timer = null;
    const batch = queue;
    queue = [];
    const active = deps.isActive();
    const replies = active ? batch : batch.filter((reply) => !deps.isSeen(reply.id));
    if (replies.length === 0) return;
    const settings = deps.getSettings();

    deps.playChime(settings.chatSound, settings.chatSoundVolume);
    if (active) return;

    pendingCount += replies.length;
    pendingDocumentId = replies[replies.length - 1].documentId;
    if (settings.chatNotifications) {
      unnotified.push(...replies);
      const at = now();
      if (at - lastNotifiedAt >= notifyIntervalMs) {
        lastNotifiedAt = at;
        const text = buildNotificationText(
          unnotified,
          settings.chatNotificationContent,
          deps.documentName,
        );
        unnotified = [];
        const documentId = pendingDocumentId;
        deps.backend.notify(text, () => {
          deps.openChat(documentId);
          reset();
        });
      }
    }
    if (settings.chatAttentionFlash) deps.backend.attention(pendingCount);
  }

  function reset(): void {
    // The user is back: the next absence starts with a fresh notification.
    lastNotifiedAt = Number.NEGATIVE_INFINITY;
    unnotified = [];
    if (pendingCount === 0) return;
    pendingCount = 0;
    deps.backend.clearAttention();
  }

  return {
    push(replies) {
      if (replies.length === 0) return;
      queue.push(...replies);
      if (timer === null) timer = setTimer(flush, coalesceMs);
    },
    windowActivated() {
      reset();
    },
    notificationActivated() {
      deps.openChat(pendingDocumentId);
      reset();
    },
    destroy() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      queue = [];
    },
  };
}

/**
 * What the notification says. `generic` never names the document, because the
 * notification can show on a lock screen; `document` names it; `preview` adds
 * the start of the reply. A batch naming more than one document names none.
 */
export function buildNotificationText(
  replies: readonly ChatMessage[],
  content: ChatNotificationContent,
  documentName: (documentId: string) => string | null,
): NotificationText {
  const count = replies.length;
  const last = replies[count - 1];
  const documentIds = new Set(replies.map((reply) => reply.documentId ?? ""));
  const name =
    content !== "generic" && documentIds.size === 1 && last.documentId
      ? documentName(last.documentId)
      : null;
  const lead = count > 1 ? `Claude sent ${count} replies` : "Claude replied";
  const title = name ? `${lead} in ${name}` : lead;
  const body = content === "preview" ? previewText(last.text) : "";
  return { title, body };
}

/** First line-ish of a reply, markdown punctuation dropped, capped. */
export function previewText(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(flat);
  if (chars.length <= PREVIEW_MAX_CHARS) return flat;
  return `${chars
    .slice(0, PREVIEW_MAX_CHARS - 1)
    .join("")
    .trimEnd()}…`;
}
