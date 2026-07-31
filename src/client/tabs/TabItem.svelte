<script lang="ts">
import { Y_MAP_DOCUMENT_META, Y_MAP_SAVED_AT_VERSION } from "../../shared/constants.js";
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
// These don't drive UI; plain let keeps them non-reactive
let editCount = 0;
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
    editCount = 0;
    dirty = false;
  }, 500);

  const onFragmentChange = () => {
    if (!armed) return;
    editCount++;
    dirty = true;
  };
  fragment.observeDeep(onFragmentChange);

  const onMetaChange = () => {
    if (!armed) return;
    const saved = meta.get(Y_MAP_SAVED_AT_VERSION) as number | undefined;
    if (saved !== undefined && saved !== baseline) {
      baseline = saved;
      editCount = 0;
      dirty = false;
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
// surface fill + subtle border; inactive tabs stay transparent. Drop-indicator
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
    `background: ${isActive ? "var(--tandem-surface)" : "transparent"}`,
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
    // both tokens but NOT --a30-shadow, so the tab still arrives instantly
    // while the shadow keeps its crossfade.
    `transition: background 0.15s, color 0.15s, border-color 0.15s, box-shadow var(--a30-shadow) var(--tandem-ease-out), transform ${
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
  data-testid={`tab-${tab.id}`}
  data-active={isActive}
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
         which pins every tab to the floor). -->
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

  <button
    bind:this={closeBtn}
    onclick={(e) => {
      e.stopPropagation();
      onclose(tab.id);
    }}
    onpointerdown={(e) => e.stopPropagation()}
    onmouseenter={handleMouseEnterClose}
    onmouseleave={handleMouseLeaveClose}
    style="background: none; border: none; cursor: pointer; font-size: var(--tandem-text-md); line-height: 1; color: var(--tandem-fg-muted); padding: 0 2px; border-radius: var(--tandem-r-1);"
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

     Deliberately QUIETER than the house ring, and quieter than the `+` pill
     beside it (DocumentTabs `.tab-add-pill`, which uses the full
     `--tandem-accent`): a tab is chrome you look past, not a control you aim
     at, and the ring's most common trigger is cancelling a drag — a moment
     where a loud outline reads as an error report on an action that succeeded.
     `--tandem-accent-border` is the palette's own accent-family border token,
     so this stays a tokenized decision rather than a one-off tint.

     Two things it must NOT become. Not `--tandem-border`: that is the active
     tab's own border colour, so a focused inactive tab would be hard to tell
     from the active one. Not `outline: none`, and not a blur() on the Escape
     path — both were tried; blurring leaves activeElement on BODY (measured),
     stripping the indicator at the exact moment the user reached for the
     keyboard and taking Alt+Arrow reorder with it.

     KNOWN TRADE, made deliberately (Bryan, 2026-07-31): at ~1.4:1 against the
     strip this sits under the 3:1 WCAG 1.4.11 asks of a focus indicator.
     `--tandem-accent` (~4:1) is the conformant value if that is ever revisited;
     the E2E below pins whichever token is chosen, so swapping is a one-line
     change in two places.

     The 1px offset is a constraint, not taste: 3px total reach against the
     scroller's 6px padding clears the pill without meeting the
     `overflow-y: hidden` edge that clips the drag lift's shadow. */
  [role="tab"]:focus-visible {
    outline: 2px solid var(--tandem-accent-border);
    outline-offset: 1px;
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
