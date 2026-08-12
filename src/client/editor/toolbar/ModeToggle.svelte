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
    grid-template-columns: repeat(2, 1fr);
    position: relative;
    /* Bundle's `.a8 .seg` recipe: 2px track padding + a 1px border so the
       segmented control reads as a chip rather than a recessed plate. The
       surface-sunk track is preserved from the prior version because the
       lighter `surface` active pill needs the contrast in both themes.

       Four details here are load-bearing for #1383/#1384, and each of them
       fails SILENTLY — no error, no warning, just a misaligned pill:

       (i) The columns are a BARE `1fr`, i.e. `minmax(auto, 1fr)`, and that
           `auto` minimum IS the fix. Do not normalize it to this codebase's
           usual `minmax(0, 1fr)` (HelpModal, SettingsModal, SettingsAboutTab,
           editor-stage): a 0 minimum lets a column be squeezed narrower than
           its own label, which is the exact condition that made the segments
           unequal and left the thumb matching neither of them.
       (ii) `gap` must stay 0. The thumb's slide is exactly one column, so any
            gutter desyncs `translateX(100%)` from the column pitch.
       (iii) `position: relative` is the thumb's containing block. Measured:
             remove it and the thumb sizes itself against the viewport.
       (iv) `inline-grid` is blockified to `grid` here, because the parent
            `.title-bar-mode` is an `inline-flex` container. Keep the `inline-`
            regardless — it is inert in THIS parent, not in general. */
    padding: 2px;
    background: var(--tandem-surface-sunk);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-pill);
    font-size: 11px;
    font-weight: 600;
    gap: 0;
  }
  /* A8 (#798): the sliding active pill. Its box IS grid area (1,1) — the first
     segment, to the pixel — so it does no arithmetic of its own and cannot
     drift from the button underneath it.

     It used to: `width: calc(50% - 2px)` assumed the two segments were exact
     halves, which `flex: 1 1 0` never delivered (see the button rule below).
     The pill overhung the selected segment by ~8.6px in both positions, which
     also left each label ~4.3px off the pill's optical centre — #1384 and
     #1383 respectively, one defect seen from two sides. Do not reintroduce
     percentage sizing here; derived-spec.md §3.9 forbids it.

     Two replacements for that arithmetic, both silent if you get them wrong:

       - ALL FOUR grid lines must be written out. On an absolutely-positioned
         grid child an `auto` end line resolves to the container's PADDING
         EDGE, not to `span 1`, so a two-line `grid-area: 1 / 1` stretches the
         thumb across the entire track. Measured; nothing warns.
       - `inset: 0` is required. Without it the abspos box shrink-to-fits and
         renders 0x0.

     Verified flush on all four edges under Chromium 145, WebKit 26 (Tandem's
     Linux WebView engine) and Firefox 146 with the shipped SN Pro webfont;
     WebKit rounds the translated position by 0.17px, everything else is 0.00.
     lightningcss keeps the four-line shorthand and `inset: 0` intact — pinned
     in tests/design-system-impl/css-pipeline-contract.test.ts, because CI's
     Playwright run drives `npm run dev`, which never minifies. */
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
  /* Exactly one column — and exact only while the track's `gap` stays 0. */
  .thumb.tandem {
    transform: translateX(100%);
  }
  .mode-toggle button {
    /* No width rule belongs here: the segments ARE the track's two equal grid
       columns and the button stretches to fill its column. The `flex: 1 1 0`
       this replaces claimed to equalize them and never did — a flex item's
       automatic minimum size is its min-content size, so "Tandem" (one
       unbreakable word) kept its natural width and "Solo" took the remainder
       (measured 67.8px vs 50.5px). That inequality was #1383/#1384. */
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
