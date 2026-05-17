<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
  /** Label shown in the disclosure header. */
  label: string;
  /** Initial open state. Disclosure resets each mount (Svelte unmounts/remounts the
   *  section when the parent re-renders, e.g. on settings popover close→open), so
   *  there's no persistent open state — intentional per the PR 6 plan. */
  defaultOpen?: boolean;
  /** Forwarded to the underlying `<details>` element as `data-testid`. Used for
   *  E2E queries of both the disclosure state and its child controls. */
  testid?: string;
  children: Snippet;
}

const { label, defaultOpen = false, testid, children }: Props = $props();

const summaryStyle =
  "font-size: 11px; font-weight: 600; color: var(--tandem-fg); cursor: pointer; padding: var(--tandem-space-2) 0; text-transform: uppercase; letter-spacing: 0.5px; user-select: none; list-style: none;";

const bodyStyle =
  "display: flex; flex-direction: column; gap: var(--tandem-space-3); padding-top: var(--tandem-space-2);";
</script>

<details data-testid={testid} open={defaultOpen}>
  <summary data-testid={testid ? `${testid}-toggle` : undefined} style={summaryStyle}>
    {label}
  </summary>
  <div style={bodyStyle}>
    {@render children()}
  </div>
</details>

<style>
  /* Hide the native disclosure marker — we use the summary text alone as the
     affordance, matching the rest of the settings surface which doesn't use
     triangle markers. */
  summary::-webkit-details-marker {
    display: none;
  }
  summary::marker {
    content: "";
  }
</style>
