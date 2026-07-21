<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import { untrack } from "svelte";
import { createAgentLabel } from "../hooks/useAgentLabel.svelte";
import { createTandemSettings } from "../hooks/useTandemSettings.svelte";
import type { ConnectionStatus } from "../hooks/yjsSync.svelte";
import { createCoalescingTick } from "../utils/coalescing-tick";
import { getCount, loadMode, modeLabel, nextMode, saveMode } from "./word-count-cycle";

interface Props {
  connected: boolean;
  connectionStatus: ConnectionStatus;
  reconnectAttempts: number;
  disconnectedSince: number | null;
  claudeStatus: string | null;
  claudeActive: boolean;
  /**
   * #651: name of the MCP tool Claude is currently executing on the active
   * document, or null when idle. Surfaces a generic "Claude is editing…"
   * indicator next to the Claude status pill for tools without an annotation
   * target (tandem_comment, tandem_edit, tandem_reply); annotation-targeted
   * tools render the indicator on the corresponding AnnotationCard instead.
   */
  claudeWorkingTool?: string | null;
  readOnly?: boolean;
  saving?: boolean;
  /** Whether the most recently completed save succeeded — gates the "Saved" flash. */
  lastSaveOk?: boolean;
  /** Editor for the active document — drives the word-count cycle. */
  editor?: TiptapEditor | null;
  /**
   * WS-A2: number of annotations/replies currently held from the AI because
   * the user is in Solo mode. Derived by the caller from the persisted
   * `heldInSolo` field (NEVER from live mode) so the signal survives a
   * server restart and matches the per-card "Held" pill. Zero → not rendered.
   * This is the umbrella signal for held items whose surface has no card
   * (a reply with no card of its own, items created before a doc switch).
   */
  heldCount?: number;
}

let {
  connected,
  connectionStatus,
  reconnectAttempts,
  disconnectedSince,
  claudeStatus,
  claudeActive,
  claudeWorkingTool = null,
  readOnly,
  saving = false,
  lastSaveOk = false,
  editor,
  heldCount = 0,
}: Props = $props();

/**
 * Map MCP tool name → short, user-facing verb phrase. Falls back to the raw
 * tool name (stripped of the `tandem_` prefix) for unknown tools so future
 * additions still render something sensible without a code change here.
 */
function claudeWorkingLabel(tool: string): string {
  const labels: Record<string, string> = {
    tandem_edit: "editing",
    tandem_comment: "commenting",
    tandem_reply: "replying",
    tandem_annotationReply: "replying",
  };
  return labels[tool] ?? tool.replace(/^tandem_/, "");
}

const RECONNECTED_FLASH_MS = 2_000;

// #438: the status pill is the one surface that shows the specific model name.
const agentLabel = createAgentLabel(createTandemSettings());

const SAVED_FLASH_MS = 4_000;

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

// Saved flash: falling-edge detector (was saving, now isn't) shows a brief
// "Saved HH:MM" confirmation where the "Saving…" indicator was. Mirrors
// showReconnectedFlash's snapshot/effect/timer structure but inverted.
let savedLabel = $state<string | null>(null);
// intentional snapshot — updated inside $effect to detect falling-edge save completion
let prevSaving = untrack(() => saving);

