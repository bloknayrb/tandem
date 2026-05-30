<script lang="ts">
import type { Snippet } from "svelte";

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
  /** Layout/typography escape hatch only (font-weight, font-style, font-family,
   * width quirks). Do NOT inject background, color, border, or border-radius
   * via this prop — those properties belong to the .toolbar-btn CSS rules so
   * :hover, .is-active, :disabled, and :focus-visible can win the cascade. */
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
  class="toolbar-btn"
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
  .toolbar-btn {
    height: 26px;
    min-width: 26px;
    padding: 0 6px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--tandem-fg-muted);
    border-radius: var(--tandem-r-pill);
    font-size: 12px;
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    cursor: pointer;
    transition: background 120ms, color 120ms;
  }
  .toolbar-btn:hover:not(:disabled):not(.is-active) {
    background: var(--tandem-surface-sunk);
    color: var(--tandem-fg);
  }
  .toolbar-btn.is-active {
    background: var(--tandem-accent-bg);
    color: var(--tandem-accent-fg-strong);
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
