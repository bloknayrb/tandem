<script lang="ts">
import type * as Y from "yjs";
import {
  Y_MAP_DIRTY,
  Y_MAP_DOCUMENT_META,
  Y_MAP_SAVED_AT_VERSION,
} from "../../shared/constants.js";
import { isRenamable, type OpenTab } from "../types.js";
import TabRenameInput from "./TabRenameInput.svelte";
// A30 (tab reorder drag): --a30-lift / --a30-shadow / --a30-lift-shadow, plus
// the reduced-motion token-zeroing. Imported here as well as in DocumentTabs
// because an undefined custom property inside the `transition` shorthand below
// invalidates the WHOLE declaration — the pill's background/color/border
// transitions would go with it.
import "./tabDragMotion.css";

interface Props {
  tab: OpenTab;
  isActive: boolean;
  onswitch: (id: string) => void;
  onclose: (id: string) => void;
  onpointerdown: (e: PointerEvent, id: string) => void;
  dropIndicator: "left" | "right" | null;
  /**
   * A30: this tab is the one being dragged and the transform layer is live.
   * Mutually exclusive with `dropIndicator` by construction — DocumentTabs
   * renders the indicator only in degraded mode, where nothing lifts and
   * nothing parts, so the two feedback languages never overlap.
   */
  lifted?: boolean;
  onkeydown: (e: KeyboardEvent, id: string) => void;
  /** True when THIS tab is in inline-rename mode (#1017). Container-owned. */
  isRenaming?: boolean;
  /** Request to enter rename mode for this tab (double-click on the name). */
  onstartrename?: (id: string) => void;
  /** Commit a rename: new basename for this tab. */
  onrename?: (id: string, newName: string) => void;
  /** Cancel rename mode (Escape / blur). */
  onrenamecancel?: () => void;
}

const {
  tab,
  isActive,
  onswitch,
  onclose,
  onpointerdown,
  dropIndicator,
  lifted = false,
  onkeydown,
  isRenaming = false,
  onstartrename,
  onrename,
  onrenamecancel,
}: Props = $props();

// Only real on-disk files are renamable; scratchpads/uploads use Save As, and
// read-only docs (incl. .docx) can't be renamed. Mirrors the server gate.
const canRename = $derived(isRenamable(tab));

// ---- useTabDirty logic inlined (hooks can't be imported into Svelte) ----
let dirty = $state(false);
// Doesn't drive UI; plain let keeps it non-reactive.
let baseline: number | null = null;

