<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
  /** Label shown in the disclosure header. */
  label: string;
  /** Initial open state. Disclosure resets each mount (Svelte unmounts/remounts the
   *  section when the parent re-renders, e.g. on settings modal close→open), so
   *  there's no persistent open state — intentional per the PR 6 plan. */
  defaultOpen?: boolean;
  /** Forwarded to the underlying `<details>` element as `data-testid`. Used for
   *  E2E queries of both the disclosure state and its child controls. */
  testid?: string;
  children: Snippet;
}

const { label, defaultOpen = false, testid, children }: Props = $props();
</script>

<details class="cs-details" data-testid={testid} open={defaultOpen}>
  <summary class="cs-summary" data-testid={testid ? `${testid}-toggle` : undefined}>
    <span class="cs-chevron" aria-hidden="true">›</span>
    {label}
  </summary>
  <div class="cs-body">
    {@render children()}
  </div>
</details>

<style>
  /* Hide the native disclosure marker — we use the chevron + summary text as
     the affordance, matching the rest of the settings surface which doesn't
     use triangle markers. */
  .cs-summary::-webkit-details-marker {
    display: none;
  }
  .cs-summary::marker {
    content: "";
  }

  .cs-summary {
    display: inline-flex;
    align-items: center;
    gap: var(--tandem-space-2);
    font-size: 11px;
    font-weight: 600;
    color: var(--tandem-fg);
    cursor: pointer;
    padding: var(--tandem-space-2) 0;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    user-select: none;
    list-style: none;
  }

  /* Chevron rotates open; the 140ms transition gives a soft affordance.
     Reduced motion honors both the OS pref and the in-app `reduceMotion`
     setting (parallel to cluster 3.10's dual-mechanism). */
  .cs-chevron {
    display: inline-block;
    color: var(--tandem-fg-subtle);
    font-size: 14px;
    line-height: 1;
    transform: rotate(0deg);
    transition: transform 140ms ease;
  }
  .cs-details[open] > .cs-summary .cs-chevron {
    transform: rotate(90deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .cs-chevron {
      transition: none;
    }
  }
  :global(body.tandem-reduce-motion) .cs-chevron {
    transition: none;
  }

  .cs-body {
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-3);
    padding-top: var(--tandem-space-2);
  }
</style>
