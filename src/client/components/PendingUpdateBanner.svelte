<script lang="ts">
import "./tandem-banner.css";

/**
 * #1118: "your update may not have completed".
 *
 * Shipped in #1431's shape from the start — a `visible` prop, self-gated
 * internally, wrapped in its own PERSISTENT live-region host. That host is the
 * point: an ARIA live region generally has to be in the accessibility tree
 * BEFORE its contents change, so a region created inside the same `{#if}` that
 * supplies its text is commonly never announced at all. Do not "simplify" the
 * host inside the `{#if}` — that is the exact defect #1431 exists to remove, and
 * it is pinned by a test.
 *
 * The host is written inline rather than importing `LiveRegion.svelte`, which is
 * #1431's new file: importing it would make this branch un-buildable until that
 * one lands, and #1431 already sets the precedent for an inline host where a
 * shared import is awkward. `.banner-stack` declares no `gap`, so the wrapper
 * costs no layout.
 *
 * The CTA is not a convenience. On the boot this banner exists for the sidecar
 * did not come up, and nothing re-offers the update for eight hours — so
 * "Check for updates" is the only remediation inside that window.
 */
interface Props {
  visible: boolean;
  onCheck: () => void;
  onDismiss: () => void;
}

let { visible, onCheck, onDismiss }: Props = $props();
</script>

<div
  role="status"
  aria-live="polite"
  data-testid="pending-update-banner-live"
>
  {#if visible}
    <div class="tandem-banner tandem-banner--warning" data-testid="pending-update-banner">
      <span class="tandem-banner__icon" aria-hidden="true">
        <!-- Alert triangle; inherits currentColor -->
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
      </span>
      <span class="tandem-banner__message">
        Tandem may not have finished updating — it restarted on the previous version.
      </span>
      <button
        type="button"
        class="tandem-banner__cta"
        data-testid="pending-update-banner-check"
        onclick={onCheck}
      >
        Check for updates
      </button>
      <button
        type="button"
        class="tandem-banner__dismiss"
        data-testid="pending-update-banner-dismiss"
        onclick={onDismiss}
        aria-label="Dismiss update notice"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 6l12 12M6 18L18 6" />
        </svg>
      </button>
    </div>
  {/if}
</div>

<!-- Banner styles live in src/client/components/tandem-banner.css and are
     imported globally from <script> above — shared with UpdaterBanner. -->