$effect(() => {
  const was = prevSaving;
  prevSaving = saving;
  if (was && !saving && lastSaveOk) {
    savedLabel = `Saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    const timer = setTimeout(() => {
      savedLabel = null;
    }, SAVED_FLASH_MS);
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
      ? "Synced"
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

// Color the connection label to match the dot state (design A4 status pill):
// amber while reconnecting, red when disconnected, a brief green on the
// reconnected flash, muted otherwise.
const labelColor = $derived(
  showReconnectedFlash
    ? "var(--tandem-success-fg-strong)"
    : connectionStatus === "connected"
      ? "var(--tandem-fg-muted)"
      : connectionStatus === "connecting"
        ? "var(--tandem-warning-fg-strong)"
        : "var(--tandem-error-fg-strong)",
);

// Word-count cycle (W5). Mode persists in localStorage. The chip click
// advances the cycle; count is derived live from editor doc state via
// the per-update tick handler so the chip stays accurate as the user types.
let wordMode = $state(loadMode());
let editorTick = $state(0);
$effect(() => {
  const ed = editor;
  if (!ed || ed.isDestroyed) return;
  // Deferred, not direct: Tiptap fires these synchronously from ProseMirror's
  // dispatch, which can re-enter while Svelte is mid-render — a native blur
  // during teardown reaches us straight from `EditorView.dispatch`. Writing
  // $state there throws state_unsafe_mutation (in prod too). See
  // createCoalescingTick.
  const handler = createCoalescingTick(() => {
    if (!ed.isDestroyed) editorTick++;
  });
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
     bar carried (connection, count, saving, held badge, Review-Only, Claude
     state) plus a word-count chip that cycles through words / chars /
     sentences / paragraphs on click. The display-name editor lives in
     Settings → Collaboration (`settings-modal-display-name`), not here — the
     duplicate inline editor was removed in the design-fidelity pass. -->
<!-- Status pill is faint until hover/focus-within. Pure-CSS opacity
     transition; `:focus-within` reveals on keyboard focus so the word-count
     button remains reachable. -->
<div
  class="tandem-floating-pill tandem-status-pill"
  style="position: fixed; bottom: var(--tandem-space-3, 12px); left: var(--tandem-space-5, 22px); max-width: calc(100% - var(--tandem-space-7, 44px)); display: inline-flex; align-items: center; padding: 6px var(--tandem-space-3); font-family: var(--tandem-font-mono); font-size: var(--tandem-text-xs); color: var(--tandem-fg-muted); user-select: none; gap: var(--tandem-space-3); z-index: var(--tandem-z-sticky); overflow: hidden;"
>
  <div style="display: flex; align-items: center; gap: var(--tandem-space-2);">
    <span
      class="status-dot"
      style="width: 7px; height: 7px; border-radius: 50%; background: {dotColor}; display: inline-block; animation: {connected && showReconnectedFlash ? 'tandem-conn-bloom 500ms var(--tandem-ease-out)' : isReconnecting ? 'tandem-conn-pulse 900ms ease-in-out infinite' : 'none'};"
    ></span>
    <span style="color: {labelColor}; transition: color 0.3s ease;">{connLabel}</span>
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
    {:else if savedLabel}
      <span
        data-testid="saved-indicator"
        style="color: var(--tandem-success-fg-strong);"
      >
        {savedLabel}
      </span>
    {/if}
  </div>

  {#if readOnly}
    <span class="status-warning-pill">
      Review Only
    </span>
  {/if}

  {#if heldCount > 0}
    <!-- WS-A2: umbrella held signal. Amber like the per-card "Held" pill
         (--tandem-warning-*). Covers held items with no card of their own
         (replies, pre-doc-switch items). Count comes from the persisted
         `heldInSolo` field, not live mode. -->
    <span
      class="status-warning-pill"
      data-testid="status-held-count"
      style="white-space: nowrap;"
      title="Held while you're in Solo mode. Your AI will see {heldCount === 1 ? 'this' : 'these'} when you switch back to Tandem."
    >
      {heldCount} held
    </span>
  {/if}

  <div style="display: flex; align-items: center; gap: var(--tandem-space-2);">
    <span
      class="claude-dot"
      style="width: 7px; height: 7px; border-radius: 50%; background: var(--tandem-author-claude); opacity: {claudeActive ? 1 : 0.4}; display: inline-block; transition: opacity 0.3s ease; animation: {claudeActive ? 'tandem-status-pulse 1.5s ease-in-out infinite' : 'none'};"
    ></span>
    <span style="transition: color 0.3s ease; color: {claudeActive ? 'var(--tandem-fg)' : 'var(--tandem-fg-subtle)'};">
      {claudeStatus ? `${agentLabel.specific} · ${claudeStatus}` : `${agentLabel.specific} · idle`}
    </span>
    {#if claudeWorkingTool}
      <!--
        #651: generic "Claude is {verb}…" indicator. Only renders for the
        active document and only while a tool is in flight; per-card
        indicators on AnnotationCard.svelte cover annotation-targeted tools.
      -->
      <span
        data-testid="claude-working-indicator"
        class="claude-working-pill"
        role="status"
        aria-live="polite"
      >
        <span class="claude-working-dot"></span>
        <span class="claude-working-dot"></span>
        <span class="claude-working-dot"></span>
        <span style="margin-left: 4px;">{agentLabel.specific} is {claudeWorkingLabel(claudeWorkingTool)}…</span>
      </span>
    {/if}
  </div>
</div>

<style>
  /* Keyframes must live in :global — the connection/claude dots reference them
     from an inline `style` `animation`, which Svelte does NOT name-rewrite, so a
     scoped @keyframes would be hashed and silently never match. */
  :global {
    @keyframes tandem-status-pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
    /* A9 (#798): connection state machine. Color comes from the dot's `dotColor`
       (amber while reconnecting → green once connected); these animate only
       opacity/scale so they stay IN-BOUNDS — the .tandem-status-pill clips
       overflow, so a radiating box-shadow ring/bloom would be cut off. */
    @keyframes tandem-conn-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.45; transform: scale(0.82); }
    }
    @keyframes tandem-conn-bloom {
      0% { transform: scale(1); opacity: 1; }
      35% { transform: scale(1.6); opacity: 1; }
      100% { transform: scale(1); opacity: 1; }
    }
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

  /* Shared amber warning-pill recipe — used by the "Review Only" and the WS-A2
     "N held" pills so a token/padding tweak lands in one place. */
  .status-warning-pill {
    padding: 1px 8px;
    font-size: var(--tandem-text-2xs);
    font-weight: 600;
    color: var(--tandem-warning-fg-strong);
    background: var(--tandem-warning-bg);
    border-radius: var(--tandem-r-pill);
    border: 1px solid var(--tandem-warning-border);
  }

  /* A9 (#798): reduced-motion guard for the connection + claude-presence dots
     (previously unguarded). `!important` is required to beat the inline `style`
     `animation`; the `body.tandem-reduce-motion` form MUST be `:global(...)`
     because the class lives on <body> (App.svelte) — a scoped rule would be
     hashed and the in-app toggle would silently fail. The dots stay visible
     (animation:none freezes them at the opaque keyframe); only motion is removed. */
  @media (prefers-reduced-motion: reduce) {
    .status-dot,
    .claude-dot {
      animation: none !important;
    }
  }
  :global(body.tandem-reduce-motion) .status-dot,
  :global(body.tandem-reduce-motion) .claude-dot {
    animation: none !important;
  }

  @media (forced-colors: active) {
    .status-dot,
    .claude-dot {
      outline: 1px solid ButtonText;
      outline-offset: 1px;
    }
  }

  /* #651 generic "Claude is …" typing-presence pill. Sits next to the
     Claude status text in the floating status pill. */
  .claude-working-pill {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px 8px;
    border-radius: var(--tandem-r-pill);
    background: var(--tandem-claude-focus-bg);
    color: var(--tandem-fg);
    font-size: var(--tandem-text-xs);
  }
  .claude-working-dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--tandem-author-claude);
    display: inline-block;
    animation: tandem-claude-working-pulse 1.2s ease-in-out infinite;
  }
  .claude-working-dot:nth-child(2) { animation-delay: 0.15s; }
  .claude-working-dot:nth-child(3) { animation-delay: 0.3s; }
  @keyframes tandem-claude-working-pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.85); }
    40% { opacity: 1; transform: scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .claude-working-dot {
      animation: none;
      opacity: 0.7;
    }
  }
  :global(body.tandem-reduce-motion) .claude-working-dot {
    animation: none;
    opacity: 0.7;
  }
  @media (forced-colors: active) {
    .claude-working-dot {
      outline: 1px solid ButtonText;
      outline-offset: 1px;
    }
  }
</style>
