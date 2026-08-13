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
    /* `minmax(0, 1fr)`, not a bare `1fr` — a GUARD, not the active fix. Nothing
       in the shipped title bar can compress this track (`.title-bar-mode` is
       `flex: 0 0 auto`; `.title-bar-center` carries `min-width: 0` and absorbs
       all shrink), so both forms measure identically here. They diverge once
       something DOES compress it: a bare `1fr` floors each column at
       min-content, and unequal columns put the thumb — which IS column 1 — on a
       segment of a different width, reopening #1384. Since no viewport reaches
       that, the E2E spec injects a `max-width` to measure it rather than leave
       it narrated.

       The guarantee holds over a range, not unconditionally: the buttons cannot
       shrink past their own horizontal padding, so a narrow enough track
       overflows equal columns anyway. The spec asserts where that boundary is;
       do not restate it here, because a restated boundary is one nothing
       checks. */
    grid-template-columns: repeat(2, minmax(0, 1fr));
    /* The thumb's containing block, and the reason this rule is load-bearing is
       non-local: remove it and the containing block falls through to
       `.title-bar-mode`, which is itself positioned — the grid placement below
       stops applying entirely, with no warning. Correctness here depends on an
       ancestor rule in another file. */
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
         grid child an `auto` end line resolves to the container's PADDING EDGE,
         not to `span 1`, so a two-line `grid-area: 1 / 1` stretches the thumb
         on BOTH axes. The row half is the non-obvious one: there is no
         `grid-template-rows`, so row line 2 lives in the IMPLICIT grid and
         reads as decorative. It is what holds the bottom edge flush.
       - `inset: 0` is required. Without it the abspos box shrink-to-fits and
         renders 0x0.

     Flushness is measured in tests/e2e/mode-toggle-geometry.spec.ts; minifier
     survival in css-pipeline-contract.test.ts, because CI's Playwright run
     drives `npm run dev`, which never minifies. */
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
    /* No width rule belongs here — not even `min-width`: the segments ARE the
       track's two equal grid columns and the button stretches to fill its
       column. The `flex: 1 1 0` this replaces never equalized them, because a
       flex item's automatic minimum size is its min-content size, so "Tandem"
       (one unbreakable word) kept its natural width and "Solo" took the
       remainder. That inequality was #1383/#1384, one defect seen from two
       sides: the pill matched neither segment, and each label sat off the
       pill's optical centre. The E2E spec carries the measurements.

       Center the label on both axes. `line-height: normal` (not the tight `1`)
       is the load-bearing part: at `line-height: 1` the line box is shorter
       than the glyph's natural box and the text renders cramped against the
       top. `normal` distributes the leading evenly, and the padding is trimmed
       5px -> 3px to offset the taller line box so the pill keeps its height.
       That pairing is the one thing here a delta-based test cannot see, so the
       E2E spec asserts the pill's absolute height. */
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
  /* Not cosmetic — this is the ONLY selection indicator in forced-colors mode.
     Measured there: the thumb's background is forced to the same white as the
     track and its box-shadow to `none`, so the pill is invisible and the
     outline is all that distinguishes the active segment. Pinned by
     tests/e2e/forced-colors.spec.ts. */
  @media (forced-colors: active) {
    .mode-toggle button[aria-pressed="true"] {
      outline: 2px solid ButtonText;
    }
  }
</style>
