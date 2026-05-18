<script lang="ts">
interface Props {
  side: "left" | "right";
  onActivate: () => void;
}

const { side, onActivate }: Props = $props();

function handleKey(e: KeyboardEvent) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    onActivate();
  }
}
</script>

<!-- Faint vertical bar at the window edge; brightens on hover and toggles
     the panel visible on click or Enter/Space. -->
<div
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
