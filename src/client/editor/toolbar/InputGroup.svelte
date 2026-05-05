<script lang="ts">
import type { Snippet } from "svelte";
import ToolbarButton from "./ToolbarButton.svelte";

interface Props {
  /** Bindable reference to the input element. Caller can read this to focus(). */
  inputEl?: HTMLInputElement | null;
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onSubmit: () => void;
  onCancel: () => void;
  placeholder: string;
  submitLabel: string;
  borderColor: string;
  canSubmit: boolean;
  secondaryInput?: Snippet;
  /** Optional prefix used to derive `data-testid` values for the input,
   * submit, and cancel controls (e.g. `"toolbar-comment"` produces
   * `toolbar-comment-input`, `toolbar-comment-submit`, `toolbar-comment-cancel`). */
  testIdPrefix?: string;
}

let {
  inputEl = $bindable(null),
  value,
  onChange,
  onKeyDown,
  onSubmit,
  onCancel,
  placeholder,
  submitLabel,
  borderColor,
  canSubmit,
  secondaryInput,
  testIdPrefix,
}: Props = $props();

const inputStyle = $derived(
  `padding: 3px 8px; font-size: 13px; border: 1px solid ${borderColor}; border-radius: var(--tandem-r-2); outline: none; min-width: 120px; flex: 1 1 200px; background: var(--tandem-surface); color: var(--tandem-fg);`,
);
</script>

<div style="display: flex; align-items: center; gap: 4px;">
  <input
    bind:this={inputEl}
    type="text"
    data-testid={testIdPrefix ? `${testIdPrefix}-input` : undefined}
    {value}
    oninput={(e) => onChange((e.target as HTMLInputElement).value)}
    onkeydown={onKeyDown}
    {placeholder}
    style={inputStyle}
  />
  {#if secondaryInput}{@render secondaryInput()}{/if}
  <ToolbarButton
    label={submitLabel}
    testId={testIdPrefix ? `${testIdPrefix}-submit` : undefined}
    disabled={!canSubmit}
    onClick={onSubmit}
  />
  <ToolbarButton
    label="Cancel"
    testId={testIdPrefix ? `${testIdPrefix}-cancel` : undefined}
    disabled={false}
    onClick={onCancel}
  />
</div>
