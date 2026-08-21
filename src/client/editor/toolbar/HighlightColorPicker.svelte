<script lang="ts">
import { HIGHLIGHT_COLOR_VARS } from "../../../shared/constants";
import type { HighlightColor } from "../../../shared/types";
import { onOutsideEvent } from "../../utils/dismiss-outside";
import { ESCAPE_OWNER_ATTR } from "../../utils/escape-owner";
import { onKeyActivate } from "./handlers.js";
import ToolbarButton from "./ToolbarButton.svelte";

const HIGHLIGHT_COLOR_OPTIONS: Array<{ value: HighlightColor; label: string }> = [
  { value: "yellow", label: "Yellow" },
  { value: "green", label: "Green" },
  { value: "blue", label: "Blue" },
  { value: "pink", label: "Pink" },
];

interface Props {
  disabled?: boolean;
  onHighlight: (color: HighlightColor) => void;
}

const { disabled = false, onHighlight }: Props = $props();

let highlightColor = $state<HighlightColor>("yellow");
let showColorPicker = $state(false);
let colorPickerEl = $state<HTMLDivElement | null>(null);
let toggleEl = $state<HTMLButtonElement | null>(null);

$effect(() => {
  if (!showColorPicker) return;
  return onOutsideEvent(
    () => colorPickerEl,
    ["mousedown"],
    () => {
      showColorPicker = false;
    },
    { capture: false },
  );
});

function handleHighlight(e: MouseEvent) {
  e.preventDefault();
  onHighlight(highlightColor);
}

function handleColorPickerToggle(e: MouseEvent) {
  e.preventDefault();
  showColorPicker = !showColorPicker;
}

/**
 * Focus returns to the trigger on every DELIBERATE dismissal. This PR is what
 * makes the menu keyboard-reachable, and the `{#if}` unmounts the focused
 * button, so without this `activeElement` falls to `<body>` and the next Tab
 * restarts from the top of the document. Matches `DecorationsMenu.closeMenu()`.
 *
 * The outside-mousedown path deliberately does NOT call this: yanking focus
 * back to the toolbar when the user clicked elsewhere would be wrong.
 */
function closePicker() {
  showColorPicker = false;
  toggleEl?.focus();
}

function handleColorSelect(color: HighlightColor) {
  highlightColor = color;
  closePicker();
}
</script>

<!-- This PR makes the picker keyboard-OPENABLE (the trigger previously had only
     `onmousedown`), so it also has to be keyboard-dismissable. Two non-obvious
     pieces make that work:
       - Escape only reaches this bubble-phase handler because the selection
         popup's capture-phase `window` listener yields to a subtree carrying
         ESCAPE_OWNER_ATTR (see utils/escape-owner.ts and Toolbar.svelte). The
         heading menu, link editor and decorations menu claim it the same way.
       - `focusout` is the dismissal for the keyboard path that Escape cannot
         cover: the picker is otherwise only closed by an outside *mousedown*,
         so a keyboard user who Tabs past it would leave it mounted — and a
         mounted popover pins the whole bar at --tandem-z-toast via
         FormattingBar's `:has([aria-expanded="true"])` rule. -->
<div
  class="highlight-picker-wrap"
  {...(showColorPicker ? { [ESCAPE_OWNER_ATTR]: "" } : {})}
  onkeydown={(e) => {
    if (e.key !== "Escape" || !showColorPicker) return;
    e.stopPropagation();
    closePicker();
  }}
  onfocusout={(e) => {
    if (!showColorPicker) return;
    // A `null` relatedTarget (window blur, focus dropped to <body>) is
    // deliberately ignored — only a focus move to a real element OUTSIDE the
    // wrap counts as leaving the popover.
    const next = e.relatedTarget;
    if (next instanceof Node && !e.currentTarget.contains(next)) showColorPicker = false;
  }}
  role="presentation"
