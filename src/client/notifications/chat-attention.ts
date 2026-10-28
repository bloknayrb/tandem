import type { ChatMessage } from "../../shared/types";
import type { ChatNotificationContent, ChatSound } from "../hooks/useTandemSettings";
import {
  cleanNotificationText,
  GREETING_NOTIFICATION_TITLE,
  NOTIFICATION_BODY_MAX_CHARS,
  NOTIFICATION_TITLE_MAX_CHARS,
  sliceCodeUnitsSafe,
} from "./notification-text";

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
 * An active window then chimes once per coalesced batch — at most once every
 * `MIN_ACTIVE_CHIME_GAP_MS` (2 s), so a client looping `tandem_reply` while the
 * user watches cannot turn the chime into a drone — and does nothing else.
 * An away window counts the batch into the flash / title count and holds it;
 * at most once per `notifyIntervalMs` it announces everything held (one chime,
 * one notification), and a burst that lands inside the interval is announced
 * by a trailing timer when the interval ends, so no held reply goes unannounced.
 * An announcement always chimes, whatever the active-window cap says: it has
 * its own limit, and with notifications off the chime is all it does.
 *
 * **Click rule.** A click opens chat on the document of the newest reply a
 * notification named, but only while that notification belongs to the current
 * absence (see `activate()`); otherwise it just opens chat.
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
 * How much of a reply `previewText` reads, in UTF-16 code units. See there.
 */
const PREVIEW_INPUT_MAX_UNITS = 2_000;
/**
 * How long after the user's first return following a notification a click
 * still opens the document it named. See `activate()`.
 */
const CLICK_TARGET_GRACE_MS = 5_000;
/**
 * Minimum gap between active-window chimes. An away announcement ignores it
 * but still counts as the last chime.
 */
const MIN_ACTIVE_CHIME_GAP_MS = 2_000;

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
  // Away-window replies waiting for the rate-limit gate to open. The limit is
  // about noise: an MCP client looping `tandem_reply` while the user is away
  // would otherwise post one OS notification and one chime per coalescing
  // window. (The per-notification cost of macOS's actionable notification is
  // bounded on the Rust side, not here.)
  let held: ChatMessage[] = [];
  let lastAnnouncedAt = Number.NEGATIVE_INFINITY;
  let trailingTimer: unknown = null;
  // When any chime last played, active or away. See `flush()`.
  let lastChimeAt = Number.NEGATIVE_INFINITY;
  // Where a click should take the user: the document of the NEWEST reply a
  // notification actually posted, whichever notification is clicked (an older
  // one may still sit in the OS notification centre). Never a held reply no
  // notification has named yet. Held here, never sent over IPC. `until` is
  // +Infinity while the user has not come back since the post, then a deadline
  // (see `activate()`); null once consumed or never armed.
  let clickTarget: { documentId: string | undefined; until: number } | null = null;

  function flush(): void {
    coalesceTimer = null;
    const batch = queue;
    queue = [];
    if (batch.length === 0) return;
    const settings = deps.getSettings();
    if (deps.isActive()) {
      // The active window chimes even for a reply it has already acknowledged
      // itself, so no isSeen filter here — but at most once per
      // `MIN_ACTIVE_CHIME_GAP_MS`; a batch inside the gap is covered by the last
      // chime.
      if (now() - lastChimeAt >= MIN_ACTIVE_CHIME_GAP_MS) chime(settings);
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
    // Always, regardless of the active-window cap: this has its own limit, and
    // skipping it could leave a reply both silent and un-notified.
    chime(settings);
    if (!settings.chatNotifications) return;
    clickTarget = {
      documentId: remaining[remaining.length - 1].documentId,
      until: Number.POSITIVE_INFINITY,
    };
    deps.backend.notify(
      buildNotificationText(remaining, settings.chatNotificationContent, deps.documentName),
      activate,
    );
  }

  function chime(settings: ChatAttentionSettings): void {
    lastChimeAt = now();
    deps.playChime(settings.chatSound, settings.chatSoundVolume);
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
   * order: in the browser the notification's `onclick` runs before the window
   * reports focus; on desktop, Rust focuses the window (which fires
   * `windowActivated`) BEFORE it emits the click event. So the target must
   * survive `reset()` — but only briefly. The grace starts at the FIRST return
   * after the post (`windowActivated` turns `until: +Infinity` into a
   * deadline) and nothing later extends it — not another return, and not a
   * later click's own focus, which on desktop arrives just before that click.
   * Past the deadline the click comes from an old notification left in the
   * notification centre, and opening whatever document it once named would be
   * a stale jump, so it just opens chat. A target is consumed by one click.
   */
  function activate(): void {
    const target = clickTarget && now() < clickTarget.until ? clickTarget.documentId : undefined;
    clickTarget = null;
    deps.openChat(target);
    reset();
  }

  function cancelTrailing(): void {
    if (trailingTimer !== null) clearTimer(trailingTimer);
    trailingTimer = null;
  }

  function reset(): void {
    // The user is back: drop what was held and let the next absence announce
    // immediately. `clickTarget` deliberately survives (see activate).
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
      // First return since the post starts the grace; later returns keep it.
      if (clickTarget?.until === Number.POSITIVE_INFINITY) {
        clickTarget.until = now() + CLICK_TARGET_GRACE_MS;
      }
      reset();
    },
    notificationActivated() {
      activate();
    },
    destroy() {
      if (coalesceTimer !== null) clearTimer(coalesceTimer);
      coalesceTimer = null;
      queue = [];
      clickTarget = null;
      // reset() also withdraws the flash / title count, which nothing would
      // clear once this instance is gone.
      reset();
    },
  };
}

