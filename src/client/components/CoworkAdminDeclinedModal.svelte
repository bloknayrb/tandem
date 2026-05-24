<script lang="ts">
import { formatCoworkError } from "../cowork/cowork-helpers";
import {
  coworkRetryAdminElevation,
  coworkToggleIntegration,
  type InvokeFn,
  loadInvoke,
} from "../cowork/cowork-invoke";
import { createCoworkStatus } from "../hooks/useCoworkStatus.svelte";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const coworkState = createCoworkStatus(() => true);

const uacDeclined = $derived(coworkState.status?.uacDeclined === true);

let modalEl: HTMLDivElement | undefined = $state();
let confirmingDisable = $state(false);
let busy = $state(false);
let error = $state<string | null>(null);

// Title badge — surfaces the warning in the OS window/tab list
$effect(() => {
  if (!uacDeclined) return;
  const prev = typeof document !== "undefined" ? document.title : null;
  if (typeof document !== "undefined" && !document.title.startsWith("⚠")) {
    document.title = `⚠ ${document.title}`;
  }
  return () => {
    if (typeof document !== "undefined" && prev !== null) {
      document.title = prev;
    }
  };
});

// Focus trap on Tab
$effect(() => {
  if (!uacDeclined) return;
  const handler = (e: KeyboardEvent) => {
    if (e.key !== "Tab" || !modalEl) return;
    const focusables = modalEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!modalEl.contains(active)) {
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
});

// Move focus into the modal on open
$effect(() => {
  if (!uacDeclined) return;
  modalEl?.focus();
});

async function withInvoke(
  op: (invoke: InvokeFn) => Promise<void>,
  errorPrefix: string,
): Promise<void> {
  busy = true;
  error = null;
  try {
    const invoke = await loadInvoke();
    await op(invoke);
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const display = formatCoworkError(rawMsg);
    error = `${errorPrefix}: ${display}`;
  } finally {
    busy = false;
  }
}

async function handleRetry(): Promise<void> {
  await withInvoke(async (invoke) => {
    await coworkRetryAdminElevation(invoke);
    await coworkState.refetch();
  }, "Retry failed");
}

async function handleDisable(): Promise<void> {
  await withInvoke(async (invoke) => {
    await coworkToggleIntegration(invoke, false);
    await coworkState.refetch();
  }, "Failed to disable Cowork");
  confirmingDisable = false;
}
</script>

{#if coworkState.error && !coworkState.status}
  <div
    data-testid="cowork-admin-declined-status-error"
    role="alert"
    style="position: fixed; bottom: 16px; right: 16px; z-index: 10000; max-width: 400px; border: 1px solid var(--tandem-error-border); background: var(--tandem-error-bg); color: var(--tandem-error-fg-strong); border-radius: var(--tandem-r-3); padding: 10px 14px; font-size: 12px; line-height: 1.5;"
  >
    Cowork status check failed: unable to determine if admin elevation was declined. Please
    restart Tandem to restore normal operation.
  </div>
{:else if uacDeclined}
  <div
    data-testid="cowork-admin-declined-backdrop"
    style="position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: var(--tandem-z-above-titlebar); display: flex; align-items: center; justify-content: center;"
  >
    <div
      bind:this={modalEl}
      data-testid="cowork-admin-declined-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cowork-admin-declined-heading"
      tabindex={-1}
      style="width: 440px; max-width: calc(100vw - 32px); background: var(--tandem-surface); color: var(--tandem-fg); border: 1px solid var(--tandem-error-border); border-radius: var(--tandem-r-4); padding: 20px; box-shadow: var(--tandem-shadow-3); outline: none; display: flex; flex-direction: column; gap: 12px;"
    >
      <h2
        id="cowork-admin-declined-heading"
        style="margin: 0; font-size: 16px; font-weight: 600; color: var(--tandem-error-fg-strong);"
      >
        Admin permission required
      </h2>

      <div style="font-size: 13px; line-height: 1.5; color: var(--tandem-fg-muted);">
        Cowork integration requires Windows admin permission to configure firewall rules. Without
        it, Tandem can't safely be reached from inside the Cowork VM. Port 3479 is currently
        blocked by a deny rule to protect your machine.
      </div>

      {#if error}
        <div
          data-testid="cowork-admin-declined-error"
          role="alert"
          style="font-size: 12px; color: var(--tandem-error-fg-strong); background: var(--tandem-error-bg); border: 1px solid var(--tandem-error-border); border-radius: var(--tandem-r-2); padding: 6px 8px;"
        >
          {error}
        </div>
      {/if}

      {#if confirmingDisable}
        <div
          data-testid="cowork-admin-declined-confirm-disable"
          style="font-size: 12px; color: var(--tandem-warning-fg-strong); background: var(--tandem-warning-bg); border: 1px solid var(--tandem-warning-border); border-radius: var(--tandem-r-2); padding: 8px 10px;"
        >
          <div style="font-weight: 600; margin-bottom: 6px;">Disable Cowork integration?</div>
          <div style="margin-bottom: 8px;">
            The deny rule will remain in place. You can re-enable Cowork later from Settings.
          </div>
          <div style="display: flex; gap: 8px;">
            <button
              data-testid="cowork-admin-declined-disable-confirm-btn"
              type="button"
              onclick={() => void handleDisable()}
              disabled={busy}
              style="padding: 4px 10px; font-size: 12px; border: 1px solid var(--tandem-error-border); border-radius: var(--tandem-r-2); background: var(--tandem-error); color: var(--tandem-error-fg); cursor: pointer; font-weight: 600;"
            >
              Disable
            </button>
            <button
              data-testid="cowork-admin-declined-disable-cancel-btn"
              type="button"
              onclick={() => { confirmingDisable = false; }}
              disabled={busy}
              style="padding: 4px 10px; font-size: 12px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg-muted); cursor: pointer;"
            >
              Cancel
            </button>
          </div>
        </div>
      {:else}
        <div style="display: flex; gap: 8px; justify-content: flex-end;">
          <button
            data-testid="cowork-admin-declined-disable-btn"
            type="button"
            onclick={() => { confirmingDisable = true; }}
            disabled={busy}
            style="padding: 6px 12px; font-size: 13px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); background: var(--tandem-surface); color: var(--tandem-fg-muted); cursor: pointer;"
          >
            Disable Cowork
          </button>
          <button
            data-testid="cowork-admin-declined-retry-btn"
            type="button"
            onclick={() => void handleRetry()}
            disabled={busy}
            style="padding: 6px 12px; font-size: 13px; border: 1px solid var(--tandem-accent); border-radius: var(--tandem-r-2); background: var(--tandem-accent); color: var(--tandem-accent-fg); cursor: pointer; font-weight: 600;"
          >
            Retry with admin
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}
