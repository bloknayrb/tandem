<script lang="ts">
import type { TandemMode } from "../../../shared/types";

interface Props {
  tandemMode: TandemMode;
  onModeChange: (mode: TandemMode) => void;
}

const { tandemMode, onModeChange }: Props = $props();
</script>

<!-- Rounded soft pill, two buttons; `.on` state has a subtle shadow.
     The Claude-active dot lives on the status bar, not duplicated here. -->
<div
  data-testid="mode-toggle"
  data-tauri-drag-region="false"
  class="mode-toggle"
  role="group"
  aria-label="AI collaboration mode"
>
  <!-- A8 (#798): the sliding thumb carries the active background; it slides
       between the two equal-width segments on a mode flip. Decorative + behind
       the buttons, so it can't intercept clicks. Class is set at render, so it
       sits correctly on mount with no slide; only a mode change animates it. -->
  <span class="thumb" class:tandem={tandemMode === "tandem"} aria-hidden="true"></span>
  <button
    data-testid="mode-solo-btn"
    class={tandemMode === "solo" ? "on" : ""}
    title="Write undisturbed — your AI pauses and won't see your comments or edits until you switch back to Tandem"
    aria-pressed={tandemMode === "solo"}
    onclick={() => onModeChange("solo")}
  >Solo</button>
  <button
    data-testid="mode-tandem-btn"
    class={tandemMode === "tandem" ? "on" : ""}
    title="Full collaboration — your AI sees your selections, comments, and edits as you make them"
    aria-pressed={tandemMode === "tandem"}
    onclick={() => onModeChange("tandem")}
  >Tandem</button>
</div>

<style>
  .mode-toggle {
    display: inline-flex;
    position: relative;
    /* Bundle's `.a8 .seg` recipe: 2px track padding + a 1px border so the
       segmented control reads as a chip rather than a recessed plate. The
       surface-sunk track is preserved from the prior version because the
       lighter `surface` active pill needs the contrast in both themes. */
    padding: 2px;
    background: var(--tandem-surface-sunk);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-pill);
    font-size: 11px;
    font-weight: 600;
    gap: 0;
  }
  /* A8 (#798): the sliding active pill. Half the track's inner width, anchored
     left; a mode flip slides it by its own width (translateX 100%) to land
     exactly on the right segment — the `width: calc(50% - 2px)` accounts for
     the 2px left track padding so the arithmetic is exact. */
  .thumb {
    position: absolute;
    top: 2px;
    bottom: 2px;
    left: 2px;
    width: calc(50% - 2px);
    background: var(--tandem-surface);
    border-radius: var(--tandem-r-pill);
    box-shadow: var(--tandem-shadow-1);
    pointer-events: none;
    z-index: 0;
    transition: transform 220ms var(--tandem-ease-out);
  }
  .thumb.tandem {
    transform: translateX(100%);
  }
  .mode-toggle button {
    /* Equal-width segments so the half-width thumb lands cleanly on either; the
       two labels ("Solo"/"Tandem") differ in length, so flex-equalize them. */
    flex: 1 1 0;
    /* Center the label on both axes. `line-height: normal` (not the tight `1`)
       is the load-bearing part: at `line-height: 1` the line box is shorter than
       the glyph's natural box, so the text rendered ~0.7px high (2.6px gap above
       vs 4px below). `normal` + flex centering distributes the leading evenly
       (3.3px / 3.3px), and the padding is trimmed 5px→3px so the taller line box
       keeps the pill at its original 21px height. */
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 3px 14px;
    border-radius: var(--tandem-r-pill);
    color: var(--tandem-fg-muted);
    background: transparent;
    border: none;
    cursor: pointer;
    font: inherit;
    line-height: normal;
    /* Sit above the thumb; the thumb (not the button) now carries the active fill. */
    position: relative;
    z-index: 1;
    transition: color 140ms ease;
  }
  .mode-toggle button:hover:not(.on) {
    color: var(--tandem-fg);
  }
  .mode-toggle button.on {
    color: var(--tandem-fg);
  }
  /* Reduced motion: the thumb still positions correctly (transform is keyed to
     the mode class) — only the slide is removed. Dual guard: OS pref AND the
     in-app `body.tandem-reduce-motion` (class on <body>, so :global(...)). */
  @media (prefers-reduced-motion: reduce) {
    .thumb {
      transition: none;
    }
  }
  :global(body.tandem-reduce-motion) .thumb {
    transition: none;
  }
  @media (forced-colors: active) {
    .mode-toggle button[aria-pressed="true"] {
      outline: 2px solid ButtonText;
    }
  }
</style>
