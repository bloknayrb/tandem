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

<!-- A sliver of the collapsed panel pokes out from the window edge so the
     user can see where to click to bring it back. Matches the rail's
     surface-muted background, inner-corner radius, and top/bottom insets so
     it visually reads as "the same card, mostly tucked away." -->
<!-- tabindex="-1": Alt+Shift+Arrow is the keyboard equivalent; the strip
     stays out of the Tab sequence to avoid cluttering the focus order. -->
<button
  class="peek-strip peek-strip-{side}"
  data-testid={`peek-strip-${side}`}
  type="button"
  tabindex="-1"
  aria-label={side === "left" ? "Show left panel" : "Show right panel"}
  aria-expanded="false"
  onclick={onActivate}
  onkeydown={handleKey}
>
  <span class="peek-chevron" aria-hidden="true">
    {side === "left" ? "›" : "‹"}
  </span>
</button>

<style>
  .peek-strip {
    /* Absolute so we inherit the parent flex container's coordinate space.
       The container already sits below titlebar + Toolbar + FormattingBar,
       so matching the rail's `margin-top` / `margin-bottom` here puts the
       strip's top/bottom edges flush with the open rail's edges. */
    position: absolute;
    top: var(--tandem-rail-top-clearance, 0);
    bottom: var(--tandem-status-clearance-total, 60px);
    width: 14px;
    padding: 0;
    border: 1px solid var(--tandem-border);
    background: var(--tandem-surface-muted);
    color: var(--tandem-fg-faint);
    cursor: pointer;
    z-index: var(--tandem-z-sticky);
    box-shadow: var(--tandem-shadow-1);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: width 160ms ease, background 160ms ease, color 160ms ease, box-shadow 160ms ease;
  }
  .peek-strip-left {
    left: 0;
    border-left: none;
    border-radius: 0 var(--tandem-rail-inner-radius, 14px) var(--tandem-rail-inner-radius, 14px) 0;
  }
  .peek-strip-right {
    right: 0;
    border-right: none;
    border-radius: var(--tandem-rail-inner-radius, 14px) 0 0 var(--tandem-rail-inner-radius, 14px);
  }
  .peek-chevron {
    font-size: var(--tandem-text-sm);
    line-height: 1;
    opacity: 0.7;
    transition: opacity 160ms ease;
  }
  .peek-strip:hover,
  .peek-strip:focus-visible {
    width: 20px;
    box-shadow: var(--tandem-shadow-3);
    outline: none;
  }
  .peek-strip:hover .peek-chevron,
  .peek-strip:focus-visible .peek-chevron {
    opacity: 1;
  }
  .peek-strip:focus-visible {
    box-shadow: var(--tandem-shadow-3), inset 0 0 0 2px var(--tandem-accent);
  }
</style>
