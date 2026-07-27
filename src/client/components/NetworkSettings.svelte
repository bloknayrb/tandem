<script lang="ts">
import { isTauriRuntime } from "../cowork/cowork-helpers.js";
import { createAppInfo } from "../hooks/useAppInfo.svelte.js";
import { createAutostart } from "../hooks/useAutostart.svelte.js";
import type { SidecarRetryStrategy } from "../hooks/useTandemSettings.svelte.js";
import { disabledControlStyle } from "../utils/colors.js";
import CollapsibleSection from "./CollapsibleSection.svelte";
import type { SettingsTabContext } from "./SettingsModal.svelte";

type Props = SettingsTabContext;

const { open, settings, onUpdate, connected, reconnectAttempts, readOnly }: Props = $props();

const appInfo = createAppInfo(() => open);
const isTauri = isTauriRuntime();

// Start-at-login (#1236). Desktop-only: the npm CLI's `tandem start` is a
// foreground process with no OS registration to manage.
//
// State lives in the OS, not `tandem:settings` — see `createAutostart`. That is
// why nothing here touches `onUpdate` and why the schema version didn't move.
// Also deliberately NOT gated on `readOnly`: that flag exists because
// `onUpdate` no-ops against a forward-compat settings schema, which an OS login
// item has nothing to do with.
const autostart = createAutostart(() => open && isTauri);
const autostartStatus = $derived(autostart.status);
const autostartBlocked = $derived(autostartStatus !== null && !autostartStatus.trayAvailable);

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
];

const labelStyle =
  "font-size: 11px; font-weight: 600; color: var(--tandem-fg); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;";
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

<!-- Start at login (#1236) — desktop only. Top-level rather than inside
     Advanced: it changes what happens on every boot, which is not a
     rarely-touched knob. -->
{#if isTauri && autostartStatus !== null}
  <div>
    <div style={labelStyle}>Startup</div>
    <label
      style="display: flex; align-items: flex-start; gap: var(--tandem-space-2); padding: var(--tandem-space-2) var(--tandem-space-3); border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-3); background: var(--tandem-surface); cursor: {autostartBlocked ||
      autostart.loading
        ? 'not-allowed'
        : 'pointer'};"
    >
      <input
        type="checkbox"
        data-testid="network-autostart-toggle"
        checked={autostartStatus.enabled}
        disabled={autostartBlocked || autostart.loading}
        onchange={(e) => void autostart.toggle(e.currentTarget.checked)}
        style="margin-top: 2px; flex-shrink: 0;"
      />
      <span style="flex: 1;">
        <span style="font-size: 12px; color: var(--tandem-fg); display: block;">Start Tandem when my computer starts</span>
        <span style="{subtextStyle} display: block;">
          {#if autostartBlocked}
            Unavailable — Tandem couldn't create a tray icon on this system, so a hidden
            startup would leave no way to reach the app.
          {:else}
            Tandem starts minimized to the tray. Your AI assistant isn't launched until you
            open the window. The document server runs whenever Tandem is running.
          {/if}
        </span>
      </span>
    </label>
    {#if autostart.error}
      <div
        data-testid="network-autostart-error"
        style="font-size: 10px; color: var(--tandem-error-fg); margin-top: var(--tandem-space-1);"
      >
        {autostart.error}
      </div>
    {/if}
  </div>
{/if}

<!-- Advanced — collapsed by default. Holds the rarely-touched knobs: loopback
     port, banner delay, retry strategy, token rotation.
     Disclosure state is ephemeral by design (resets on each settings open).
     See PR 6 description for rationale. -->
<CollapsibleSection label="Advanced" testid="network-advanced">
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
      disabled={readOnly}
      oninput={(e) =>
        onUpdate({ degradedBannerDelayMs: Number((e.target as HTMLInputElement).value) })}
      style="width: 100%; accent-color: var(--tandem-accent); {disabledControlStyle(readOnly, 'auto')}"
      aria-label="Degraded banner delay"
    />
    <div
      style="display: flex; justify-content: space-between; font-size: 10px; color: var(--tandem-fg-subtle);"
    >
      <span>5s</span>
      <span>120s</span>
    </div>
  </div>

  <!-- Reconnect Strategy — controls the provider backoff curve (wired via yjsSync). -->
  <div>
    <div style={labelStyle}>Reconnect Strategy</div>
    <select
      data-testid="network-retry-strategy"
      value={settings.sidecarRetryStrategy}
      disabled={readOnly}
      onchange={(e) =>
        onUpdate({ sidecarRetryStrategy: (e.target as HTMLSelectElement).value as SidecarRetryStrategy })}
      style="width: 100%; padding: 6px 8px; font-size: 13px; color: var(--tandem-fg); background: var(--tandem-surface); border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); {disabledControlStyle(readOnly)}"
      aria-label="Reconnect retry strategy"
    >
      {#each RETRY_OPTIONS as opt (opt.value)}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>
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
</CollapsibleSection>