$effect(() => {
  // Track tab.ydoc and tab.readOnly
  const { ydoc, readOnly } = tab;

  if (readOnly) {
    dirty = false;
    return;
  }

  const fragment = ydoc.getXmlFragment("default");
  const meta = ydoc.getMap(Y_MAP_DOCUMENT_META);

  let armed = false;
  const armTimer = setTimeout(() => {
    armed = true;
    baseline = (meta.get(Y_MAP_SAVED_AT_VERSION) as number) ?? 0;
    // #1447: the arm-time baseline is the SERVER's authoritative unsaved flag,
    // not a hardcoded false. The reset itself is still required — without it the
    // initial CRDT sync reads as a user edit and every tab opens dirty — but
    // resetting to a literal made a pre-attach MCP edit indistinguishable from a
    // clean load, because to the client they are the same bytes in the same
    // sync. An absent key (no dirty observer, scratchpad, older server) reads as
    // clean, i.e. exactly the pre-#1447 behaviour.
    dirty = meta.get(Y_MAP_DIRTY) === true;
  }, 500);

  const onFragmentChange = () => {
    if (!armed) return;
    dirty = true;
  };
  fragment.observeDeep(onFragmentChange);

  const onMetaChange = (event: Y.YMapEvent<unknown>) => {
    if (!armed) return;

    // #1447: the server owns Y_MAP_DIRTY, so follow it in BOTH directions — but
    // only when THIS transaction actually wrote the key. documentMeta carries
    // several unrelated keys (externalConflict, fidelityReport, readOnly,
    // fileName/format, openDocuments), and this observer fires on all of them;
    // reading the key as a LEVEL on every meta write would re-assert a stale
    // value and latch the tab. `keysChanged` makes it an edge, matching the
    // sibling observer in hooks/yjsSync.svelte.ts.
    //
    // Following the `false` edge is NOT unconditionally safe, and the window is
    // accepted rather than closed: autosave completes and publishes `false`;
    // before it arrives the user types and `onFragmentChange` sets `dirty = true`;
    // the in-flight `false` then lands and blanks the dot over a genuinely
    // unsaved keystroke. It self-corrects when that keystroke reaches the server
    // and republishes `true` — bounded by one loopback round trip — and the
    // server's own markCleanIfUnchanged guard already covers edits that arrive
    // before the write finishes, so nothing is lost, only briefly mis-drawn.
    // Suppressing it would mean tracking "has the fragment observer fired since
    // the last mirror event", which is more state than a sub-RTT blip warrants.
    // Going one-directional instead is worse: it leaves a stale mirror
    // unclearable and latches every scratchpad tab permanently dirty.
    if (event.keysChanged.has(Y_MAP_DIRTY)) {
      const mirrored = meta.get(Y_MAP_DIRTY);
      if (typeof mirrored === "boolean") dirty = mirrored;
    }

    const saved = meta.get(Y_MAP_SAVED_AT_VERSION) as number | undefined;
    if (saved !== undefined && saved !== baseline) {
      // Always re-baseline, but clear only if the server agrees the doc is
      // clean. `saveDocumentToDisk` writes savedAtVersion BEFORE calling
      // markCleanIfUnchanged, and that call keeps the doc dirty when a body edit
      // landed during the async write — so an unconditional clear here shows a
      // clean tab over unpersisted edits. An absent key is `undefined !== true`,
      // so a server without the mirror clears exactly as it did before.
      baseline = saved;
      if (meta.get(Y_MAP_DIRTY) !== true) dirty = false;
    }
  };
  meta.observe(onMetaChange);

  return () => {
    clearTimeout(armTimer);
    fragment.unobserveDeep(onFragmentChange);
    meta.unobserve(onMetaChange);
  };
});

// ---- A2 save-confirmation flash (#798) ----
// On a dirty→clean transition (a save), briefly mount a check mark. Mount-gating
// the check span ({#if justSaved}) re-fires its CSS animation on every save. The
// clear runs UNCONDITIONALLY on every non-save edge — including an edit, AND the
// coalesced case where a dirty→clean edge is batched away — so a stale check can
// never strand (the A9 stranding class). A coalesced save's flash is skipped
// (invisible) rather than stranding a stuck check (a visible bug).
const SAVE_CONFIRM_MS = 600;
let justSaved = $state(false);
// Mirrors `dirty`'s initial value; plain let (effect-internal edge bookkeeping,
// must not be reactive). Initialized literally to avoid reading the rune here.
let prevDirty = false;

$effect(() => {
  const was = prevDirty;
  prevDirty = dirty;
  if (!dirty && was) {
    justSaved = true;
    const t = setTimeout(() => {
      justSaved = false;
    }, SAVE_CONFIRM_MS);
    return () => clearTimeout(t);
  }
  justSaved = false;
});

