<script lang="ts">
import "./tandem-banner.css";

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

<!-- Banner styles live in src/client/components/tandem-banner.css and are
     imported globally from <script> above — shared with ConnectionBanner. -->
