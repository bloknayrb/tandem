import type { ChatMessage } from "../../shared/types";
import type { ChatNotificationContent, ChatSound } from "../hooks/useTandemSettings";

/**
 * Turns live Claude replies into attention (#2168): a chime, and — only while
 * this window is not active — an OS notification plus a taskbar flash
 * (desktop) or a `(N)` tab-title count (browser).
 *
 * Pure orchestration over injected dependencies, so every branch is testable
 * without a DOM, a Tauri runtime or Web Audio.
 *
 * **"Active"** is whatever `isActive()` reports: this window is focused, or —
 * when the `chatSeenWhenVisible` setting is on — merely visible on screen. With
 * that setting several windows can be active at once, and each one chimes.
 *
 * **Shape of an announcement.** Replies are coalesced for `coalesceMs` first.
 * An active window then chimes once per coalesced batch and does nothing else.
 * An away window counts the batch into the flash / title count and holds it;
 * at most once per `notifyIntervalMs` it announces everything held (one chime,
 * one notification), and a burst that lands inside the interval is announced
 * by a trailing timer when the interval ends, so no held reply goes unannounced.
 *
 * **Multi-window rule.** Every open Tandem window (desktop app, browser tabs)
 * sees the same reply. An away window drops any reply already in the shared
 * chat-seen map: an active window with chat visible acknowledges a reply as
 * soon as it renders it, and the coalescing window gives that write time to
 * arrive. The same check runs again before a held reply is announced. What
 * this cannot see: two away windows both announce, and an active window with
 * chat hidden does not acknowledge, so an away sibling still announces. If
 * every held reply is read elsewhere, nothing is announced, but the flash /
 * count stay until this window itself becomes active.
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
  /**
   * Is the user looking at this window (focused, or visible when
   * `chatSeenWhenVisible` is on)? Read at flush time and when a trailing
   * announcement fires.
   */
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
  /** Minimum gap between away-window announcements (chime + notification). */
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
/**
 * How long after the window became active a click still opens the notified
 * document. See `activate()`.
 */
const CLICK_TARGET_GRACE_MS = 5_000;

