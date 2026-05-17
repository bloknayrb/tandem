<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import * as Y from "yjs";
import { API_CHAT } from "../../shared/api-paths";
import { DEFAULT_MCP_PORT, Y_MAP_CHAT } from "../../shared/constants";
import type { FlatOffset } from "../../shared/positions/types";
import type { CapturedAnchor, ChatMessage } from "../../shared/types";
import { generateMessageId } from "../../shared/utils";
import { flatOffsetToPmPos } from "../positions";
import { renderMarkdown } from "./chat-markdown";

const TYPING_DOT_DELAYS = [0, 0.2, 0.4];

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
  const sb = scrollBehavior;

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
  const sb = scrollBehavior;
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

// Anchor expand state — keyed by message id
let expandedAnchors = $state(new Set<string>());

function toggleAnchorExpand(msgId: string) {
  const next = new Set(expandedAnchors);
  if (next.has(msgId)) next.delete(msgId);
  else next.add(msgId);
  expandedAnchors = next;
}
</script>

<div
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
  <div style="flex: 1; overflow: auto; padding: var(--tandem-space-3); min-height: 0;">
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
          <span
            style="font-weight: 600; font-size: 11px; color: {msg.author === 'claude'
              ? 'var(--tandem-accent)'
              : 'var(--tandem-fg-muted)'}; text-transform: uppercase;"
          >
            {msg.author}
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
            style="background: var(--tandem-accent-bg); border: none; border-left: 3px solid var(--tandem-accent-border); padding: 4px 8px; margin-bottom: 6px; font: inherit; color: var(--tandem-accent-fg-strong); cursor: pointer; text-align: left; width: 100%; font-size: var(--tandem-text-sm); border-radius: 0 var(--tandem-r-2) var(--tandem-r-2) 0; max-height: {expandedAnchors.has(
              msg.id,
            )
              ? '500px'
              : '60px'}; overflow: hidden; transition: max-height 0.3s ease;"
            title="Click to scroll to this text"
            onmouseenter={() => toggleAnchorExpand(msg.id)}
            onmouseleave={() => toggleAnchorExpand(msg.id)}
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

  <!-- Input area -->
  <div
    style="padding: var(--tandem-space-2) var(--tandem-space-3); border-top: 1px solid var(--tandem-border); display: flex; gap: var(--tandem-space-2);"
  >
    <textarea
      bind:this={internalInputEl}
      value={inputText}
      oninput={(e) => (inputText = (e.target as HTMLTextAreaElement).value)}
      onkeydown={handleKeyDown}
      placeholder="Message your AI..."
      rows={2}
      style="flex: 1; padding: var(--tandem-space-2); border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-3); font-size: var(--tandem-text-base); resize: none; outline: none; font-family: inherit; background: var(--tandem-surface); color: var(--tandem-fg);"
    ></textarea>
    <button
      onclick={sendMessage}
      disabled={!inputText.trim()}
      style="padding: var(--tandem-space-2) var(--tandem-space-3); background: {inputText.trim()
        ? 'var(--tandem-accent)'
        : 'var(--tandem-border-strong)'}; color: {inputText.trim()
        ? 'var(--tandem-accent-fg)'
        : 'var(--tandem-fg-subtle)'}; border: none; border-radius: var(--tandem-r-3); cursor: {inputText.trim()
        ? 'pointer'
        : 'default'}; font-size: var(--tandem-text-base); font-weight: 500; align-self: flex-end;"
    >
      Send
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
</style>
