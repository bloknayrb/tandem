<script lang="ts">
interface Props {
  version: string;
  installing: boolean;
  onInstall: () => void;
  onDismiss: () => void;
}

let { version, installing, onInstall, onDismiss }: Props = $props();

const ctaLabel = $derived(installing ? "Installing…" : "Restart to install");
</script>

<div
  class="tandem-banner tandem-banner--info"
  role="status"
  aria-live="polite"
  data-testid="updater-banner"
>
  <span class="tandem-banner__icon" aria-hidden="true">
    <!-- Down-arrow-in-cloud glyph; inherits currentColor -->
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 16.58A5 5 0 0018 7h-1.26A8 8 0 104 15.25" />
      <path d="M12 12v8" />
      <path d="M8 16l4 4 4-4" />
    </svg>
  </span>
  <span class="tandem-banner__message">
    Tandem v{version} is available.
  </span>
  <button
    type="button"
    class="tandem-banner__cta"
    data-testid="updater-banner-install"
    onclick={onInstall}
    disabled={installing}
  >
    {ctaLabel}
  </button>
  <button
    type="button"
    class="tandem-banner__dismiss"
    data-testid="updater-banner-dismiss"
    onclick={onDismiss}
    aria-label="Dismiss update notification"
  >
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M6 18L18 6" />
    </svg>
  </button>
</div>

<style>
.tandem-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--tandem-space-3);
  padding: var(--tandem-space-2) var(--tandem-space-4);
  font-size: var(--tandem-text-sm);
  line-height: 1.4;
  text-align: center;
  border-bottom: 1px solid transparent;
  animation: tandem-banner-slide-in 180ms ease-out;
}

.tandem-banner--info {
  background: var(--tandem-info-bg);
  color: var(--tandem-info-fg-strong);
  border-bottom-color: var(--tandem-info-border);
}

.tandem-banner__icon {
  display: inline-flex;
  flex: 0 0 auto;
  color: var(--tandem-info-fg-strong);
}

.tandem-banner__message {
  flex: 0 1 auto;
  min-width: 0;
}

.tandem-banner__cta {
  flex: 0 0 auto;
  background: transparent;
  border: 1px solid var(--tandem-info-border);
  border-radius: var(--tandem-r-2);
  color: var(--tandem-info-fg-strong);
  cursor: pointer;
  font: inherit;
  font-size: var(--tandem-text-sm);
  font-weight: 500;
  padding: 2px var(--tandem-space-3);
  transition: background-color 120ms ease-out, border-color 120ms ease-out;
}

.tandem-banner__cta:hover:not(:disabled) {
  background: color-mix(in srgb, var(--tandem-info) 14%, transparent);
}

.tandem-banner__cta:focus-visible {
  outline: 2px solid var(--tandem-info-fg-strong);
  outline-offset: 2px;
}

.tandem-banner__cta:disabled {
  cursor: progress;
  opacity: 0.7;
}

.tandem-banner__dismiss {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--tandem-r-2);
  color: var(--tandem-info-fg-strong);
  cursor: pointer;
  padding: var(--tandem-space-1);
  line-height: 0;
  transition: background-color 120ms ease-out;
}

.tandem-banner__dismiss:hover {
  background: color-mix(in srgb, var(--tandem-info) 14%, transparent);
}

.tandem-banner__dismiss:focus-visible {
  outline: 2px solid var(--tandem-info-fg-strong);
  outline-offset: 2px;
}

@keyframes tandem-banner-slide-in {
  from {
    transform: translateY(-100%);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tandem-banner {
    animation: none;
  }
  .tandem-banner__cta,
  .tandem-banner__dismiss {
    transition: none;
  }
}

@media (forced-colors: active) {
  .tandem-banner {
    border-bottom: 1px solid CanvasText;
    background: Canvas;
    color: CanvasText;
  }
  .tandem-banner__cta {
    border-color: CanvasText;
    color: CanvasText;
  }
  .tandem-banner__cta:hover:not(:disabled),
  .tandem-banner__dismiss:hover {
    background: Highlight;
    color: HighlightText;
  }
}
</style>
