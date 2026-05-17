<script lang="ts">
import { isTauriRuntime } from "../cowork/cowork-helpers.js";
import { createAppInfo } from "../hooks/useAppInfo.svelte.js";
import type { SidecarRetryStrategy } from "../hooks/useTandemSettings.svelte.js";
import type { SettingsTabContext } from "./SettingsModal.svelte";

type Props = SettingsTabContext;

const { open, settings, onUpdate, connected, reconnectAttempts }: Props = $props();

const appInfo = createAppInfo(() => open);
const isTauri = isTauriRuntime();

let restartError = $state<string | null>(null);
let restarting = $state(false);

async function handleRestartSidecar(): Promise<void> {
  if (!isTauri) return;
  restarting = true;
  restartError = null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("restart_sidecar");
  } catch (e) {
    restartError = e instanceof Error ? e.message : String(e);
  } finally {
    restarting = false;
  }
}

const RETRY_OPTIONS: Array<{ value: SidecarRetryStrategy; label: string }> = [
  { value: "exponential", label: "Exponential backoff" },
  { value: "constant-2s", label: "Constant (2s)" },
  { value: "manual", label: "Manual only" },
];

const labelStyle =
  "font-size: 11px; font-weight: 600; color: var(--tandem-fg); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;";
const rowStyle =
  "display: flex; align-items: center; gap: var(--tandem-space-2); cursor: pointer; font-size: 12px; color: var(--tandem-fg); min-height: 24px;";
const subtextStyle =
  "font-size: 10px; color: var(--tandem-fg-subtle); margin-top: var(--tandem-space-1);";

const transport = $derived(appInfo.info?.transport);
const bindHost = $derived(appInfo.info?.bindHost);
const bindPort = $derived(appInfo.info?.bindPort);
const isHttp = $derived(transport === "http");
const tokenRotatedAt = $derived(appInfo.info?.tokenRotatedAt);
</script>

