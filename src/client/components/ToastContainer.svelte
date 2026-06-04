<script lang="ts">
import type { Toast } from "../hooks/useNotifications.svelte";
import { SEVERITY_GLYPHS } from "./activityCenter.js";

interface Props {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

let { toasts, onDismiss }: Props = $props();
</script>

{#if toasts.length > 0}
  <div data-testid="toast-container" class="toast-stack">
    {#each toasts as toast (toast.id)}
      <div
        role={toast.severity === "info" ? "status" : "alert"}
        data-testid={`toast-${toast.id}`}
        class="toast-card {toast.severity}"
      >
        <span class="glyph">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            {#each SEVERITY_GLYPHS[toast.severity] as d (d)}
              <path {d} />
            {/each}
          </svg>
        </span>
        <div class="body">
          <span class="msg">{toast.message}</span>
          {#if toast.count > 1}
            <span class="badge" data-testid={`toast-count-${toast.id}`}>×{toast.count}</span>
          {/if}
          {#if toast.action}
            <button
              type="button"
              class="action"
              data-testid={`toast-action-${toast.id}`}
              onclick={() => {
                toast.action?.onClick();
                onDismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          {/if}
        </div>
        <button
          type="button"
          class="dismiss"
          data-testid={`toast-dismiss-${toast.id}`}
          onclick={() => onDismiss(toast.id)}
          aria-label="Dismiss notification"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12" />
            <path d="M6 18L18 6" />
          </svg>
        </button>
      </div>
    {/each}
  </div>
{/if}

<style>
  :global {
    @keyframes tandem-toast-slide-in {
      from {
        opacity: 0;
        transform: translateX(40px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
  }

  .toast-stack {
    position: fixed;
    /* Sits above the activity pill (bottom: space-3, ~26px tall) + a gap. */
    bottom: calc(var(--tandem-space-3) + 26px + var(--tandem-space-2));
    right: var(--tandem-space-4);
    z-index: var(--tandem-z-toast);
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-2);
    max-width: 360px;
    pointer-events: none;
  }

  .toast-card {
    pointer-events: auto;
    display: flex;
    gap: 10px;
    align-items: flex-start;
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-3);
    box-shadow: var(--tandem-shadow-4);
    padding: 10px;
    position: relative;
    animation: tandem-toast-slide-in 0.2s ease-out;
  }

  .toast-card .glyph {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    border-radius: var(--tandem-r-3);
    display: inline-grid;
    place-items: center;
  }
  .toast-card.info .glyph {
    background: color-mix(in srgb, var(--tandem-info) 14%, transparent);
    color: var(--tandem-info);
  }
  .toast-card.warning .glyph {
    background: color-mix(in srgb, var(--tandem-warning) 18%, transparent);
    color: var(--tandem-warning);
  }
  .toast-card.error .glyph {
    background: color-mix(in srgb, var(--tandem-error) 18%, transparent);
    color: var(--tandem-error);
  }

  .toast-card .body {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--tandem-font-sans);
    font-size: var(--tandem-text-base);
    line-height: 1.4;
    color: var(--tandem-fg);
    padding-top: 2px;
  }
  .toast-card .msg {
    min-width: 0;
  }
  /* Inline action button (#1018) — e.g. "Connect AI" on a no-AI-connected
     toast. Compact, accent-tinted, doesn't compete with the message. */
  .toast-card .action {
    flex: 0 0 auto;
    font-family: var(--tandem-font-sans);
    font-size: var(--tandem-text-2xs);
    font-weight: 600;
    white-space: nowrap;
    padding: 2px 8px;
    border-radius: var(--tandem-r-pill);
    border: 1px solid var(--tandem-accent-border);
    background: var(--tandem-accent-bg);
    color: var(--tandem-accent);
    cursor: pointer;
  }
  .toast-card .action:hover {
    background: var(--tandem-accent);
    color: var(--tandem-bg);
  }
  .toast-card .badge {
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-2xs);
    font-weight: 600;
    padding: 1px 6px;
    border-radius: var(--tandem-r-pill);
    border: 1px solid transparent;
  }
  .toast-card.info .badge {
    background: var(--tandem-info-bg);
    color: var(--tandem-info-fg-strong);
    border-color: var(--tandem-info-border);
  }
  .toast-card.warning .badge {
    background: var(--tandem-warning-bg);
    color: var(--tandem-warning-fg-strong);
    border-color: var(--tandem-warning-border);
  }
  .toast-card.error .badge {
    background: var(--tandem-error-bg);
    color: var(--tandem-error-fg-strong);
    border-color: var(--tandem-error-border);
  }

  .toast-card .dismiss {
    flex: 0 0 auto;
    align-self: flex-start;
    width: 18px;
    height: 18px;
    border-radius: var(--tandem-r-2);
    background: transparent;
    border: none;
    color: var(--tandem-fg-subtle);
    cursor: pointer;
    display: inline-grid;
    place-items: center;
    transition: background 100ms, color 100ms;
  }
  .toast-card .dismiss:hover {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
  }

  @media (forced-colors: active) {
    .toast-card {
      border: 1px solid CanvasText;
    }
    .toast-card .badge {
      border: 1px solid ButtonText;
    }
  }
</style>
