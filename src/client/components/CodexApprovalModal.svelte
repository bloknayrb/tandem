<script lang="ts">
import { onMount } from "svelte";

import { API_CODEX_APPROVAL_DECISION, API_CODEX_APPROVALS } from "../../shared/api-paths.js";
import type { CodexApprovalView } from "../../shared/codex/approval.js";
import { API_INTEGRATIONS } from "../../shared/integrations/contract.js";
import { isLaunchablePrimary } from "../../shared/integrations/launchable-primary.js";
import { API_BASE } from "../utils/fileUpload.js";

let approvals: CodexApprovalView[] = $state([]);
let busy = $state(false);
let error = $state<string | null>(null);
let declineButton = $state<HTMLButtonElement>();
const current = $derived(approvals[0]);

/**
 * Whether a Codex integration is configured at all. Gates the poll — every
 * Claude-only user was otherwise hitting `/api/codex/approvals` every 750 ms
 * forever to be told "no".
 *
 * Deliberately derived from the integrations CONFIG, not from launcher status.
 * `provider` lives on the `running: true` variant of `LauncherStatus`, so a
 * status-derived gate goes false whenever the launcher is stopped or between
 * polls — and `POST /api/codex/approval/request` holds its socket for up to
 * 120 s treating a client disappearance as a decline. A not-running blip
 * mid-dialog would have vanished the dialog and auto-declined on the user's
 * behalf. Config presence has no such flicker.
 */
let codexConfigured = $state(false);

/**
 * Once a request is on screen the poll must not stop, whatever the config says.
 * Guards the case where the gate goes false underneath a live dialog (the user
 * removes the integration in Settings mid-approval) — the pending request still
 * needs an answer, and dropping the poll would let it time out into a decline
 * the user never made.
 */
const polling = $derived(codexConfigured || approvals.length > 0);

/**
 * Which approval we have already moved focus for. A plain `let`, not `$state` —
 * it is a snapshot the effect below both reads and writes, and making it
 * reactive would re-trigger the very effect that sets it.
 *
 * The guard is load-bearing, not defensive. `refresh()` assigns a freshly
 * parsed array every poll, so `current` (`$derived(approvals[0])`) is a NEW
 * OBJECT REFERENCE each time even when the same request is still pending —
 * `$derived` memoizes by identity, so the effect re-ran every 750 ms and
 * yanked focus back to Decline. A keyboard user could never reach "Allow
 * once", and selecting text out of the command preview or the file list was
 * impossible. Keying on the id makes the effect mean what it says: focus when
 * a DIFFERENT approval takes the front of the queue.
 */
let focusedApprovalId: string | null = null;

$effect(() => {
  const id = current?.id ?? null;
  if (id === null) {
    // Queue drained — the next request is a new one, so re-arm.
    focusedApprovalId = null;
    return;
  }
  if (id === focusedApprovalId) return;
  focusedApprovalId = id;
  queueMicrotask(() => declineButton?.focus());
});

async function refreshGate(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}${API_INTEGRATIONS}`);
    if (!response.ok) return;
    const body = (await response.json()) as {
      integrations?: { kind?: string; apply?: string }[];
    };
    codexConfigured = (body.integrations ?? []).some(
      (entry) => isLaunchablePrimary(entry) && entry.kind === "codex",
    );
  } catch {
    // Leave the gate as-is. A failed read is not evidence Codex was removed,
    // and flipping it false here would stop a poll that may have work to do.
  }
}

async function refresh(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}${API_CODEX_APPROVALS}`);
    if (!response.ok) return;
    const body = (await response.json()) as { approvals?: CodexApprovalView[] };
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

/** `+12 −3` style summary for one change row. */
function changeCounts(change: { added?: number; removed?: number }): string {
  const parts: string[] = [];
  if (change.added !== undefined) parts.push(`+${change.added}`);
  if (change.removed !== undefined) parts.push(`−${change.removed}`);
  return parts.join(" ");
}

const CHANGE_VERB: Record<string, string> = {
  add: "create",
  update: "edit",
  delete: "delete",
  unknown: "change",
};