<!-- Connection Status -->
<div>
  <div style={labelStyle}>Connection Status</div>
  <div
    style="display: flex; align-items: center; gap: var(--tandem-space-2); padding: var(--tandem-space-2) var(--tandem-space-3); border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-3); background: var(--tandem-surface);"
  >
    <span
      style="width: 8px; height: 8px; border-radius: var(--tandem-r-circle); background: {connected
        ? 'var(--tandem-success)'
        : 'var(--tandem-error)'}; flex-shrink: 0;"
      aria-hidden="true"
    ></span>
    <span style="font-size: 12px; color: var(--tandem-fg); flex: 1;">
      {connected ? "Connected to Tandem server" : "Disconnected"}
      {#if reconnectAttempts > 0}
        <span style="color: var(--tandem-fg-subtle);">· {reconnectAttempts} retry attempt{reconnectAttempts === 1 ? "" : "s"}</span>
      {/if}
    </span>
    {#if isTauri}
      <button
        type="button"
        data-testid="network-restart-sidecar"
        disabled={restarting}
        onclick={handleRestartSidecar}
        style="padding: 2px var(--tandem-space-2); font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg-muted); cursor: pointer; opacity: {restarting
          ? 0.5
          : 1};"
      >
        {restarting ? "Restarting…" : "Restart sidecar"}
      </button>
    {:else}
      <span style="font-size: 10px; color: var(--tandem-fg-subtle);">Run <code>tandem stop &amp;&amp; tandem start</code> to restart</span>
    {/if}
  </div>
  {#if restartError}
    <div style="font-size: 10px; color: var(--tandem-error-fg); margin-top: var(--tandem-space-1);">
      {restartError}
    </div>
  {/if}
</div>

<!-- Sidecar Transport -->
<div>
  <div style={labelStyle}>Transport</div>
  <div
    style="display: flex; gap: var(--tandem-space-4); padding: var(--tandem-space-2) var(--tandem-space-3); border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-3); background: var(--tandem-surface); font-size: 12px; color: var(--tandem-fg);"
  >
    <span><strong>Mode:</strong> {transport ? transport.toUpperCase() : "—"}</span>
    {#if bindHost}
      <span><strong>Host:</strong> {bindHost}</span>
    {/if}
  </div>
</div>

<!-- Loopback Port (HTTP only, read-only — port changes require CLI/server restart) -->
{#if isHttp}
  <div>
    <div style={labelStyle}>Loopback Port</div>
    <div
      style="padding: var(--tandem-space-2) var(--tandem-space-3); border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-3); background: var(--tandem-surface-muted); font-size: 13px; color: var(--tandem-fg-subtle); display: inline-block;"
    >
      {bindPort ?? "—"}
    </div>
    <div style={subtextStyle}>Port used when transport is HTTP. To change, run <code>tandem start --port &lt;N&gt;</code>.</div>
  </div>
{/if}

<!-- Degraded Banner Delay -->
<div>
  <div style={labelStyle}>
    Show degraded banner after:
    <span style="font-weight: 400; text-transform: none;">
      {settings.degradedBannerDelayMs / 1000}s
    </span>
  </div>
  <input
    data-testid="network-degraded-delay-slider"
    type="range"
    min="5000"
    max="120000"
    step="5000"
    value={settings.degradedBannerDelayMs}
    oninput={(e) =>
      onUpdate({ degradedBannerDelayMs: Number((e.target as HTMLInputElement).value) })}
    style="width: 100%; accent-color: var(--tandem-accent);"
    aria-label="Degraded banner delay"
  />
  <div
    style="display: flex; justify-content: space-between; font-size: 10px; color: var(--tandem-fg-subtle);"
  >
    <span>5s</span>
    <span>120s</span>
  </div>
</div>

<!-- Retry Strategy — TODO(v0.11.0): wire to yjsSync reconnect strategy -->
<div>
  <div style={labelStyle}>Reconnect Strategy <span style="font-size: 10px; color: var(--tandem-fg-subtle);">(not yet active)</span></div>
  <select
    data-testid="network-retry-strategy"
    value={settings.sidecarRetryStrategy}
    onchange={(e) =>
      onUpdate({ sidecarRetryStrategy: (e.target as HTMLSelectElement).value as SidecarRetryStrategy })}
    style="width: 100%; padding: 6px 8px; font-size: 13px; color: var(--tandem-fg); background: var(--tandem-surface); border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); cursor: pointer;"
    aria-label="Reconnect retry strategy"
  >
    {#each RETRY_OPTIONS as opt (opt.value)}
      <option value={opt.value}>{opt.label}</option>
    {/each}
  </select>
</div>

<!-- Hold Annotations While Offline — TODO(v0.11.0): wire to annotation queuing in useModeGate -->
<label style={rowStyle}>
  <input
    type="checkbox"
    data-testid="network-hold-annotations-toggle"
    checked={settings.holdAnnotationsWhileOffline}
    onchange={(e) =>
      onUpdate({ holdAnnotationsWhileOffline: (e.target as HTMLInputElement).checked })}
    style="accent-color: var(--tandem-accent);"
  />
  <span>Hold annotations while offline <span style="font-size: 10px; color: var(--tandem-fg-subtle);">(not yet active)</span></span>
</label>
<div style={subtextStyle}>
  When enabled, annotation events will queue locally and sync when the connection is restored.
</div>

<!-- Token Rotation -->
{#if tokenRotatedAt !== undefined}
  <div>
    <div style={labelStyle}>Token Rotation</div>
    <div style="font-size: 12px; color: var(--tandem-fg);">
      {tokenRotatedAt === null
        ? "Auth token not yet created"
        : `Last rotated: ${new Date(tokenRotatedAt).toLocaleString()}`}
    </div>
    <div style={subtextStyle}>To rotate: run <code>tandem rotate-token</code> in the CLI.</div>
  </div>
{/if}