>
  <ToolbarButton
    label="Highlight"
    testId="toolbar-highlight-btn"
    {disabled}
    disabledTitle="Select text first"
    onMouseDown={handleHighlight}
    onClick={onKeyActivate(handleHighlight)}
  />
  <!-- `aria-expanded` is dropped while disabled: a selection can collapse while
       the menu is open, and publishing aria-expanded="true" on a disabled button
       keeps FormattingBar's `:has([aria-expanded="true"])` rule matching, which
       pins the whole bar at --tandem-z-toast. Dropping the attribute closes that
       without adding a dismissal path a transient selection blip could trip. -->
  <button
    bind:this={toggleEl}
    type="button"
    class="highlight-swatch-toggle"
    data-testid="toolbar-highlight-color-toggle"
    {disabled}
    aria-haspopup="menu"
    aria-expanded={disabled ? undefined : showColorPicker}
    onmousedown={handleColorPickerToggle}
    onclick={onKeyActivate(handleColorPickerToggle)}
    title="Choose highlight color"
    aria-label="Choose highlight color"
  >
    <span
      class="highlight-swatch-preview"
      style="background: {HIGHLIGHT_COLOR_VARS[highlightColor]};"
    ></span>
  </button>
  {#if showColorPicker}
    <!-- The trigger advertises `aria-haspopup="menu"`, so this has to actually
         be one. Single-select level picker → `menuitemradio` + `aria-checked`,
         mirroring the heading dropdown in FormattingToolbar, which has the
         identical shape. -->
    <div
      bind:this={colorPickerEl}
      class="highlight-picker-popover"
      role="menu"
      aria-label="Highlight color"
    >
      <!-- The radio set gets its own group so set-size/position-in-set are
           computed over the four colours alone; the close command is a sibling,
           not a fifth "colour". -->
      <div role="group" aria-label="Highlight color" class="highlight-picker-swatches">
        {#each HIGHLIGHT_COLOR_OPTIONS as { value, label } (value)}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={value === highlightColor}
            data-testid={`toolbar-highlight-color-${value}`}
            title={label}
            aria-label={label}
            onclick={() => handleColorSelect(value)}
            class="highlight-picker-swatch"
            class:is-selected={value === highlightColor}
          >
            <span
              class="highlight-picker-swatch-inner"
              style="background: {HIGHLIGHT_COLOR_VARS[value]};"
            ></span>
            <svg
              class="highlight-picker-swatch-check"
              width="10"
              height="10"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M5 11l3 3 7-9" />
            </svg>
          </button>
        {/each}
      </div>
      <button
        type="button"
        role="menuitem"
        data-testid="color-picker-close"
        title="Close"
        aria-label="Close color picker"
        onclick={closePicker}
        class="highlight-picker-close"
      >
        ✕
      </button>
    </div>
  {/if}
</div>

<style>
  .highlight-picker-wrap {
    display: flex;
    align-items: center;
    gap: 1px;
    position: relative;
  }
  .highlight-swatch-toggle {
    height: 26px;
    padding: 0 6px;
    border: 1px solid transparent;
    border-radius: var(--tandem-r-pill);
    background: transparent;
    color: var(--tandem-fg-muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    transition: background 120ms, color 120ms;
  }
  /* Reduced motion: literal 120ms tweens, no timing token to zero. Dual guard:
     the in-app `body.tandem-reduce-motion` (class on <body>, so :global(...))
     AND the OS pref, media half last so it wins the specificity tie. */
  :global(body.tandem-reduce-motion) .highlight-swatch-toggle {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .highlight-swatch-toggle {
      transition: none;
    }
  }
  .highlight-swatch-toggle:hover:not(:disabled) {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
  }
  .highlight-swatch-toggle:disabled {
    cursor: not-allowed;
  }
  /* One ring for every focusable control this component owns. The popover's
     items only became keyboard-reachable in #1304, so their omission from this
     list was newly load-bearing — a UA default ring lands on a 20px saturated
     fill and, on the selected swatch, competes with `.is-selected`'s own ring. */
  .highlight-swatch-toggle:focus-visible,
  .highlight-picker-swatch:focus-visible,
  .highlight-picker-close:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 1px;
  }
  .highlight-swatch-preview {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: var(--tandem-r-1);
    border: 1px solid var(--tandem-border);
  }
  /* Right-aligned, so it unfurls leftward into the track (#1302). Single
     consumer today (FormattingBar), and this alignment is chosen for that host's
     geometry — a second mount site is a reason to re-check it, not to copy it.
     There, this control is the last item in the clipped track and its wrap ends
     flush with the track's right edge, so a `left: 0` popover overhangs the
     horizontal clip and loses its rightmost controls. Opening leftward keeps the
     whole popover inside the clipped box, and wins in the truncated case too
     (the wrap is what gets pushed past the edge, so a right-aligned popover
     keeps more of itself visible, not less). The horizontal clip is deliberate —
     it is what truncates the toolbar on narrow windows; only the vertical axis
     was widened to `visible`. */
  .highlight-picker-popover {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 8px;
    background: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-4);
    padding: 6px;
    display: flex;
    gap: 4px;
    align-items: center;
    z-index: var(--tandem-z-dropdown);
    box-shadow: var(--tandem-shadow-2);
  }
  /* Top-pointing caret — two stacked triangles for a crisp 1px border edge:
     ::before paints the border-colored caret, ::after overlays the surface-
     colored caret 1px lower to mask the bottom edge. */
  .highlight-picker-popover::before,
  .highlight-picker-popover::after {
    content: "";
    position: absolute;
    /* Mirrors the popover's right alignment above so the caret still points at
       the swatch toggle, which is the rightmost control in the wrap. */
    right: 12px;
    border: 5px solid transparent;
  }
  .highlight-picker-popover::before {
    bottom: 100%;
    border-bottom-color: var(--tandem-border);
  }
  .highlight-picker-popover::after {
    bottom: calc(100% - 1px);
    border-bottom-color: var(--tandem-surface);
  }
  /* Layout-neutral: reproduces the popover's own flex row so wrapping the radio
     set in a group for AT changes nothing visually. */
  .highlight-picker-swatches {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .highlight-picker-swatch {
    position: relative;
    width: 24px;
    height: 24px;
    border-radius: var(--tandem-r-2);
    border: 1.5px solid transparent;
    background: transparent;
    cursor: pointer;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: transform 100ms, box-shadow 100ms, border-color 100ms;
  }
  /* Reduced motion: the hover scale is the loudest thing in this component — kill
     the whole shorthand so the swatch snaps to its hover/selected state instead
     of springing. Same dual guard. */
  :global(body.tandem-reduce-motion) .highlight-picker-swatch {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .highlight-picker-swatch {
      transition: none;
    }
  }
  .highlight-picker-swatch-inner {
    display: block;
    width: 20px;
    height: 20px;
    border-radius: var(--tandem-r-1);
  }
  .highlight-picker-swatch:hover:not(.is-selected) {
    border-color: var(--tandem-border);
    transform: scale(1.12);
    box-shadow: var(--tandem-shadow-1);
  }
  .highlight-picker-swatch.is-selected {
    border-color: var(--tandem-border-strong);
    box-shadow:
      0 0 0 2px var(--tandem-accent-bg),
      0 0 0 3.5px var(--tandem-accent);
  }
  .highlight-picker-swatch.is-selected:hover {
    transform: scale(1.06);
  }
  .highlight-picker-swatch-check {
    position: absolute;
    color: var(--tandem-fg);
    pointer-events: none;
    opacity: 0;
    transition: opacity 100ms;
  }
  /* Reduced motion: the check's fade is state feedback, so it must still appear —
     `none` shows it instantly rather than suppressing it. Same dual guard. */
  :global(body.tandem-reduce-motion) .highlight-picker-swatch-check {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .highlight-picker-swatch-check {
      transition: none;
    }
  }
  .highlight-picker-swatch.is-selected .highlight-picker-swatch-check {
    opacity: 1;
  }
  .highlight-picker-close {
    width: 24px;
    height: 24px;
    border-radius: var(--tandem-r-2);
    border: 1px solid var(--tandem-border);
    background: var(--tandem-surface-muted);
    cursor: pointer;
    padding: 0;
    font-size: 13px;
    color: var(--tandem-fg-muted);
    display: flex;
    align-items: center;
    justify-content: center;
  }
</style>