onMount(() => {
  void refreshGate();
  // The config changes only when the user edits it in Settings or the wizard,
  // so this re-read is slow on purpose — it exists to pick up an integration
  // added mid-session, not to track anything live.
  const gateTimer = window.setInterval(() => void refreshGate(), 30_000);
  return () => window.clearInterval(gateTimer);
});

// Tears down and recreates the interval only when `polling` genuinely FLIPS.
// `refresh()` writes `approvals`, which `polling` reads — but `$derived`
// memoizes by value, so a boolean recomputing to the same boolean marks no
// dependent dirty. Without that the interval would be rebuilt on every poll
// result. `refresh()` is fired with `void`: its `approvals` write lands in a
// later microtask, outside this reaction's tracking window, so it is not a
// dependency of this effect either.
$effect(() => {
  if (!polling) return;
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

    <!-- The change set is what "Allow for session" grants standing write access
         to, so it renders ABOVE the actions rather than behind a disclosure. -->
    {#if current.changes?.length}
      <div class="changes" data-testid="codex-approval-changes">
        <div class="changes-heading">
          Files Codex wants to change ({current.changes.length}{current.omittedChanges
            ? ` shown, ${current.omittedChanges} more`
            : ""})
        </div>
        <ul>
          {#each current.changes as change (change.path)}
            <li data-testid="codex-approval-change-{change.kind}">
              <span class="change-kind">{CHANGE_VERB[change.kind] ?? change.kind}</span>
              <span class="change-path">{change.path}</span>
              {#if change.movePath}
                <span class="change-path">→ {change.movePath}</span>
              {/if}
              {#if changeCounts(change)}
                <span class="change-counts">{changeCounts(change)}</span>
              {/if}
              {#if change.diffTruncated}
                <span class="change-counts">(diff truncated)</span>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {:else if current.kind === "file-change"}
      <!-- The broker sets allowForSession false in this state, so the standing
           grant is already off the table; say why rather than showing nothing. -->
      <p class="unreadable" data-testid="codex-approval-changes-unreadable">
        Codex didn't describe which files it wants to change, so Tandem can't show you the scope of
        this request.
      </p>
    {/if}

    {#if current.grantRoot}
      <dl><dt>Grant scope</dt><dd data-testid="codex-approval-grant-root">{current.grantRoot}</dd></dl>
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
  .changes { margin: 0.65rem 0; }
  .changes-heading { color: var(--tandem-fg-muted); font-size: 0.85rem; margin-bottom: 0.35rem; }
  .changes ul { max-height: 12rem; overflow: auto; margin: 0; padding: 0.5rem 0.75rem; list-style: none; border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-1); background: var(--tandem-bg); }
  .changes li { display: flex; gap: 0.5rem; align-items: baseline; font-size: 0.85rem; padding: 0.15rem 0; }
  .change-kind { color: var(--tandem-fg-muted); flex: 0 0 3.5rem; }
  .change-path { overflow-wrap: anywhere; }
  .change-counts { color: var(--tandem-fg-muted); margin-left: auto; white-space: nowrap; }
  .unreadable { color: var(--tandem-warning-fg-strong); font-size: 0.85rem; }
  .queue { color: var(--tandem-fg-muted); font-size: 0.85rem; }
  .error { color: var(--tandem-error); }
  .actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; flex-wrap: wrap; }
  button { border-radius: var(--tandem-r-1); padding: 0.55rem 0.8rem; font: inherit; cursor: pointer; }
  button:disabled { opacity: 0.55; cursor: default; }
  .secondary { border: 1px solid var(--tandem-border); background: transparent; color: inherit; }
  /* `--tandem-accent` is the fill; `--tandem-accent-border` is a border token
     and reads washed out as a background. `--tandem-accent-fg` carries the
     paired foreground, so the button stays legible in both themes — a
     hardcoded `white` did not. */
  .primary { border: 1px solid transparent; background: var(--tandem-accent); color: var(--tandem-accent-fg); }
</style>
