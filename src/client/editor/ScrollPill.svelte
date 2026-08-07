<script lang="ts">
/**
 * Proximity-faded scroll thumb for the editor scroll container.
 *
 * Replaces the native scrollbar, which `scroll-fade.css` hides on this element.
 * The thumb has no track behind it and its opacity is a function of how close
 * the cursor is; it is grabbable to scrub. See `scroll-pill.ts` for the math and
 * `scroll-pill.css` for who owns the native bar.
 *
 * MOUNT POINT — must be a SIBLING of `.editor-scroll`, inside
 * `.editor-column-wrap`, never a child of the scroller. Two reasons, both
 * silent if violated: `scroll-fade.css` applies a `mask-image` fade to the
 * scroller's painted content, which would eat the thumb at the top and bottom
 * 24px of travel; and a child of the scroller scrolls with the document.
 *
 * NO `z-index` — deliberately. `.editor-column-wrap` is `position: relative`
 * with `z-index: auto`, so it establishes NO stacking context and any value
 * declared here would compete app-wide against the rails in the shared parent
 * context (pinned rail = 1, hover-floated rail = `--tandem-z-rail-float` = 5).
 * A 6px thumb painting over the floating annotations panel is the failure mode.
 * As a positioned LATER sibling of `.editor-scroll` the pill already paints
 * above the document by DOM order, which is all it needs.
 *
 * REACTIVITY — this component holds zero `$state` and one `$effect`. Every
 * per-frame value is written straight to the DOM. That is not a shortcut around
 * Svelte; it is required. Routing pointer coordinates through the reactive
 * graph would re-render on every mouse pixel, and gating the thumb's existence
 * on a `$state` boolean written from the same effect that reads `bind:this`
 * would be the `feedback_svelte_state_bind_this_loop` cycle that INVARIANT 1 in
 * `App.svelte` exists to prevent. The thumb is always mounted and toggled with
 * `display`, matching the always-mounted/CSS-toggle precedent used for the
 * panels and rails.
 *
 * ACCESSIBILITY — `aria-hidden`, no `role="scrollbar"`, no tab stop. A
 * scrollbar role that is not focusable with arrow/Page/Home/End handling is
 * worse than no role (APG), and a redundant tab stop next to `role="main"` is
 * the same trade `App.svelte` already refuses for the edge-collapse strips.
 * Known gap, pre-existing and NOT introduced here: `.editor-scroll` carries no
 * `tabindex`, and WebKit — the macOS desktop WebView — does not make overflow
 * scrollers implicitly focusable, so a READ-ONLY document has no keyboard
 * scroll path there. Tracked separately; it is not the pill's to fix.
 * `forced-colors` and the app's high-contrast toggle both pin the thumb to full
 * opacity (see the style block below), because `forced-colors` remaps colors but never
 * alpha — without that, a high-contrast user would have no scroll indicator at
 * all now that the native bar is gone.
 */
import { attachScrollPill } from "./scroll-pill-controller.js";

interface Props {
  /** The `.editor-scroll` element. Null until `bind:this` resolves. */
  scrollEl: HTMLElement | null;
  /**
   * Pre-narrowed to a plain boolean by the parent. Do NOT inline an expression
   * reading `activeTab` here: prop reads are getters, so the effect below would
   * subscribe to the `activeTab` `$derived`, whose identity changes whenever the
   * tab array updates for unrelated reasons — tearing down and rebuilding every
   * listener, and dropping any drag in flight.
   */
  enabled: boolean;
  reduceMotion: boolean;
}

let { scrollEl, enabled, reduceMotion }: Props = $props();

// Plain `let`, NOT `$state`: these are read inside the effect that also creates
// the listeners. As `$state` that read would re-trigger the effect on bind,
// rebuilding every listener and observer on mount.
let trackEl: HTMLDivElement | null = null;
let thumbEl: HTMLDivElement | null = null;

$effect(() => {
  // Read every dependency up front so the tracking set is exactly these four
  // and nothing the controller touches later can join it.
  const scroller = scrollEl;
  const isEnabled = enabled;
  const motionReduced = reduceMotion;
  const track = trackEl;
  const thumb = thumbEl;
  if (!scroller || !track || !thumb || !isEnabled) {
    // Not an early return with no cleanup: the component stays mounted when the
    // setting flips off, so a thumb left painted would freeze on screen.
    if (thumb) thumb.style.display = "none";
    return;
  }
  return attachScrollPill(scroller, track, thumb, { reduceMotion: motionReduced });
});
</script>

<div bind:this={trackEl} class="scroll-pill-track" data-testid="editor-scroll-pill" aria-hidden="true">
  <div bind:this={thumbEl} class="scroll-pill-thumb" data-testid="editor-scroll-pill-thumb"></div>