export function createChatAttention(deps: ChatAttentionDeps): ChatAttention {
  const coalesceMs = deps.coalesceMs ?? 750;
  const notifyIntervalMs = deps.notifyIntervalMs ?? 30_000;
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let queue: ChatMessage[] = [];
  let coalesceTimer: unknown = null;
  // Replies counted into the flash / title count since the user was last here.
  let pendingCount = 0;
  // Away-window replies waiting for the rate-limit gate to open. Rate limit:
  // an MCP client looping `tandem_reply` while the user is away would
  // otherwise post one OS notification and one chime per coalescing window —
  // and on macOS each unclicked notification parks a thread plus a
  // main-run-loop timer in the plugin.
  let held: ChatMessage[] = [];
  let lastAnnouncedAt = Number.NEGATIVE_INFINITY;
  let trailingTimer: unknown = null;
  // Where a click should take the user: the document of the NEWEST reply a
  // notification actually posted, whichever notification is clicked (an older
  // one may still sit in the OS notification centre). Never a held reply no
  // notification has named yet. Held here, never sent over IPC.
  let notifiedDocumentId: string | undefined;
  // When the window last became active. See `activate()`.
  let resetAt = Number.NEGATIVE_INFINITY;

  function flush(): void {
    coalesceTimer = null;
    const batch = queue;
    queue = [];
    if (batch.length === 0) return;
    const settings = deps.getSettings();
    if (deps.isActive()) {
      // The active window chimes even for a reply it has already acknowledged
      // itself, so no isSeen filter here.
      deps.playChime(settings.chatSound, settings.chatSoundVolume);
      return;
    }
    // Filter BEFORE touching the count: this is what lets an active sibling
    // acknowledge the reply first and keep this window quiet.
    const replies = batch.filter((reply) => !deps.isSeen(reply.id));
    if (replies.length === 0) return;
    pendingCount += replies.length;
    held.push(...replies);
    if (settings.chatAttentionFlash) deps.backend.attention(pendingCount);
    if (now() - lastAnnouncedAt >= notifyIntervalMs) announce();
    else armTrailing();
  }

  /** Announce everything held (one chime, one notification). Always empties `held`. */
  function announce(): void {
    const remaining = held.filter((reply) => !deps.isSeen(reply.id));
    held = [];
    if (remaining.length === 0) return;
    lastAnnouncedAt = now();
    const settings = deps.getSettings();
    deps.playChime(settings.chatSound, settings.chatSoundVolume);
    if (!settings.chatNotifications) return;
    notifiedDocumentId = remaining[remaining.length - 1].documentId;
    deps.backend.notify(
      buildNotificationText(remaining, settings.chatNotificationContent, deps.documentName),
      activate,
    );
  }

  function armTrailing(): void {
    if (trailingTimer !== null) return;
    trailingTimer = setTimer(
      () => {
        trailingTimer = null;
        // Back on this window before the interval ended: they see the replies.
        if (deps.isActive()) held = [];
        else announce();
      },
      Math.max(0, lastAnnouncedAt + notifyIntervalMs - now()),
    );
  }

  /**
   * A notification was clicked — the browser `onClick` or the desktop's
   * payload-free event, both land here.
   *
   * Clicking also brings the window forward, and the two can arrive in either
   * order: on desktop, Rust focuses the window (which fires `windowActivated`
   * and resets everything) BEFORE it emits the click event. So the target must
   * survive `reset()` — but only briefly: `CLICK_TARGET_GRACE_MS` after the
   * window became active, with nothing pending, a click comes from an old
   * notification left in the notification centre, and opening whatever
   * document it once named would be a stale jump. It just opens chat.
   */
  function activate(): void {
    const fresh = pendingCount > 0 || now() - resetAt < CLICK_TARGET_GRACE_MS;
    deps.openChat(fresh ? notifiedDocumentId : undefined);
    reset();
  }

  function cancelTrailing(): void {
    if (trailingTimer !== null) clearTimer(trailingTimer);
    trailingTimer = null;
  }

  function reset(): void {
    // The user is back: drop what was held and let the next absence announce
    // immediately. `notifiedDocumentId` deliberately survives (see activate).
    held = [];
    lastAnnouncedAt = Number.NEGATIVE_INFINITY;
    cancelTrailing();
    if (pendingCount === 0) return;
    pendingCount = 0;
    deps.backend.clearAttention();
  }

  return {
    push(replies) {
      if (replies.length === 0) return;
      queue.push(...replies);
      if (coalesceTimer === null) coalesceTimer = setTimer(flush, coalesceMs);
    },
    windowActivated() {
      resetAt = now();
      reset();
    },
    notificationActivated() {
      activate();
    },
    destroy() {
      if (coalesceTimer !== null) clearTimer(coalesceTimer);
      coalesceTimer = null;
      cancelTrailing();
      queue = [];
      held = [];
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

/**
 * First line-ish of a reply as plain text, capped. Strips the markdown a
 * notification would otherwise show literally, and nothing that only looks
 * like it: `my_config_file.md`, `x > 3` and `a * b * c` come through
 * unchanged. Written without regex lookbehind, which WebKit before Safari 16.4
 * (the macOS WebView on older systems) rejects at parse time.
 */
export function previewText(text: string): string {
  const lines = text
    // Fenced code, including one a streamed reply has not closed yet.
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    // Images and links keep only their text.
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .split("\n")
    .map(stripBlockMarkers);
  const flat = lines
    .join(" ")
    // Inline code keeps its contents verbatim; emphasis is stripped only
    // outside it. `split` with a capture group puts the code at odd indices.
    .split(/`([^`]+)`/)
    .map((part, index) => (index % 2 === 1 ? part : stripEmphasis(part)))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(flat);
  if (chars.length <= PREVIEW_MAX_CHARS) return flat;
  return `${chars
    .slice(0, PREVIEW_MAX_CHARS - 1)
    .join("")
    .trimEnd()}…`;
}

const BLOCK_MARKER = /^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+)/;

/** Leading heading / quote / bullet markers, repeatedly (`> - item` → `item`). */
function stripBlockMarkers(line: string): string {
  let out = line;
  for (;;) {
    const next = out.replace(BLOCK_MARKER, "");
    if (next === out) return out;
    out = next;
  }
}

/**
 * Paired `**` / `~~` / `*` around non-space content, and paired `_` / `__`
 * only at word boundaries (CommonMark's intraword rule, so snake_case
 * survives). The `??` keeps each pair as short as possible.
 */
function stripEmphasis(text: string): string {
  return text
    .replace(/(\*\*|~~)(\S(?:.*?\S)??)\1/g, "$2")
    .replace(/\*(\S(?:.*?\S)??)\*/g, "$1")
    .replace(/(^|[^\p{L}\p{N}_])(__?)(\S(?:.*?\S)??)\2(?![\p{L}\p{N}_])/gu, "$1$3");
}
