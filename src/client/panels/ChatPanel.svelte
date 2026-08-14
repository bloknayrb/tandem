<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import { untrack } from "svelte";
import type { FlatOffset } from "../../shared/positions/types";
import type { CapturedAnchor, ChatMessage } from "../../shared/types";
import { scrollFade } from "../actions/scrollFade.svelte.js";
import { createAgentLabel } from "../hooks/useAgentLabel.svelte";
import { flatOffsetToPmPos } from "../positions";
import { agentColor } from "../utils/agent-color";
import { localChatDateLabel } from "./chat-export";
import { renderMarkdown } from "./chat-markdown";

const TYPING_DOT_DELAYS = [0, 0.2, 0.4];

/** Composer auto-grows with its content up to this many lines, then scrolls. */
const COMPOSER_MAX_LINES = 8;
/**
 * Mirrors `--tandem-ui-leading` (index.html), which `.chat-textarea` sets as
 * its line-height. Only read if that declaration ever disappears — see
 * `resizeComposer()`.
 */
const COMPOSER_FALLBACK_LEADING = 1.4;

const agentLabel = createAgentLabel();

interface Props {
  messages: ChatMessage[];
  unreadCount?: number;
  editor: TiptapEditor | null;
  activeDocId: string | null;
  openDocs: Array<{ id: string; fileName: string }>;
  claudeActive?: boolean;
  claudeStatus?: string | null;
  visible?: boolean;
  capturedAnchor: CapturedAnchor | null;
  onCapturedAnchorChange: (anchor: CapturedAnchor | null) => void;
  onSend: (text: string) => boolean | void;
  onClear: () => Promise<unknown>;
  onExport: () => Promise<unknown>;
  onInsert: (message: ChatMessage) => boolean | void;
  canInsert?: boolean;
  /** Bind to get a reference to the textarea element. */
  inputEl?: HTMLTextAreaElement | null;
  reduceMotion?: boolean;
}

let {
  messages,
  unreadCount = 0,
  editor,
  activeDocId,
  openDocs,
  claudeActive,
  claudeStatus,
  visible,
  capturedAnchor,
  onCapturedAnchorChange,
  onSend,
  onClear,
  onExport,
  onInsert,
  canInsert = false,
  inputEl = $bindable(null),
  reduceMotion,
}: Props = $props();

const scrollBehavior: ScrollBehavior = $derived(reduceMotion ? "auto" : "smooth");

let inputText = $state("");
let actionError = $state<string | null>(null);
let clearing = $state(false);
let exporting = $state(false);

let messagesEndEl: HTMLDivElement | undefined = $state();
let internalInputEl: HTMLTextAreaElement | undefined = $state();
let composerMultiline = $state(false);

// Keep external binding in sync
$effect(() => {
  inputEl = internalInputEl ?? null;
});

// Auto-scroll to bottom on new messages or when typing indicator appears
let prevClaudeActive = false;
$effect(() => {
  void messages; // track message changes
  const active = !!claudeActive;
  // untrack: reduceMotion pref change shouldn't re-trigger scroll.
  const sb = untrack(() => scrollBehavior);

  if (!active && prevClaudeActive) {
    prevClaudeActive = false;
    return;
  }
  prevClaudeActive = active;
  messagesEndEl?.scrollIntoView({ behavior: sb });
});

// Scroll to bottom when panel becomes visible
$effect(() => {
  const vis = visible;
  const sb = untrack(() => scrollBehavior);
  if (vis) {
    messagesEndEl?.scrollIntoView({ behavior: sb });
  }
});

// Composer auto-grow: size the textarea to its content so a two-line draft
// doesn't get a scrollbar inside a one-line pill. Past COMPOSER_MAX_LINES the
// height is capped and the textarea starts scrolling — that's the only state
// where a scrollbar is correct, because the alternative is unreachable text.
function resizeComposer() {
  const el = internalInputEl;
  // A hidden panel (PanelSlot uses display:none) reports zero metrics; leave
  // the height alone and recompute when `visible` flips back.
  if (!el || el.clientWidth === 0) return;

  const cs = getComputedStyle(el);
  // `.chat-textarea` sets a unitless line-height so this resolves to px. The
  // fallback keeps the cap finite if that declaration ever goes away — `normal`
  // parses to NaN, and a NaN max lets the box grow without bound.
  const lineHeight =
    Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * COMPOSER_FALLBACK_LEADING;
  const borders = Number.parseFloat(cs.borderTopWidth) + Number.parseFloat(cs.borderBottomWidth);
  const padding = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom);
  // Ceil the text block: browsers round scrollHeight up to an integer, so a
  // fractional cap (13px x 1.4 x 8 = 145.6) reads as overflowing at exactly
  // COMPOSER_MAX_LINES and clips the last line by a pixel.
  const maxHeight = Math.ceil(lineHeight * COMPOSER_MAX_LINES) + padding + borders;

  // scrollHeight is content + padding (border-box excludes the border), so add
  // the borders back before comparing against a border-box height.
  el.style.height = "auto";
  const needed = el.scrollHeight + borders;
  el.style.height = `${Math.min(needed, maxHeight)}px`;
  el.style.overflowY = needed > maxHeight ? "auto" : "hidden";
  // A pill radius on a tall box renders as two half-circles; soften once the
  // composer stops being a single line. Safe to write from here: the effect
  // below never reads it, and a ResizeObserver callback is not a reaction.
  composerMultiline = needed > lineHeight + padding + borders + 1;
}

