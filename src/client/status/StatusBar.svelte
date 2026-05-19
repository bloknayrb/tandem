<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import { untrack } from "svelte";
import { USER_NAME_MAX_LEN } from "../../shared/constants";
import { createUserName } from "../hooks/useUserName.svelte";
import type { ConnectionStatus } from "../hooks/yjsSync.svelte";
import { getCount, loadMode, modeLabel, nextMode, saveMode } from "./word-count-cycle";

interface Props {
  connected: boolean;
  connectionStatus: ConnectionStatus;
  reconnectAttempts: number;
  disconnectedSince: number | null;
  claudeStatus: string | null;
  claudeActive: boolean;
  readOnly?: boolean;
  documentCount?: number;
  saving?: boolean;
  heldCount?: number;
  mode?: import("../../shared/types").TandemMode;
  onShowHeld?: () => void;
  /** Editor for the active document — drives the word-count cycle. */
  editor?: TiptapEditor | null;
}

let {
  connected,
  connectionStatus,
  reconnectAttempts,
  disconnectedSince,
  claudeStatus,
  claudeActive,
  readOnly,
  documentCount = 0,
  saving = false,
  heldCount,
  mode,
  onShowHeld,
  editor,
}: Props = $props();

const RECONNECTED_FLASH_MS = 2_000;

const userNameState = createUserName();
let nameInput = $state(userNameState.userName);
let inputEl: HTMLInputElement | undefined = $state();

// Idle-sync: sync only when NOT focused and value differs
$effect(() => {
  const currentUserName = userNameState.userName;
  if (nameInput !== currentUserName && document.activeElement !== inputEl) {
    nameInput = currentUserName;
  }
});

let showReconnectedFlash = $state(false);
let elapsedSeconds = $state(0);
// intentional snapshot — updated inside $effect to detect rising-edge reconnect
let prevConnected = untrack(() => connected);

$effect(() => {
  const was = prevConnected;
  prevConnected = connected;
  if (connected && !was) {
    showReconnectedFlash = true;
    const timer = setTimeout(() => {
      showReconnectedFlash = false;
    }, RECONNECTED_FLASH_MS);
    return () => clearTimeout(timer);
  }
});

// Tick elapsed time while disconnected
$effect(() => {
  if (disconnectedSince == null) {
    elapsedSeconds = 0;
    return;
  }
  elapsedSeconds = Math.floor((Date.now() - disconnectedSince) / 1000);
  const interval = setInterval(() => {
    elapsedSeconds = Math.floor((Date.now() - (disconnectedSince ?? 0)) / 1000);
  }, 1000);
  return () => clearInterval(interval);
});

const isReconnecting = $derived(connectionStatus === "connecting");
const dotColor = $derived(
  connected
    ? "var(--tandem-success)"
    : isReconnecting
      ? "var(--tandem-warning)"
      : "var(--tandem-error)",
);

const connLabel = $derived(
  showReconnectedFlash
    ? "Reconnected"
    : connectionStatus === "connected"
      ? "Connected"
      : connectionStatus === "connecting"
        ? (() => {
            const parts = ["Reconnecting…"];
            if (reconnectAttempts > 0 || elapsedSeconds > 0) {
              const details: string[] = [];
              if (reconnectAttempts > 0) details.push(`attempt ${reconnectAttempts}`);
              if (elapsedSeconds > 0) details.push(`${elapsedSeconds}s`);
              parts.push(`(${details.join(", ")})`);
            }
            return parts.join(" ");
          })()
        : "Disconnected — check that the server is running",
);

const showHeld = $derived((heldCount ?? 0) > 0 && mode === "solo");

function commitName() {
  userNameState.setUserName(nameInput);
}

// Word-count cycle (W5). Mode persists in localStorage. The chip click
// advances the cycle; count is derived live from editor doc state via
// the per-update tick handler so the chip stays accurate as the user types.
let wordMode = $state(loadMode());
let editorTick = $state(0);
$effect(() => {
  const ed = editor;
  if (!ed || ed.isDestroyed) return;
  const handler = () => {
    if (!ed.isDestroyed) editorTick++;
  };
  ed.on("update", handler);
  ed.on("transaction", handler);
  return () => {
    ed.off("update", handler);
    ed.off("transaction", handler);
  };
});
const wordCount = $derived.by(() => {
  void editorTick;
  return getCount(editor ?? null, wordMode);
});
function cycleWordMode() {
  const next = nextMode(wordMode);
  wordMode = next;
  saveMode(next);
}
</script>

<!-- v7 floating chrome (Wave 5): the in-flow status bar lifts into a small
     floating pill anchored bottom-left, applying the shared
     .tandem-floating-pill recipe. The pill keeps every field the in-flow
     bar carried (display name, connection, count, saving, held badge,
     Review-Only, Claude state) plus a new word-count chip that cycles
     through words / chars / sentences / paragraphs on click. -->
<!-- Status pill is faint until hover/focus-within. Pure-CSS opacity
     transition; `:focus-within` reveals on keyboard focus so the
     display-name input + word-count button remain reachable. -->
<div
  class="tandem-floating-pill tandem-status-pill"
  style="position: fixed; bottom: var(--tandem-space-3, 12px); left: var(--tandem-space-5, 22px); max-width: calc(100% - var(--tandem-space-7, 44px)); display: inline-flex; align-items: center; padding: 4px var(--tandem-space-3); height: var(--tandem-h-statusbar, 28px); font-family: var(--tandem-font-mono); font-size: var(--tandem-text-xs); color: var(--tandem-fg-muted); user-select: none; gap: var(--tandem-space-3); z-index: var(--tandem-z-sticky); overflow: hidden;"
