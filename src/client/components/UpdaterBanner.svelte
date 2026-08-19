<script lang="ts">
import LiveRegion from "./LiveRegion.svelte";
import "./tandem-banner.css";

interface Props {
  /**
   * #1431: the gate moved in here from App.svelte. While the `{#if}` lived at
   * the call site, the banner div was created together with its text, so the
   * live region it carried was never in the accessibility tree before the
   * change it was meant to announce.
   */
  visible: boolean;
  /** Null while no update is known; the component renders nothing then. */
  version: string | null;
  installing: boolean;
  onInstall: () => void;
  onDismiss: () => void;
}

let { visible, version, installing, onInstall, onDismiss }: Props = $props();

const ctaLabel = $derived(installing ? "Installing…" : "Restart to install");
</script>

<!-- No role/aria-live on the banner itself: one owner per message (§#1431). -->
<LiveRegion data-testid="updater-banner-live">
  {#if visible && version}
    <div
      class="tandem-banner tandem-banner--info"
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
  {/if}
</LiveRegion>

<!-- Banner styles live in src/client/components/tandem-banner.css and are
     imported globally from <script> above — shared with ConnectionBanner. -->
