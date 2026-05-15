<script lang="ts">
import "./tandem-banner.css";

interface Props {
  onDismiss: () => void;
  onRetry: () => void;
}

let { onDismiss, onRetry }: Props = $props();
</script>

<div
  class="tandem-banner tandem-banner--info"
  role="status"
  aria-live="polite"
  data-testid="connection-banner"
>
  <span class="tandem-banner__icon" aria-hidden="true">
    <!-- Cloud-off glyph; inherits currentColor -->
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2 2l20 20" />
      <path d="M5.16 5.26A6 6 0 008 17h11a4 4 0 00.74-7.93" />
      <path d="M12 7a5 5 0 014.9 4" />
    </svg>
  </span>
  <span class="tandem-banner__message">
    Connection to the Tandem server has been lost. Ensure the server is running.
  </span>
  <button
    type="button"
    class="tandem-banner__cta"
    data-testid="connection-banner-retry"
    onclick={onRetry}
  >
    Retry now
  </button>
  <button
    type="button"
    class="tandem-banner__dismiss"
    onclick={onDismiss}
    aria-label="Dismiss connection banner"
  >
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M6 18L18 6" />
    </svg>
  </button>
</div>

<!-- Banner styles live in src/client/components/tandem-banner.css and are
     imported globally from <script> above — shared with UpdaterBanner. -->