// Derived styles. v7 floating chrome (Wave 4b minimal): drop the rectangular
// tab + accent-underline pattern in favor of a soft pill. Active tab gets a
// surface fill + subtle border; inactive tabs use an opaque muted surface so
// editor content never shows through while a tab is dragged or displaced. Drop-indicator
// borders are kept on left/right only (vertical wedges) — bottom underline
// removed since the pill no longer reads as a "tab attached to a strip".
const tabStyle = $derived(
  [
    "display: flex",
    "align-items: center",
    "gap: 6px",
    "padding: 0 10px 0 12px",
    "height: 26px",
    "font-size: var(--tandem-text-sm)",
    "cursor: pointer",
    `background: ${isActive ? "var(--tandem-surface)" : "var(--tandem-surface-muted)"}`,
    `color: ${isActive ? "var(--tandem-fg)" : "var(--tandem-fg-subtle)"}`,
    `border: 1px solid ${isActive ? "var(--tandem-border)" : "transparent"}`,
    `border-left: ${dropIndicator === "left" ? "2px solid var(--tandem-accent)" : isActive ? "1px solid var(--tandem-border)" : "2px solid transparent"}`,
    `border-right: ${dropIndicator === "right" ? "2px solid var(--tandem-accent)" : isActive ? "1px solid var(--tandem-border)" : "2px solid transparent"}`,
    "border-radius: var(--tandem-r-pill)",
    // A30 lift. The pill carries the lift; the `.tab-flip` wrapper outside it
    // carries the translateX that tracks the pointer. Two elements, two
    // transforms — the wrapper's has to stay on the FLIP host (that is what
    // makes `animate:flip` measure the tab mid-air and settle it for free), and
    // multiplying the lift into it would make the tab grow as it travelled.
    `transform: ${lifted ? "translateY(-5px) scale(1.04)" : "none"}`,
    `box-shadow: ${
      lifted
        ? "var(--a30-lift-shadow)"
        : isActive
          ? "var(--tandem-shadow-1)"
          : "0 1px 3px rgba(0, 0, 0, 0.08)"
    }`,
    "user-select: none",
    "touch-action: none",
    "white-space: nowrap",
    // The target state owns the transition (the A29 convention): picking up
    // runs at --a30-lift, putting down at --a30-settle. Reduced motion zeroes
    // those two and --a30-chrome, but NOT --a30-shadow, so the tab and its
    // chrome both arrive instantly while the shadow keeps its crossfade.
    //
    // Every duration here is a token for a reason (#1530): this is one inline
    // shorthand, so a `body.tandem-reduce-motion` rule could only replace it
    // wholesale with `!important` — which would zero the shadow crossfade
    // tabDragMotion.css deliberately keeps. Zeroing the tokens is the only way
    // to reach some terms and not others.
    `transition: background var(--a30-chrome), color var(--a30-chrome), border-color var(--a30-chrome), box-shadow var(--a30-shadow) var(--tandem-ease-out), transform ${
      lifted ? "var(--a30-lift)" : "var(--a30-settle)"
    } var(--tandem-ease-out)`,
    // Shrinkable so a crowded strip narrows its tabs before it starts scrolling.
    // `min-width: 0` is required: left at `auto` this pill's minimum would be
    // its own min-content — which includes the name span's full text width — and
    // a long-named tab could never give a pixel back. The compression floor
    // deliberately lives one level up on `.tab-flip` in DocumentTabs, because a
    // floor here would be shrunk past by that wrapper and the pill would overflow
    // it. See the `.tab-flip` comment for the full rule.
    // `flex-grow: 1` fills the `.tab-flip` wrapper. It matters wherever the
    // wrapper is wider than this pill's content — under `uniformTabWidth` every
    // tab is pinned to 142px, so a short name ("todo.md") would otherwise sit
    // inside its slot leaving a ragged gap before the next tab.
    "flex: 1 1 auto",
    "min-width: 0",
  ].join("; "),
);

let closeBtn: HTMLButtonElement | undefined = $state();

function handleMouseEnterClose() {
  if (closeBtn) closeBtn.style.color = "var(--tandem-error)";
}
function handleMouseLeaveClose() {
  if (closeBtn) closeBtn.style.color = "var(--tandem-fg-muted)";
}
</script>

<!--
  The WAI-ARIA APG closable tabs pattern places the close button inside role="tab".
  axe's nested-interactive rule fires on this pattern; it is suppressed in the a11y spec
  with justification (see tests/e2e/accessibility.spec.ts).
-->
<!-- svelte-ignore a11y_interactive_supports_focus -->
<div
  class="tab-pill"
  data-testid={`tab-${tab.id}`}
  data-active={isActive}
  data-lifted={lifted}
  role="tab"
  tabindex={0}
  aria-selected={isActive}
  aria-label={tab.fileName}
  style={tabStyle}
  onclick={() => onswitch(tab.id)}
  onpointerdown={(e) => onpointerdown(e, tab.id)}
  onkeydown={(e) => onkeydown(e, tab.id)}
