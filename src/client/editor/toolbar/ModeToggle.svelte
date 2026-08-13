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
    display: inline-grid;
    /* `minmax(0, 1fr)`, not a bare `1fr`. Both measure IDENTICALLY today — the
       track is shrink-to-fit, so it sizes to max-content and the `auto`
       minimum never binds. They diverge only under compression, and there the
       0 minimum is the one that holds this component's whole invariant:
       measured at a 120px cap, `1fr` gives 52 / 70.97px columns while
       `minmax(0, 1fr)` gives 60 / 60px. Unequal columns put the thumb (which
       IS column 1) on a segment of a different width — #1384, reopened. The
       trade is that a squeezed label can outgrow its column; a visibly
       overflowing label beats a silently misplaced pill. */
    grid-template-columns: repeat(2, minmax(0, 1fr));
    /* The thumb's containing block. Measured: remove it and the thumb sizes
       itself against the viewport. Fails silently. */
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
    /* Must stay 0: the thumb slides exactly one column, so any gutter desyncs
       `translateX(100%)` from the column pitch. */
    gap: 0;
  }
  /* A8 (#798): the sliding active pill. Its box IS grid area (1,1) — the first
     segment, to the pixel — so it does no arithmetic of its own and cannot
     drift from the button underneath it. Do not reintroduce percentage sizing;
     derived-spec.md §3.9 forbids it.

     Two traps in that placement, both silent if you get them wrong:

       - ALL FOUR grid lines must be written out. On an absolutely-positioned
         grid child an `auto` end line resolves to the container's PADDING
         EDGE, not to `span 1`, so a two-line `grid-area: 1 / 1` stretches the
         thumb across the entire track. Measured; nothing warns.
       - `inset: 0` is required. Without it the abspos box shrink-to-fits and
         renders 0x0.

     Flushness is measured, not asserted here — tests/e2e/mode-toggle-geometry
     .spec.ts. Minifier survival is pinned in css-pipeline-contract.test.ts,
     because CI's Playwright run drives `npm run dev`, which never minifies. */
  .thumb {
    position: absolute;
    grid-area: 1 / 1 / 2 / 2;
    inset: 0;
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
    /* No width rule belongs here: the segments ARE the track's two equal grid
       columns and the button stretches to fill its column. The `flex: 1 1 0`
       this replaces never equalized them — a flex item's automatic minimum
       size is its min-content size, so "Tandem" (one unbreakable word) kept
       its natural width and "Solo" took the remainder (measured 67.8 vs
       50.5px). That inequality was #1383/#1384, one defect seen from two
       sides: the pill matched neither segment, and each label sat off the
       pill's optical centre. */
    /* Center the label on both axes. `line-height: normal` (not the tight `1`)
       is the load-bearing part: at `line-height: 1` the line box is shorter than
       the glyph's natural box, so the text rendered ~0.7px high (2.6px gap above
       vs 4px below). `normal` + flex centering distributes the leading evenly
       (3.3px / 3.3px), and the padding is trimmed 5px→3px so the taller line box
       holds the pill within a pixel of its original 21px height (20px under the
       shipped SN Pro face; the untrimmed `5px` + `normal` pairing would be
       24px). */
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
