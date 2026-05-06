<script lang="ts">
import { untrack } from "svelte";
import { USER_NAME_MAX_LEN } from "../../shared/constants";
import { createUserName } from "../hooks/useUserName.svelte";
import type { ConnectionStatus } from "../hooks/yjsSync.svelte";

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

function commitName() {
  userNameState.setUserName(nameInput);
}
</script>

<div
  style="display: flex; align-items: center; justify-content: space-between; padding: 0 var(--tandem-space-4); height: 28px; border-top: 1px solid var(--tandem-border); background: var(--tandem-surface-muted); font-family: var(--tandem-font-mono); font-size: var(--tandem-text-xs); color: var(--tandem-fg-muted); user-select: none; gap: var(--tandem-space-3);"
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

  {#if (heldCount ?? 0) > 0 && mode === "solo"}
    <button
      data-testid="sb-held"
      onclick={onShowHeld}
      title="Show held annotations — switches to Tandem"
      style="display: inline-flex; align-items: center; gap: var(--tandem-space-1); padding: 1px 8px; font-size: var(--tandem-text-xs); font-weight: 600; border: 1px solid var(--tandem-warning-border); border-radius: var(--tandem-r-pill); background: var(--tandem-warning-bg); color: var(--tandem-warning-fg-strong); cursor: pointer;"
    >
      <span style="width: 6px; height: 6px; border-radius: 50%; background: var(--tandem-warning-fg-strong); display: inline-block;"></span>
      {heldCount} held
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

  @media (forced-colors: active) {
    :global(.status-dot),
    :global(.claude-dot) {
      outline: 1px solid ButtonText;
      outline-offset: 1px;
    }
  }
</style>