>
  <div style="display: flex; align-items: center; gap: var(--tandem-space-2);">
    <span
      class="status-dot"
      style="width: 8px; height: 8px; border-radius: 50%; background: {dotColor}; display: inline-block; animation: {isReconnecting ? 'tandem-reconnect-pulse 1.2s ease-in-out infinite' : 'none'};"
    ></span>
    <span>{connLabel}</span>
    {#if documentCount > 0}
      <span style="color: var(--tandem-fg-subtle);">
        {documentCount} doc{documentCount !== 1 ? "s" : ""} open
      </span>
    {/if}
    {#if editor}
      <button
        type="button"
        data-testid="status-word-count"
        onclick={cycleWordMode}
        title={`Click to cycle: ${modeLabel(nextMode(wordMode))}`}
        aria-label={`${wordCount} ${modeLabel(wordMode)} (click to change unit)`}
        style="background: none; border: none; padding: 0; margin: 0; cursor: pointer; color: var(--tandem-fg-subtle); font: inherit; font-family: var(--tandem-font-mono);"
      >
        {wordCount.toLocaleString()} {modeLabel(wordMode)}
      </button>
    {/if}
    {#if saving}
      <span
        data-testid="save-indicator"
        style="color: var(--tandem-accent);"
      >
        Saving...
      </span>
    {/if}
  </div>

  <div style="display: flex; align-items: center; gap: var(--tandem-space-1); font-size: var(--tandem-text-xs); color: var(--tandem-fg-subtle);">
    <span>You:</span>
    <input
      bind:this={inputEl}
      data-testid="user-name-input"
      type="text"
      value={nameInput}
      oninput={(e) => { nameInput = (e.target as HTMLInputElement).value; }}
      onblur={commitName}
      onkeydown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        if (e.key === "Escape") {
          nameInput = userNameState.userName;
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      aria-label="Display name"
      title="Your display name"
      maxlength={USER_NAME_MAX_LEN}
      style="background: transparent; border: none; border-bottom: 1px dashed transparent; color: var(--tandem-fg-muted); font: inherit; font-family: var(--tandem-font-sans); font-size: var(--tandem-text-xs); width: 80px; outline: none; padding: 0 2px;"
    />
  </div>

  {#if showHeld}
    <button
      class="sb-held"
      data-testid="sb-held"
      onclick={onShowHeld}
      title="Show held annotations — switches to Tandem"
    >
      <span class="held-dot"></span>
      <strong>{heldCount}</strong> held
    </button>
  {/if}

  {#if readOnly}
    <span
      style="padding: 1px 8px; font-size: var(--tandem-text-2xs); font-weight: 600; color: var(--tandem-warning-fg-strong); background: var(--tandem-warning-bg); border-radius: var(--tandem-r-pill); border: 1px solid var(--tandem-warning-border);"
    >
      Review Only
    </span>
  {/if}

  <div style="display: flex; align-items: center; gap: var(--tandem-space-2);">
    <span
      class="claude-dot"
      style="width: 8px; height: 8px; border-radius: 50%; background: var(--tandem-author-claude); opacity: {claudeActive ? 1 : 0.4}; display: inline-block; transition: opacity 0.3s ease; animation: {claudeActive ? 'tandem-status-pulse 1.5s ease-in-out infinite' : 'none'};"
    ></span>
    <span style="transition: color 0.3s ease; color: {claudeActive ? 'var(--tandem-fg)' : 'var(--tandem-fg-subtle)'};">
      {claudeStatus ? `Claude · ${claudeStatus}` : "Claude · idle"}
    </span>
  </div>
</div>

<style>
  :global {
    @keyframes tandem-status-pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
    @keyframes tandem-reconnect-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  }

  /* Faint until hover/focus-within. */
  .tandem-status-pill {
    opacity: 0.4;
    transition: opacity 180ms ease;
  }
  .tandem-status-pill:hover,
  .tandem-status-pill:focus-within {
    opacity: 1;
  }

  /* Solo-mode held-count badge. Lives next to the user-name input in the
     status bar so the held queue stays visible when the rail is hidden
     (see HANDOFF.v1.md item 6). SidePanel keeps its own banner for the
     rail-visible case. */
  .sb-held {
    display: inline-flex;
    align-items: center;
    gap: var(--tandem-space-1);
    height: 18px;
    padding: 0 8px;
    border: 1px solid var(--tandem-warning-border);
    border-radius: var(--tandem-r-pill);
    background: var(--tandem-warning-bg);
    color: var(--tandem-warning-fg-strong);
    font-size: var(--tandem-text-xs);
    font-family: inherit;
    cursor: pointer;
    transition: filter 0.15s ease;
  }
  .sb-held strong { font-weight: 600; }
  .sb-held:hover { filter: brightness(1.04); }
  .sb-held:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 1px;
  }
  .sb-held .held-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--tandem-warning-fg-strong);
    display: inline-block;
  }

  @media (forced-colors: active) {
    .status-dot,
    .claude-dot {
      outline: 1px solid ButtonText;
      outline-offset: 1px;
    }
    .sb-held .held-dot {
      outline: 1px solid ButtonText;
      outline-offset: 1px;
    }
  }
</style>