>
  <!-- Stable fixed-width slot: always in layout so dot/check/empty never shift the
       tab. dirty → ● (warning); just-saved → ✓ (success, A2 morph); else empty. -->
  <span
    data-testid={`unsaved-indicator-${tab.id}`}
    class="save-indicator"
    aria-hidden={!dirty}
  >
    {#if dirty}
      <span class="dot" aria-hidden="true">●</span>
    {:else if justSaved}
      <span class="saved-check" aria-hidden="true">✓</span>
    {/if}
  </span>

  {#if isRenaming}
    <TabRenameInput
      initial={tab.fileName}
      testId={`tab-rename-input-${tab.id}`}
      oncommit={(value) => onrename?.(tab.id, value)}
      oncancel={() => onrenamecancel?.()}
    />
  {:else}
    <!-- Double-click the name to rename (file docs only). The wrapper is a
         presentational span; dblclick (not a focusable control) carries the
         affordance, mirroring the editor's double-click-to-select-word idiom. -->
    <!-- `min-width: 0` is what lets a crowded strip compress: it drops this
         span's min-content contribution to zero so `.tab-flip`'s floor (not the
         filename) decides how small a tab can get, and the name ellipsizes on
         the way down. That floor is also what preserves the ~80px of readable
         filename this span's own `min-width` used to be credited with — don't
         reintroduce one here, it would re-pin long tabs at their full text
         width. It is also precisely why the adaptive floor has to be MEASURED
         in DocumentTabs: with a zero minimum, this filename never reaches the
         wrapper's min-content, so no CSS can express "floor at my own natural
         width". `max-width` is the opposite end: the most filename a tab shows
         when the strip has width to spare (unreachable under `uniformTabWidth`,
         which pins every tab to the floor).

         `flex-grow` belongs on that prohibited list too, and is the tempting
         one: adding it here would neatly absorb the slack a short name leaves
         inside a uniform-mode pill (#1736) — and would silently collapse
         ADAPTIVE mode into uniform, because `measureTabFloor` reads this
         span's natural width as `scrollWidth`, which reports a grown BOX.
         `tab-floor.ts` states the mechanism in full at that read. The slack is
         absorbed by an auto margin on the close button below instead. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <span
      data-testid={`tab-name-${tab.id}`}
      title={canRename ? `${tab.filePath} — double-click or F2 to rename` : tab.filePath}
      style={`font-weight: ${isActive ? 500 : 400}; min-width: 0; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`}
      ondblclick={(e) => {
        if (!canRename) return;
        e.stopPropagation();
        onstartrename?.(tab.id);
      }}
    >
      {tab.fileName}
    </span>
  {/if}

  {#if tab.readOnly}
    <span
      class="tab-ro-badge"
      aria-label="Read-only"
    >
      RO
    </span>
  {/if}

  <!-- `margin-left: auto` pins this button to the pill's right padding (#1736).
       Under `uniformTabWidth` the wrapper is pinned to 142px and the pill fills
       it, so a short name leaves slack inside the pill; with every child at
       `flex-grow: 0` and `justify-content` at its default `flex-start`, that
       slack parked after the LAST child — this button — leaving ~38px of void
       between the × and the tab's right edge.

       An auto margin rather than growing the name span, because it is the only
       sink `measureTabFloor` cannot see: auto margins resolve AFTER flex
       grow/shrink, so at the adaptive floor the free space is 0 and this
       collapses to 0, and they count as 0 for intrinsic sizing. See the name
       span's comment above, and `tab-floor.ts` for what growing it would break.

       This RELOCATES the whitespace rather than removing it: the gap now sits
       between the filename (or the RO badge) and the ×, which is the
       conventional browser-tab layout and keeps the RO badge beside the name
       it describes. -->
  <button
    bind:this={closeBtn}
    onclick={(e) => {
      e.stopPropagation();
      onclose(tab.id);
    }}
    onpointerdown={(e) => e.stopPropagation()}
    onmouseenter={handleMouseEnterClose}
    onmouseleave={handleMouseLeaveClose}
    style="background: none; border: none; cursor: pointer; font-size: var(--tandem-text-md); line-height: 1; color: var(--tandem-fg-muted); padding: 0 2px; border-radius: var(--tandem-r-1); margin-left: auto;"
    title="Close document"
    aria-label={`Close ${tab.fileName}`}
  >
    ×
  </button>
</div>

<style>
  /* The pill had no app-level focus style, so a keyboard interaction fell
     through to Chromium's default ring — a heavy black outline that reads as an
     error state on this surface. A30 made that visible: pointerdown focuses the
     tab, and cancelling the drag with Escape flips :focus-visible on, so the
     ring lands on the tab you just watched fly home.

     Deliberately far quieter than the house ring, and quieter than the `+` pill
     beside it (DocumentTabs `.tab-add-pill`, which uses the full
     `--tandem-accent`): a tab is chrome you look past, not a control you aim
     at, and the ring's most common trigger is cancelling a drag — a moment
     where a loud outline reads as an error report on an action that succeeded.
     Picked from four rendered candidates (accent / accent-border / border /
     1px accent-border) rather than chosen on paper.

     TWO KNOWN TRADES, both made deliberately with the alternatives on screen
     (Bryan, 2026-07-31) — do not "fix" either without asking:

     1. CONTRAST. `--tandem-border` is the *quietest* of the four and sits well
        under the 3:1 WCAG 1.4.11 asks of a focus indicator. `--tandem-accent`
        (~4:1) is the conformant value; `--tandem-accent-border` (~1.4:1) is the
        middle option. The E2E below pins whichever token is in force, so moving
        between them is one line here and one there.
        Narrower than it looks, though: `index.html`'s `forced-colors: active`
        block remaps `--tandem-border` to `CanvasText`, so under Windows High
        Contrast this ring is the maximum-contrast foreground automatically. The
        quiet version reaches only users who have NOT asked the OS for high
        contrast — which is why the token indirection matters here and a
        hardcoded colour would have been the wrong shape even at the same hue.
     2. SHARED COLOUR WITH THE ACTIVE TAB. This is the same token the active
        pill uses for its own border (see `tabStyle` above), so a focused
        inactive tab and the active tab are close in colour. They stay
        separable by geometry rather than hue: this is 2px at a 1px OFFSET
        (outside the pill), the active border is 1px ON it.

     What it must NOT become: `outline: none`, or a blur() on the Escape path.
     Both were tried — blurring leaves activeElement on BODY (measured, not
     assumed), stripping the indicator at the exact moment the user reached for
     the keyboard and taking Alt+Arrow reorder with it.

     The 1px offset is a constraint, not taste: 3px total reach against the
     scroller's 6px padding clears the pill without meeting the
     `overflow-y: hidden` edge that clips the drag lift's shadow. */
  [role="tab"]:focus-visible {
    outline: 2px solid var(--tandem-border);
    outline-offset: 1px;
  }

  @media (forced-colors: active) {
    .tab-pill {
      forced-color-adjust: auto;
      background: Canvas !important;
      border-color: ButtonText !important;
    }
    .tab-pill[data-active="true"] {
      background: ButtonFace !important;
      outline: 2px solid Highlight;
      outline-offset: 0;
    }
    .tab-pill:focus-visible {
      outline-color: Highlight;
      outline-offset: 1px;
    }
  }

  /* A2 (#798): fixed-width slot keeps the tab from shifting as the indicator
     swaps between the unsaved dot, the save-confirm check, and empty. */
  .save-indicator {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 12px;
    flex-shrink: 0;
    font-size: 10px;
    line-height: 1;
  }
  .save-indicator .dot {
    color: var(--tandem-warning);
  }
  .save-indicator .saved-check {
    color: var(--tandem-success);
    font-size: 11px;
    /* Class-referenced keyframe — Svelte rewrites both names under scoping, so
       no :global needed here (unlike an inline-style animation reference). */
    animation: tab-save-confirm 600ms var(--tandem-ease-out);
  }
  @keyframes tab-save-confirm {
    0% {
      opacity: 0;
      transform: scale(0.4);
    }
    30% {
      opacity: 1;
      transform: scale(1);
    }
    70% {
      opacity: 1;
      transform: scale(1);
    }
    100% {
      opacity: 0;
      transform: scale(0.9);
    }
  }
  /* Dual reduced-motion guard: OS-level media query AND the in-app body class
     (the body class MUST be :global — a scoped body selector gets hashed and
     silently fails, the A9 bite). */
  @media (prefers-reduced-motion: reduce) {
    .save-indicator .saved-check {
      animation: none;
    }
  }
  :global(body.tandem-reduce-motion) .save-indicator .saved-check {
    animation: none;
  }

  .tab-ro-badge {
    font-family: var(--tandem-font-mono);
    font-size: 9.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--tandem-fg-faint);
    background: color-mix(in srgb, var(--tandem-fg) 5%, transparent);
    padding: 1px 5px;
    border-radius: var(--tandem-r-1);
    flex-shrink: 0;
  }
</style>
