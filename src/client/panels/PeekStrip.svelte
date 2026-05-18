<script lang="ts">
import { onMount } from "svelte";

interface Props {
  side: "left" | "right";
  onActivate: () => void;
}

const { side, onActivate }: Props = $props();

// Ref captured via onMount (avoids the bind:this + $effect reactive loop
// that has bitten this codebase before — see feedback_svelte_state_bind_this_loop).
let stripEl: HTMLDivElement | null = null;
onMount(() => {
  if (stripEl) {
    // Nothing to wire here today — keyboard activation is handled inline
    // via onkeydown below. Reserved for any future side-effect wiring.
  }
});

function handleKey(e: KeyboardEvent) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    onActivate();
  }
}
</script>

<!-- Peek strip: faint vertical bar at the window edge that brightens on
     hover and toggles the panel visible on click or Enter/Space. The plan
     calls for a smooth translateX slide on activation; the slide is
     deferred until the full panel-edge architecture lands. Today the
     panel snaps in via the existing show/hide branch. -->
<div
  bind:this={stripEl}
  class="peek-strip peek-strip-{side}"
  data-testid={`peek-strip-${side}`}
  role="button"
  tabindex="0"
  aria-label={side === "left" ? "Show left panel" : "Show right panel"}
  onclick={onActivate}
  onkeydown={handleKey}
></div>

<style>
  .peek-strip {
    position: fixed;
    top: var(--tandem-rail-top-clearance, 52px);
    bottom: var(--tandem-status-clearance-total, 60px);
    width: 6px;
    background: var(--tandem-surface-muted);
    cursor: e-resize;
    opacity: 0.35;
    transition: opacity 160ms ease, background 160ms ease, width 160ms ease;
    z-index: var(--tandem-z-sticky);
  }
  .peek-strip-left {
    left: 0;
    border-radius: 0 var(--tandem-r-2) var(--tandem-r-2) 0;
  }
  .peek-strip-right {
    right: 0;
    cursor: w-resize;
    border-radius: var(--tandem-r-2) 0 0 var(--tandem-r-2);
  }
  .peek-strip:hover,
  .peek-strip:focus-visible {
    opacity: 1;
    background: var(--tandem-accent-bg);
    width: 10px;
    outline: none;
  }
  .peek-strip:focus-visible {
    box-shadow: inset 0 0 0 2px var(--tandem-accent);
  }
</style>
