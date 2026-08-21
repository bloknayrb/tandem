<script lang="ts">
import LiveRegion from "./LiveRegion.svelte";
import "./tandem-banner.css";

interface Props {
  /**
   * #1431: the gate lives here, not at the call site. App.svelte used to wrap
   * this component in the `{#if}`, so the only node that could carry the live
   * region was the banner itself — created together with its text, and
   * therefore announced by nothing. The host has to outlive the message, and
   * the only place that can be is inside the component.
   */
  visible: boolean;
  onDismiss: () => void;
  onRetry: () => void;
}

let { visible, onDismiss, onRetry }: Props = $props();
</script>

<!-- The banner div deliberately carries no role/aria-live of its own: one owner
     per message, so politeness and atomic scope are decided in one place. -->
<LiveRegion data-testid="connection-banner-live">
  {#if visible}
    <div
      class="tandem-banner tandem-banner--error"
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
        We've lost the connection to the Tandem server. Please check that it's still running.
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
  {/if}
</LiveRegion>

<!-- Banner styles live in src/client/components/tandem-banner.css and are
     imported globally from <script> above — shared with UpdaterBanner. -->
