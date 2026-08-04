<script lang="ts">
import { onMount } from "svelte";

import { API_CODEX_APPROVAL_DECISION, API_CODEX_APPROVALS } from "../../shared/api-paths.js";
import { API_BASE } from "../utils/fileUpload.js";

interface Approval {
  id: string;
  kind: "command" | "file-change";
  title: string;
  command?: string;
  cwd?: string;
  reason?: string;
  allowForSession: boolean;
}

let approvals: Approval[] = $state([]);
let busy = $state(false);
let error = $state<string | null>(null);
let declineButton = $state<HTMLButtonElement>();
const current = $derived(approvals[0]);

$effect(() => {
  if (!current?.id) return;
  queueMicrotask(() => declineButton?.focus());
});

async function refresh(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}${API_CODEX_APPROVALS}`);
    if (!response.ok) return;
    const body = (await response.json()) as { approvals?: Approval[] };
    approvals = Array.isArray(body.approvals) ? body.approvals : [];
  } catch {
    // The sidecar may be starting or stopping. Polling retries without turning
    // a transient lifecycle edge into a persistent user-facing error.
  }
}

async function decide(decision: "accept" | "acceptForSession" | "decline"): Promise<void> {
  if (!current || busy) return;
  busy = true;
  error = null;
  try {
    const response = await fetch(`${API_BASE}${API_CODEX_APPROVAL_DECISION}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: current.id, decision }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(body?.message ?? `HTTP ${response.status}`);
    }
    await refresh();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to send approval decision";
  } finally {
    busy = false;
  }
}

function handleDialogKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || busy) return;
  event.preventDefault();
  void decide("decline");
}

onMount(() => {
  void refresh();
  const timer = window.setInterval(() => void refresh(), 750);
  return () => window.clearInterval(timer);
});
</script>

{#if current}
  <div class="approval-backdrop" aria-hidden="true"></div>
  <div
    class="approval-dialog"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="codex-approval-title"
    aria-describedby="codex-approval-description"
    data-testid="codex-approval-dialog"
    tabindex="-1"
    onkeydown={handleDialogKeydown}
  >
    <div class="provider">Codex approval</div>
    <h2 id="codex-approval-title">{current.title}</h2>
    <p id="codex-approval-description">
      Review this request before Codex continues. Tandem will decline it automatically if it
      expires.
    </p>

    {#if current.command}
      <pre><code>{current.command}</code></pre>
    {/if}
    {#if current.cwd}
      <dl><dt>Working directory</dt><dd>{current.cwd}</dd></dl>
    {/if}
    {#if current.reason}
      <dl><dt>Reason</dt><dd>{current.reason}</dd></dl>
    {/if}
    {#if approvals.length > 1}
      <p class="queue">{approvals.length - 1} more request{approvals.length === 2 ? "" : "s"} waiting</p>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}

    <div class="actions">
      <button bind:this={declineButton} type="button" class="secondary" disabled={busy} onclick={() => void decide("decline")}>Decline</button>
      {#if current.allowForSession}
        <button type="button" class="secondary" disabled={busy} onclick={() => void decide("acceptForSession")}>Allow for session</button>
      {/if}
      <button type="button" class="primary" disabled={busy} onclick={() => void decide("accept")}>Allow once</button>
    </div>
  </div>
{/if}

<style>
  .approval-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--tandem-z-modal, 1000);
    background: color-mix(in srgb, var(--tandem-bg) 64%, transparent);
  }

  .approval-dialog {
    position: fixed;
    z-index: calc(var(--tandem-z-modal, 1000) + 1);
    left: 50%;
    top: 50%;
    width: min(34rem, calc(100vw - 2rem));
    max-height: calc(100vh - 2rem);
    overflow: auto;
    transform: translate(-50%, -50%);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-3);
    padding: 1.25rem;
    background: var(--tandem-surface);
    color: var(--tandem-fg);
    box-shadow: var(--tandem-shadow-4);
  }

  .provider { color: var(--tandem-fg-muted); font-size: 0.8rem; font-weight: 650; }
  h2 { margin: 0.35rem 0 0.5rem; font-size: 1.2rem; }
  p { margin: 0.4rem 0 0.9rem; line-height: 1.45; }
  pre { max-height: 14rem; overflow: auto; padding: 0.75rem; border-radius: var(--tandem-r-1); background: var(--tandem-bg); white-space: pre-wrap; overflow-wrap: anywhere; }
  dl { display: grid; grid-template-columns: 8rem 1fr; gap: 0.5rem; margin: 0.65rem 0; font-size: 0.9rem; }
  dt { color: var(--tandem-fg-muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .queue { color: var(--tandem-fg-muted); font-size: 0.85rem; }
  .error { color: var(--tandem-error); }
  .actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; flex-wrap: wrap; }
  button { border-radius: var(--tandem-r-1); padding: 0.55rem 0.8rem; font: inherit; cursor: pointer; }
  button:disabled { opacity: 0.55; cursor: default; }
  .secondary { border: 1px solid var(--tandem-border); background: transparent; color: inherit; }
  .primary { border: 1px solid transparent; background: var(--tandem-accent-border); color: white; }
</style>
