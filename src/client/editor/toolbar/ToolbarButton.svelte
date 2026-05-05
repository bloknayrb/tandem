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
  onMouseDown?: (e: MouseEvent) => void;
  onClick?: () => void;
  style?: string;
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
  onMouseDown,
  onClick,
  style = "",
}: Props = $props();

const computed = $derived.by(() => {
  let border = "1px solid transparent";
  let background = "transparent";
  let color = "var(--tandem-fg-muted)";

  if (disabled) {
    background = "transparent";
    color = "var(--tandem-fg-subtle)";
  } else if (active) {
    background = "var(--tandem-accent-bg)";
    border = "1px solid var(--tandem-accent-border)";
    color = "var(--tandem-accent-fg-strong)";
  }
  return { border, background, color };
});

const ariaLabelValue = $derived(ariaLabel ?? (typeof label === "string" ? label : undefined));
const titleText = $derived(ariaLabelValue ?? "");
const titleAttr = $derived(
  disabled && disabledTitle ? disabledTitle : shortcut ? `${titleText} (${shortcut})` : titleText,
);

const baseStyle =
  "height: 28px; padding: 0 8px; font-size: 12px; border-radius: var(--tandem-r-2); display: inline-flex; align-items: center; justify-content: center; gap: 5px;";

const fullStyle = $derived(
  `${baseStyle} cursor: ${disabled ? "not-allowed" : "pointer"}; ${style}; border: ${computed.border}; background: ${computed.background}; color: ${computed.color};`,
);
</script>

<button
  type="button"
  data-testid={testId}
  {disabled}
  title={titleAttr}
  aria-label={ariaLabelValue}
  onmousedown={onMouseDown}
  onclick={onClick}
  style={fullStyle}
>
  {#if children}{@render children()}{:else}{label}{/if}
</button>
