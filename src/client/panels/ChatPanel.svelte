<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import { untrack } from "svelte";
import * as Y from "yjs";
import { API_CHAT } from "../../shared/api-paths";
import { DEFAULT_MCP_PORT, Y_MAP_CHAT } from "../../shared/constants";
import type { FlatOffset } from "../../shared/positions/types";
import type { CapturedAnchor, ChatMessage } from "../../shared/types";
import { generateMessageId } from "../../shared/utils";
import { scrollFade } from "../actions/scrollFade.svelte.js";
import { createAgentLabel } from "../hooks/useAgentLabel.svelte";
import { flatOffsetToPmPos } from "../positions";
import { agentColor } from "../utils/agent-color";
import { renderMarkdown } from "./chat-markdown";

const TYPING_DOT_DELAYS = [0, 0.2, 0.4];

const agentLabel = createAgentLabel();

interface Props {
  ctrlYdoc: Y.Doc | null;
  editor: TiptapEditor | null;
  activeDocId: string | null;
  openDocs: Array<{ id: string; fileName: string }>;
  claudeActive?: boolean;
  claudeStatus?: string | null;
  visible?: boolean;
  capturedAnchor: CapturedAnchor | null;
  onCapturedAnchorChange: (anchor: CapturedAnchor | null) => void;
  /** Bind to get a reference to the textarea element. */
  inputEl?: HTMLTextAreaElement | null;
  reduceMotion?: boolean;
}

let {
  ctrlYdoc,
  editor,
  activeDocId,
  openDocs,
  claudeActive,
  claudeStatus,
  visible,
  capturedAnchor,
  onCapturedAnchorChange,
  inputEl = $bindable(null),
  reduceMotion,
}: Props = $props();

const scrollBehavior: ScrollBehavior = $derived(reduceMotion ? "auto" : "smooth");

let messages = $state<ChatMessage[]>([]);
let inputText = $state("");

let messagesEndEl: HTMLDivElement | undefined = $state();
let internalInputEl: HTMLTextAreaElement | undefined = $state();

// Keep external binding in sync
$effect(() => {
  inputEl = internalInputEl ?? null;
});

// Observe Y.Map('chat') for changes
$effect(() => {
  if (!ctrlYdoc) return;
  const chatMap = ctrlYdoc.getMap(Y_MAP_CHAT);

  const observer = () => {
    const msgs: ChatMessage[] = [];
    chatMap.forEach((value) => {
      msgs.push(value as ChatMessage);
    });
    msgs.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    messages = msgs;
  };

  chatMap.observe(observer);
  observer(); // initial load
  return () => chatMap.unobserve(observer);
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

const unreadCount = $derived(messages.filter((m) => m.author === "claude" && !m.read).length);

function sendMessage() {
  if (!ctrlYdoc || !inputText.trim()) return;
  const chatMap = ctrlYdoc.getMap(Y_MAP_CHAT);

  const msg: ChatMessage = {
    id: generateMessageId(),
    author: "user",
    text: inputText.trim(),
    timestamp: Date.now(),
    ...(activeDocId ? { documentId: activeDocId } : {}),
    ...(capturedAnchor ? { anchor: capturedAnchor } : {}),
    read: false,
  };

  chatMap.set(msg.id, msg);
  inputText = "";
  onCapturedAnchorChange(null);

  // #1018: the message persists in the chat Y.Map and is read whenever an
  // agent next connects/polls — but if no AI is connected right now, App
  // surfaces a "saved, will be seen when AI connects" notice. Read-after-write
  // only; never gates the send.
  window.dispatchEvent(new CustomEvent("tandem:addressed-ai", { detail: { via: "chat" } }));
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
  try {
    await fetch(`http://127.0.0.1:${DEFAULT_MCP_PORT}${API_CHAT}`, { method: "DELETE" });
  } catch (err) {
    console.warn("[ChatPanel] Failed to clear chat:", err);
  }
}
</script>

<div
  data-testid="chat-panel"
  style="width: 100%; display: flex; flex-direction: column; background: var(--tandem-surface-muted); flex: 1; min-height: 0;"
>
  <!-- Header -->
  <div
    style="padding: var(--tandem-space-3) var(--tandem-space-4); border-bottom: 1px solid var(--tandem-border); font-weight: 600; font-size: var(--tandem-text-md); display: flex; justify-content: space-between; align-items: center;"
  >
    Chat
    <div style="display: flex; align-items: center; gap: var(--tandem-space-2);">
      {#if unreadCount > 0}
        <span
          style="background: var(--tandem-accent); color: var(--tandem-accent-fg); border-radius: var(--tandem-r-pill); padding: 2px 8px; font-size: var(--tandem-text-xs);"
        >
          {unreadCount}
        </span>
      {/if}
      {#if messages.length > 0}
        <button
          onclick={clearChat}
          title="Clear chat history"
          data-testid="clear-chat-btn"
          style="background: none; border: none; cursor: pointer; color: var(--tandem-fg-subtle); font-size: 13px; padding: 2px 4px; line-height: 1;"
        >
          Clear
        </button>
      {/if}
    </div>
  </div>

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
    {#each messages as msg (msg.id)}
      <div
        style="margin-bottom: var(--tandem-space-3); padding: var(--tandem-space-2) var(--tandem-space-3); border-radius: var(--tandem-r-4); background: {msg.author ===
        'user'
          ? 'var(--tandem-accent-bg)'
          : 'var(--tandem-surface)'}; border: 1px solid {msg.author === 'user'
          ? 'var(--tandem-accent-border)'
          : 'var(--tandem-border)'}; font-size: var(--tandem-text-base); color: var(--tandem-fg); box-shadow: var(--tandem-shadow-1);"
      >
        <!-- Author + doc badge -->
        <div style="display: flex; gap: 6px; align-items: center; margin-bottom: 4px;">
          <!-- #1123 M4: a local-model chat author gets its per-agent color; a
               real-Claude / dark message (no agentIdentity) keeps the accent
               token unchanged, so this is byte-identical while dark. -->
          <span
            data-testid="chat-author-{msg.id}"
            style="font-weight: 600; font-size: 11px; color: {msg.author === 'claude'
              ? (msg.agentIdentity ? agentColor(msg.agentIdentity) : 'var(--tandem-accent)')
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
    color: var(--tandem-fg);
    resize: none;
    outline: none;
    min-height: 36px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
    transition: border-color 120ms ease, box-shadow 120ms ease;
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