$effect(() => {
  void inputText; // typing, and the programmatic clear in sendMessage()
  void visible; // remeasure after the panel comes back from display:none
  resizeComposer();
});

// The right rail is user-resizable, so the wrap points — and therefore the
// needed height — change without the text changing. Width-gated to keep our
// own height writes from re-entering the observer.
$effect(() => {
  const el = internalInputEl;
  if (!el) return;
  // -1 (not `el.clientWidth`) so the first callback always measures: clientWidth
  // is a padding-box metric but `contentRect.width` below is content-box, so
  // seeding from clientWidth made the first delivery a guaranteed false-positive
  // "width changed" by exactly the horizontal padding.
  let lastWidth = -1;
  // Construction is guarded the same way `scrollFade` guards its own observer.
  let ro: ResizeObserver | null = null;
  try {
    ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width === lastWidth) return;
      lastWidth = width;
      resizeComposer();
    });
    ro.observe(el);
  } catch (err) {
    console.warn("[ChatPanel] Composer ResizeObserver init failed", err);
  }
  return () => ro?.disconnect();
});

function sendMessage() {
  if (!inputText.trim()) return;
  if (onSend(inputText.trim()) === false) return;
  inputText = "";
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function scrollToAnchor(anchor: { from: FlatOffset; to: FlatOffset }, docId?: string) {
  if (!editor || (docId && docId !== activeDocId)) return;
  try {
    const pmFrom = flatOffsetToPmPos(editor.state.doc, anchor.from);
    const pmTo = flatOffsetToPmPos(editor.state.doc, anchor.to);
    editor.chain().focus().setTextSelection({ from: pmFrom, to: pmTo }).scrollIntoView().run();
  } catch (err) {
    console.warn(
      "[ChatPanel] Could not scroll to anchor:",
      err instanceof Error ? err.message : err,
    );
  }
}

function getDocFileName(docId?: string): string | null {
  if (!docId) return null;
  const doc = openDocs.find((d) => d.id === docId);
  return doc?.fileName ?? null;
}

async function clearChat() {
  clearing = true;
  actionError = null;
  try {
    await onClear();
  } catch (err) {
    actionError = err instanceof Error ? err.message : "Chat history could not be cleared.";
  } finally {
    clearing = false;
  }
}

async function exportChat() {
  exporting = true;
  actionError = null;
  try {
    await onExport();
  } catch (err) {
    actionError = err instanceof Error ? err.message : "Chat could not be exported.";
  } finally {
    exporting = false;
  }
}
</script>

<div
  data-testid="chat-panel"
  style="width: 100%; display: flex; flex-direction: column; background: var(--tandem-surface-muted); flex: 1; min-height: 0;"
>
  <!-- Header. #1382: no "Chat" title — the rail's tab pill above already says
       so. With the word gone the row has nothing to show on an empty chat (the
       unread pill and Export/Clear are all content-gated), so the row is gated
       too rather than rendering as a bordered, padded empty strip under the
       tabs. It reappears whenever content returns, and `clearChat` can take it
       away again, so this is a recurring transition rather than a one-time one.

       `font-weight: 600` stays even though the text it was written for is gone:
       `.chat-header-action` is `font: inherit`, overriding only `font-size`, so
       the weight here is what renders Export/Clear and the unread count at 600.
       Dropping it silently demotes all three to 400. `--tandem-text-md` was
       genuinely inert (that same rule sets its own `font-size`) and is gone. -->
  {#if unreadCount > 0 || messages.length > 0}
    <div
      style="padding: var(--tandem-space-3) var(--tandem-space-4); border-bottom: 1px solid var(--tandem-border); font-weight: 600; display: flex; align-items: center;"
    >
      <div
        style="display: flex; align-items: center; gap: var(--tandem-space-2); margin-left: auto;"
      >
        {#if unreadCount > 0}
          <span
            style="background: var(--tandem-accent); color: var(--tandem-accent-fg); border-radius: var(--tandem-r-pill); padding: 2px 8px; font-size: var(--tandem-text-xs);"
          >
            {unreadCount}
          </span>
        {/if}
        {#if messages.length > 0}
          <button
            onclick={exportChat}
            disabled={exporting}
            title="Export complete chat to a scratchpad"
            class="chat-header-action"
          >
            {exporting ? "Exporting…" : "Export"}
          </button>
          <button
            onclick={clearChat}
            disabled={clearing}
            title="Clear chat history"
            data-testid="clear-chat-btn"
            class="chat-header-action"
          >
            {clearing ? "Clearing…" : "Clear"}
          </button>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Messages -->
  <div
    class="tandem-scroll-fade-y"
    use:scrollFade={"y"}
    style="flex: 1; overflow: auto; padding: var(--tandem-space-3); min-height: 0;"
  >
    {#if messages.length === 0}
      <div
        style="color: var(--tandem-fg-subtle); font-size: 13px; text-align: center; margin-top: 24px;"
      >
        No messages yet. Select text and send a message to your AI.
      </div>
    {/if}
    {#if actionError}
      <div class="chat-action-error" role="alert">{actionError}</div>
    {/if}
    {#each messages as msg, index (msg.id)}
      {#if index === 0 || localChatDateLabel(messages[index - 1].timestamp) !== localChatDateLabel(msg.timestamp)}
        <div class="chat-date-divider" role="separator">
          <span>{localChatDateLabel(msg.timestamp)}</span>
        </div>
      {/if}
      <div
        class="chat-bubble"
        data-allow-context-menu
        class:user={msg.author === "user"}
        class:claude={msg.author === "claude"}
        class:identified={msg.author === "claude" && !!msg.agentIdentity}
        style:--chat-agent-color={msg.author === "claude"
          ? agentColor(msg.agentIdentity)
          : undefined}
      >
        <!-- Author + doc badge -->
        <div style="display: flex; gap: 6px; align-items: center; margin-bottom: 4px;">
          <!-- A local-model chat author keeps its per-agent token; an
               identity-less Claude message uses the canonical coral author
               token, matching the bubble tint and the rest of authorship UI. -->
          <span
            data-testid="chat-author-{msg.id}"
            style="font-weight: 600; font-size: 11px; color: {msg.author === 'claude'
              ? (msg.agentIdentity
                  ? agentColor(msg.agentIdentity)
                  : 'var(--tandem-author-claude-fg-strong)')
              : 'var(--tandem-fg-muted)'}; text-transform: uppercase;"
          >
            {msg.author === "claude"
              ? (msg.agentIdentity?.displayName ?? agentLabel.family)
              : "You"}
          </span>
          {#if msg.documentId}
            <span
              style="font-size: var(--tandem-text-2xs); color: var(--tandem-fg-muted); background: var(--tandem-surface-muted); padding: 1px 6px; border-radius: var(--tandem-r-2);"
            >
              {getDocFileName(msg.documentId) ?? msg.documentId}
            </span>
          {/if}
          <span style="font-size: 10px; color: var(--tandem-fg-subtle); margin-left: auto;">
            {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>

        <!-- Anchor quote -->
        {#if msg.anchor}
          <button
            type="button"
            onclick={() => scrollToAnchor(msg.anchor!, msg.documentId)}
            class="chat-anchor-quote"
            data-testid="chat-anchor-quote-{msg.id}"
            style="background: var(--tandem-accent-bg); border: none; border-left: 3px solid var(--tandem-accent-border); padding: 4px 8px; margin-bottom: 6px; font: inherit; color: var(--tandem-accent-fg-strong); cursor: pointer; text-align: left; width: 100%; font-size: var(--tandem-text-sm); border-radius: 0 var(--tandem-r-2) var(--tandem-r-2) 0;"
            title="Click to scroll to this text"
          >
            {msg.anchor.textSnapshot}
          </button>
        {/if}

        <!-- Message text -->
        {#if msg.author === "claude"}
          <div class="chat-markdown">
            {@html renderMarkdown(msg.text)}
          </div>
        {:else}
          <div style="white-space: pre-wrap; word-break: break-word;">{msg.text}</div>
        {/if}
        <div class="chat-message-actions">
          <button
            type="button"
            onclick={() => onInsert(msg)}
            disabled={!canInsert}
            title={canInsert ? "Insert message into the open document" : "Open an editable formatted document to insert"}
          >Insert into open document</button>
        </div>
      </div>
    {/each}

    {#if claudeActive}
      <div
        style="padding: var(--tandem-space-2) var(--tandem-space-3); margin-bottom: var(--tandem-space-2); font-size: 12px; color: var(--tandem-author-claude); display: flex; align-items: center; gap: var(--tandem-space-2);"
      >
        <span style="display: inline-flex; gap: 3px;">
          {#each TYPING_DOT_DELAYS as delay (delay)}
            <span
              style="width: 5px; height: 5px; border-radius: 50%; background: var(--tandem-author-claude); animation: tandem-typing-bounce 1.2s ease-in-out {delay}s infinite;"
            ></span>
          {/each}
        </span>
        <span>{claudeStatus ?? "Your AI is thinking..."}</span>
      </div>
    {/if}
    <div bind:this={messagesEndEl}></div>
  </div>

  <!-- Anchor indicator -->
  {#if capturedAnchor}
    <div
      style="padding: var(--tandem-space-1) var(--tandem-space-3); background: var(--tandem-accent-bg); border-top: 1px solid var(--tandem-accent-border); font-size: 11px; color: var(--tandem-accent-fg-strong); display: flex; justify-content: space-between; align-items: center;"
    >
      <span>
        with selection: &ldquo;{capturedAnchor.textSnapshot.slice(0, 40)}{capturedAnchor.textSnapshot
          .length > 40
          ? "..."
          : ""}&rdquo;
      </span>
      <button
        onclick={() => onCapturedAnchorChange(null)}
        style="background: none; border: none; cursor: pointer; color: var(--tandem-fg-muted); font-size: 14px;"
      >
        x
      </button>
    </div>
  {/if}

  <!-- Composer: a rounded pill textarea + a standalone circular send button,
       matching the SideRail chat composer in the redesign. The pill carries
       its own border + focus ring; the send button is a separate accent circle
       with a paper-plane glyph (the prototype's dark-warm fill maps to the
       app's accent primary so it stays on the semantic-token system). -->
  <div class="chat-input-area">
    <textarea
      bind:this={internalInputEl}
      value={inputText}
      oninput={(e) => (inputText = (e.target as HTMLTextAreaElement).value)}
      onkeydown={handleKeyDown}
      placeholder="Message your AI…"
      rows={1}
      class="chat-textarea"
      data-multiline={composerMultiline}
      data-testid="chat-composer-input"
    ></textarea>
    <button
      onclick={sendMessage}
      disabled={!inputText.trim()}
      class="chat-send-btn"
      aria-label="Send message"
      title="Send · Enter"
      data-testid="chat-send-btn"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        style="display:block"
        aria-hidden="true"
      >
        <path d="M14 2L2 8l4 2 2 4 2-4 4-8z" />
      </svg>
    </button>
  </div>
</div>

<style>
  .chat-bubble {
    margin-bottom: var(--tandem-space-3);
    padding: var(--tandem-space-2) var(--tandem-space-3);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-4);
    background: var(--tandem-surface);
    color: var(--tandem-fg);
    font-size: var(--tandem-text-base);
    box-shadow: var(--tandem-shadow-1);
  }
  .chat-bubble.user {
    background: var(--tandem-accent-bg);
    border-color: var(--tandem-accent-border);
  }
  .chat-bubble.claude {
    background: var(--tandem-author-claude-bg);
    border-color: var(--tandem-author-claude-border);
  }
  .chat-bubble.claude.identified {
    background: color-mix(in srgb, var(--chat-agent-color) 10%, var(--tandem-surface));
    border-color: color-mix(in srgb, var(--chat-agent-color) 35%, var(--tandem-border));
  }
  .chat-header-action,
  .chat-message-actions button {
    border: 0;
    background: transparent;
    color: var(--tandem-fg-subtle);
    font: inherit;
    font-size: var(--tandem-text-xs);
    cursor: pointer;
    padding: 2px 4px;
  }
  .chat-header-action:hover:not(:disabled),
  .chat-message-actions button:hover:not(:disabled),
  .chat-header-action:focus-visible,
  .chat-message-actions button:focus-visible {
    color: var(--tandem-accent-fg-strong);
    outline: 2px solid var(--tandem-accent);
    outline-offset: 2px;
    border-radius: var(--tandem-r-2);
  }
  .chat-header-action:disabled,
  .chat-message-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .chat-message-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: var(--tandem-space-1);
  }
  .chat-action-error {
    margin-bottom: var(--tandem-space-3);
    padding: var(--tandem-space-2);
    border: 1px solid var(--tandem-error-border);
    border-radius: var(--tandem-r-3);
    color: var(--tandem-error-fg-strong);
    background: var(--tandem-error-bg);
    font-size: var(--tandem-text-sm);
  }
  .chat-date-divider {
    display: flex;
    align-items: center;
    gap: var(--tandem-space-2);
    margin: var(--tandem-space-3) 0;
    color: var(--tandem-fg-subtle);
    font-size: var(--tandem-text-xs);
  }
  .chat-date-divider::before,
  .chat-date-divider::after {
    content: "";
    height: 1px;
    flex: 1;
    background: var(--tandem-border);
  }

  :global {
    @keyframes tandem-typing-bounce {
      0%,
      60%,
      100% {
        transform: translateY(0);
        opacity: 0.4;
      }
      30% {
        transform: translateY(-4px);
        opacity: 1;
      }
    }
  }

  .chat-markdown :global(h1),
  .chat-markdown :global(h2),
  .chat-markdown :global(h3) {
    margin: 0.5em 0 0.25em;
    font-weight: 600;
  }
  .chat-markdown :global(p) {
    margin: 0.25em 0;
  }
  .chat-markdown :global(code) {
    font-family: monospace;
    font-size: 0.9em;
    background: var(--tandem-surface-muted);
    padding: 1px 4px;
    border-radius: var(--tandem-r-2);
  }
  .chat-markdown :global(li) {
    margin-left: 1.25em;
    list-style: disc;
  }
  .chat-markdown :global(strong) {
    font-weight: 600;
  }
  .chat-markdown :global(em) {
    font-style: italic;
  }

  /* Anchor quote — collapsed to a 60px teaser, expands on hover OR focus so
     keyboard users (Tab to the button) get the same reveal as a mouse hover
     (C2). The element is already a <button>, so focus-visible + Enter
     activation come free from native semantics. */
  .chat-anchor-quote {
    max-height: 60px;
    overflow: hidden;
    transition: max-height 0.3s ease;
  }
  .chat-anchor-quote:hover,
  .chat-anchor-quote:focus-visible {
    max-height: 500px;
  }
  /* Reduce-motion guard (C2) — ChatPanel had no existing reduce-motion block.
     The `reduceMotion` prop drives `scrollBehavior` (JS) but nothing CSS today;
     the pre-C2 inline transition ignored it too, so this preserves that parity
     rather than introducing new prop-driven behavior. */
  @media (prefers-reduced-motion: reduce) {
    .chat-anchor-quote {
      transition: none;
    }
  }
  :global(body.tandem-reduce-motion) .chat-anchor-quote {
    transition: none;
  }

  /* Composer — pill textarea + circular send button, matching the SideRail
     chat composer in the redesign; the prototype's dark-warm send fill maps to
     the app's accent primary, and a disabled state (muted, no pointer) is added
     for the empty-input case the static prototype didn't model. */
  .chat-input-area {
    display: flex;
    gap: var(--tandem-space-2);
    align-items: flex-end;
    flex-shrink: 0;
    padding: var(--tandem-space-3);
    border-top: 1px solid var(--tandem-border);
    background: var(--tandem-surface-muted);
  }
  .chat-textarea {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--tandem-border);
    background: var(--tandem-surface);
    border-radius: var(--tandem-r-pill);
    padding: 8px 14px;
    font-family: inherit;
    font-size: var(--tandem-text-base);
    /* Load-bearing: resizeComposer() reads the computed line-height to derive
       the COMPOSER_MAX_LINES cap, so this must stay an explicit ratio —
       `normal` computes to the literal string, not a px value. */
    line-height: var(--tandem-ui-leading);
    color: var(--tandem-fg);
    resize: none;
    outline: none;
    min-height: 36px;
    /* Grown by resizeComposer(); `hidden` is the pre-JS default so a one-line
       composer never flashes a scrollbar. */
    overflow-y: hidden;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }
  .chat-textarea[data-multiline="true"] {
    border-radius: var(--tandem-r-5);
  }
  .chat-textarea:focus {
    border-color: var(--tandem-accent);
    box-shadow: 0 0 0 3px var(--tandem-accent-bg);
  }
  .chat-send-btn {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    border-radius: var(--tandem-r-circle);
    border: none;
    background: var(--tandem-accent);
    color: var(--tandem-accent-fg);
    display: grid;
    place-items: center;
    cursor: pointer;
    transition: filter 150ms ease, background 120ms ease, color 120ms ease;
  }
  .chat-send-btn:hover:not(:disabled) {
    filter: brightness(1.12);
  }
  .chat-send-btn:disabled {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg-faint);
    cursor: default;
  }
</style>
