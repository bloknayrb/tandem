<script lang="ts">
import type { Toast } from "../hooks/useNotifications.svelte";

const SEVERITY_TOKENS: Record<Toast["severity"], string> = {
  error: "var(--tandem-error)",
  warning: "var(--tandem-warning)",
  info: "var(--tandem-accent)",
};

const SEVERITY_BG_TOKENS: Record<Toast["severity"], string> = {
  error: "var(--tandem-error-bg)",
  warning: "var(--tandem-warning-bg)",
  info: "var(--tandem-accent-bg)",
};

const SEVERITY_TEXT_TOKENS: Record<Toast["severity"], string> = {
  error: "var(--tandem-error-fg-strong)",
  warning: "var(--tandem-warning-fg-strong)",
  info: "var(--tandem-accent-fg-strong)",
};

interface Props {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

let { toasts, onDismiss }: Props = $props();
</script>

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
</style>

{#if toasts.length > 0}
  <div
    data-testid="toast-container"
    style="position: fixed; bottom: 40px; right: var(--tandem-space-4); z-index: var(--tandem-z-toast); display: flex; flex-direction: column; gap: var(--tandem-space-2); max-width: 360px; pointer-events: none;"
  >
    {#each toasts as toast (toast.id)}
      {@const borderColor = SEVERITY_TOKENS[toast.severity]}
      {@const bgColor = SEVERITY_BG_TOKENS[toast.severity]}
      {@const textColor = SEVERITY_TEXT_TOKENS[toast.severity]}
      {@const ariaRole = toast.severity === "info" ? "status" : "alert"}
      <div
        role={ariaRole}
        data-testid={`toast-${toast.id}`}
        style="pointer-events: auto; background: var(--tandem-surface); border-radius: var(--tandem-r-3); border-left: 4px solid {borderColor}; box-shadow: var(--tandem-shadow-4); padding: 10px 32px 10px 12px; position: relative; animation: tandem-toast-slide-in 0.2s ease-out; font-size: var(--tandem-text-base); line-height: 1.4; color: var(--tandem-fg);"
      >
        <span>{toast.message}</span>
        {#if toast.count > 1}
          <span
            data-testid={`toast-count-${toast.id}`}
            style="margin-left: 6px; font-size: 11px; font-weight: 600; color: {textColor}; background: {bgColor}; padding: 1px 5px; border-radius: var(--tandem-r-4);"
          >
            ×{toast.count}
          </span>
        {/if}
        <button
          data-testid={`toast-dismiss-${toast.id}`}
          onclick={() => onDismiss(toast.id)}
          style="position: absolute; top: 6px; right: 6px; border: none; background: transparent; cursor: pointer; font-size: 14px; color: var(--tandem-fg-subtle); line-height: 1; padding: 2px 4px;"
          aria-label="Dismiss notification"
        >
          ×
        </button>
      </div>
    {/each}
  </div>
{/if}