/**
 * What the notification says. `generic` never names the document, because the
 * notification can show on a lock screen; `document` names it; `preview` adds
 * the start of the reply. A batch naming more than one document names none.
 *
 * Both halves go through `cleanNotificationText`, for both backends: the
 * browser posts this text as-is, so this is where a file name's U+202E or a
 * reply's zero-width characters are dropped and the caps applied. The desktop
 * path cleans again in Rust, which changes nothing.
 *
 * **Tandem's one-time hello (#2227)** is announced, chime and all, but not as
 * a reply: it answers nothing the user sent. A batch of nothing but the hello
 * reads `GREETING_NOTIFICATION_TITLE`, never naming a document (the hello is
 * about no file); `preview` still shows its start. In a mixed batch the hello
 * is left out of the count, the name and the preview, so a real answer still
 * reads "Claude replied …". The marker is the server's `greeting: true`
 * (`ChatMessage.greeting`); nothing here guesses from the text.
 */
export function buildNotificationText(
  replies: readonly ChatMessage[],
  content: ChatNotificationContent,
  documentName: (documentId: string) => string | null,
): NotificationText {
  const answers = replies.filter((reply) => reply.greeting !== true);
  if (answers.length === 0) {
    const hello = replies[replies.length - 1];
    const body = content === "preview" && hello ? previewText(hello.text) : "";
    return {
      title: cleanNotificationText(GREETING_NOTIFICATION_TITLE, NOTIFICATION_TITLE_MAX_CHARS),
      body: cleanNotificationText(body, NOTIFICATION_BODY_MAX_CHARS),
    };
  }
  const count = answers.length;
  const last = answers[count - 1];
  const documentIds = new Set(answers.map((reply) => reply.documentId ?? ""));
  const name =
    content !== "generic" && documentIds.size === 1 && last.documentId
      ? documentName(last.documentId)
      : null;
  const lead = count > 1 ? `Claude sent ${count} replies` : "Claude replied";
  const title = name ? `${lead} in ${name}` : lead;
  const body = content === "preview" ? previewText(last.text) : "";
  return {
    title: cleanNotificationText(title, NOTIFICATION_TITLE_MAX_CHARS),
    body: cleanNotificationText(body, NOTIFICATION_BODY_MAX_CHARS),
  };
}

/**
 * First line-ish of a reply as plain text, capped. Strips the markdown a
 * notification would otherwise show literally, and nothing that only looks
 * like it: `my_config_file.md`, `x > 3` and `a * b * c` come through
 * unchanged. Written without regex lookbehind, which WebKit before Safari 16.4
 * (the macOS WebView on older systems) rejects at parse time.
 *
 * **The input is bounded first, and the bound is load-bearing.** Several of
 * the regexes below are quadratic on adversarial text, because a match that
 * starts at every position can scan to the end of the input before failing:
 * the link regex on `[[[[…` or `[](` repeated, the paired-emphasis regexes on
 * ` _a` or ` **a` repeated. A reply is text an MCP client chooses, so 40k such
 * characters would cost seconds on the UI thread for a 140-character preview.
 * Reading only the first `PREVIEW_INPUT_MAX_UNITS` keeps that to milliseconds.
 * A reply that opens with a code block longer than the bound previews as an
 * empty body; the title still shows.
 */
export function previewText(text: string): string {
  const lines = sliceCodeUnitsSafe(text, PREVIEW_INPUT_MAX_UNITS)
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
