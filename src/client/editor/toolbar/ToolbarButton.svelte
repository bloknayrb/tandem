<script lang="ts">
import type { Snippet } from "svelte";

import "./toolbar-chrome.css";

interface Props {
  /** When provided as a snippet, the snippet is rendered inside the button.
   * Otherwise `label` is rendered as a plain string. */
  label?: string;
  children?: Snippet;
  ariaLabel?: string;
  testId?: string;
  shortcut?: string;
  disabled?: boolean;
  disabledTitle?: string;
  active?: boolean;
  ariaPressed?: boolean;
  onMouseDown?: (e: MouseEvent) => void;
  onClick?: (e: MouseEvent) => void;
  /** Layout/typography escape hatch only (font-size, font-weight, font-style,
   * font-family, letter-spacing, width quirks). Four buttons ride font-size
   * through here — B/I/S because the design sizes a child element (`.b strong`)
   * while these pass `label` as a bare string, so there is no child to target;
   * and `<>`, where the design sizes the button itself (`.b.mono`) and this is
   * simply the same declaration by another route.
   *
   * Do NOT inject background, color, border, or border-radius via this prop.
   * An inline style beats every author rule regardless of specificity, so a
   * `background` here would silently defeat `.toolbar-btn.is-active`'s pressed
   * fill — the state signal this control depends on — as well as :hover,
   * :disabled and :focus-visible. `tests/design-system-impl/toolbar-chrome-cascade.test.ts`
   * scans every call site for exactly those four properties. */
  style?: string;
  /** For dropdown-trigger buttons: set to "menu" or "dialog" to advertise
   *  the popup type to assistive technology. */
  ariaHasPopup?: "menu" | "listbox" | "tree" | "grid" | "dialog";
  /** For dropdown-trigger buttons: reflects whether the controlled popup
   *  is currently expanded. Paired with ariaHasPopup. */
  ariaExpanded?: boolean;
}

const {
  label,
  children,
  ariaLabel,
  testId,
  shortcut,
  disabled = false,
  disabledTitle,
  active = false,
  ariaPressed,
  onMouseDown,
  onClick,
  style = "",
  ariaHasPopup,
  ariaExpanded,
}: Props = $props();

const ariaLabelValue = $derived(ariaLabel ?? (typeof label === "string" ? label : undefined));
const titleText = $derived(ariaLabelValue ?? "");
const titleAttr = $derived(
  disabled && disabledTitle ? disabledTitle : shortcut ? `${titleText} (${shortcut})` : titleText,
);
</script>

<button
  type="button"
  class="toolbar-btn tandem-toolbar-ctl"
  class:is-active={active}
  data-testid={testId}
  {disabled}
  title={titleAttr}
  aria-label={ariaLabelValue}
  aria-pressed={ariaPressed}
  aria-haspopup={ariaHasPopup}
  aria-expanded={ariaExpanded}
  onmousedown={onMouseDown}
  onclick={onClick}
  {style}
>
  {#if children}{@render children()}{:else}{label}{/if}
</button>

<style>
  /* Resting metrics (height, padding, radius, type, gap) live in
     toolbar-chrome.css as .tandem-toolbar-ctl. Only the transition and the
     interaction states stay here — see that file's header for why. */
  .toolbar-btn {
    transition: background 120ms, color 120ms, box-shadow 120ms;
  }
  /* Reduced motion: literal 120ms tweens — no timing token to zero, so the guard
     has to be re-declared here. Dual guard: the in-app
     `body.tandem-reduce-motion` (class on <body>, so :global(...)) AND the OS
     pref, media half last so it wins the specificity tie. */
  :global(body.tandem-reduce-motion) .toolbar-btn {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .toolbar-btn {
      transition: none;
    }
  }
  .toolbar-btn:hover:not(:disabled):not(.is-active) {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
  }
  /* Active = PRESSED, not accent-coloured. The surrounding pill is the raised
     surface these press into. The inset is the signal, so dropping it leaves
     active and hover indistinguishable rather than merely less colourful —
     hover is the same sunk fill WITHOUT the inset, which is what makes it read
     as previewing the press. */
  .toolbar-btn.is-active {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
    box-shadow: var(--tandem-shadow-inset);
  }
  /* Forced colors suppresses `box-shadow` entirely and overrides
     `background-color`, so BOTH signals above vanish there while the resting
     border is transparent. The accent state this replaced survived HCM because
     `--tandem-accent-fg-strong` remapped to HighlightText; the pressed idiom
     has no such fallback, so it needs an explicit forced border. Callers also
     pass `ariaPressed`, so the state is conveyed programmatically either way. */
  @media (forced-colors: active) {
    .toolbar-btn.is-active {
      border-color: Highlight;
    }
  }
  .toolbar-btn:disabled {
    cursor: not-allowed;
    color: var(--tandem-fg-subtle);
  }
  .toolbar-btn:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 1px;
  }
</style>