</div>

<style>
  .scroll-pill-track {
    position: absolute;
    /* Clears the floating formatting bar, which is `position: fixed` across the
       top of the editor column. This is the same clearance `.editor-scroll`
       gives its own content, and it also drops the track below `scroll-fade`'s
       24px mask band so a crisp thumb never sits inside a deliberately soft
       edge. */
    top: max(var(--tandem-space-7), 52px);
    /* Aligns the pill's foot with the floating status pill's baseline. The
       status bar is LEFT-anchored and truncates well outboard of here, so no
       clearance reservation is needed. */
    bottom: var(--tandem-space-3);
    /* INVARIANT: `right + width` must stay under `--tandem-space-5 + 2px` (the
       scroller's padding + border band) so the pill never enters the stage box
       and never overlaps text at a collapsed gutter. Holds at every density:
       6+12=18 < 18 compact, 8+12=20 < 26 cozy, 12+12=24 < 34 spacious. Token-
       derived on purpose — a hardcoded px would silently break if the density
       scale is retuned. */
    right: var(--tandem-space-2);
    width: 12px;
    /* Load-bearing. The track is a full-height invisible strip over the
       document's right edge; if it took pointer events it would eat text
       selection there. Only the thumb re-enables them, and only while it is
       actually visible (see `HIT_TEST_MIN_OPACITY`). */
    pointer-events: none;
    /* No background, no border, no shadow: the pill is a thumb, not a
       scrollbar. Referencing `--tandem-scrollbar-track` here would invite a
       future "restore the track" that the design explicitly rejects. */
  }

  .scroll-pill-thumb {
    position: absolute;
    top: 0;
    /* The element spans the full 12px track for a usable grab target while the
       painted bar stays 6px — see ::before. */
    left: 0;
    right: 0;
    display: none;
    opacity: var(--pill-o, 0);
    /* NO transition on opacity or transform: both are written every frame, and
       a transition on a per-frame-written property would leave
       `getAnimations()` permanently non-empty, stalling the a11y suite's
       settle() on every scan. Deliberately no `will-change` either — both are
       already compositor-only properties, and the element spends most of its
       life invisible, so a permanently promoted layer buys nothing. */
    touch-action: none;
  }

  .scroll-pill-thumb::before {
    content: "";
    position: absolute;
    /* Painted bar: 6px centred in the 12px hit area, growing to 10px on
       approach. The hit area is deliberately NOT widened past the track — a
       wider strip would reach into the text column at compact density. Touch
       is not a target here: touch scrolls by direct manipulation, and the
       proximity fade is filtered to mouse/pen. */
    inset-block: 0;
    inset-inline: 3px;
    border-radius: var(--tandem-r-pill);
    /* The same token every other scroller in the app paints its thumb from, so
       the pill reads as the scrollbar it replaces. NOT `--tandem-fg-subtle`:
       that is a text rung pinned to the WCAG AA text floor, and it already
       carries a documented warning about non-text consumers being dragged
       around by text-contrast retunes. */
    background: var(--tandem-scrollbar-thumb);
    transition: inset-inline 120ms ease, background 120ms ease;
  }

  .scroll-pill-thumb:hover::before {
    inset-inline: 1px;
    background: color-mix(in srgb, var(--tandem-scrollbar-thumb) 80%, var(--tandem-fg));
  }

  @media (prefers-reduced-motion: reduce) {
    .scroll-pill-thumb::before {
      transition: none;
    }
  }

  :global(body.tandem-reduce-motion) .scroll-pill-thumb::before {
    transition: none;
  }

  /* `forced-colors` remaps colors but NEVER alpha, so the proximity fade would
     survive into high-contrast mode and leave a HCM user with no scroll
     indicator at all — the native bar is gone by then. Pin it visible. The
     custom-property indirection above is what lets this win without
     `!important` against the per-frame inline write. */
  @media (forced-colors: active) {
    .scroll-pill-thumb {
      opacity: 1;
    }
    .scroll-pill-thumb::before {
      background: ButtonText;
      border: 1px solid Canvas;
      forced-color-adjust: none;
    }
  }

  /* Same reasoning for the in-app high-contrast toggle: someone who has opted
     into it is asking for persistent, unambiguous affordances. */
  :global(html[data-high-contrast="true"]) .scroll-pill-thumb {
    opacity: 1;
  }

  /* Set on `<body>` for a drag's duration. `preventDefault` on pointerdown
     already suppresses selection-start in all three engines; what it cannot do
     is stop the cursor flipping to an I-beam as the drag crosses the text
     column, which is what this is for. */
  :global(body.tandem-scroll-pill-dragging) {
    cursor: grabbing;
    user-select: none;
    -webkit-user-select: none;
  }
</style>
