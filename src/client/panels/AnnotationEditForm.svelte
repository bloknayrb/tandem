<script lang="ts">
import { TEXTAREA_STYLE } from "./panel-styles";

interface Props {
  annotationId: string;
  hasSuggestedText: boolean;
  editText: string;
  editNewText: string;
  editReason: string;
  onChangeEditText: (value: string) => void;
  onChangeEditNewText: (value: string) => void;
  onChangeEditReason: (value: string) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onSave: () => void;
  onCancel: () => void;
}

let {
  annotationId,
  hasSuggestedText,
  editText,
  editNewText,
  editReason,
  onChangeEditText,
  onChangeEditNewText,
  onChangeEditReason,
  onKeyDown,
  onSave,
  onCancel,
}: Props = $props();

let primaryTextareaEl: HTMLTextAreaElement | null = $state(null);

$effect(() => {
  primaryTextareaEl?.focus();
});
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div role="group" style="margin-top: 4px;" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
  {#if hasSuggestedText}
    <label
      style="font-size: 11px; color: var(--tandem-fg-muted); display: block; margin-bottom: 2px;"
    >
      Replacement text
    </label>
    <textarea
      bind:this={primaryTextareaEl}
      data-testid="edit-newtext-{annotationId}"
      value={editNewText}
      oninput={(e) => onChangeEditNewText((e.target as HTMLTextAreaElement).value)}
      onkeydown={onKeyDown}
      style={TEXTAREA_STYLE}
    ></textarea>
    <label
      style="font-size: 11px; color: var(--tandem-fg-muted); display: block; margin-top: 4px; margin-bottom: 2px;"
    >
      Reason
    </label>
    <textarea
      data-testid="edit-reason-{annotationId}"
      value={editReason}
      oninput={(e) => onChangeEditReason((e.target as HTMLTextAreaElement).value)}
      onkeydown={onKeyDown}
      style={TEXTAREA_STYLE}
    ></textarea>
  {:else}
    <textarea
      bind:this={primaryTextareaEl}
      data-testid="edit-text-{annotationId}"
      value={editText}
      oninput={(e) => onChangeEditText((e.target as HTMLTextAreaElement).value)}
      onkeydown={onKeyDown}
      style={TEXTAREA_STYLE}
    ></textarea>
  {/if}
  <div style="display: flex; gap: 6px; margin-top: 4px;">
    <button
      data-testid="edit-save-btn-{annotationId}"
      onclick={(e) => {
        e.stopPropagation();
        onSave();
      }}
      style="padding: 2px 8px; font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: 3px; background: var(--tandem-success-bg); color: var(--tandem-success-fg-strong); cursor: pointer;"
    >
      Save
    </button>
    <button
      data-testid="edit-cancel-btn-{annotationId}"
      onclick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
      style="padding: 2px 8px; font-size: 11px; border: 1px solid var(--tandem-border-strong); border-radius: 3px; background: var(--tandem-surface); color: var(--tandem-fg-muted); cursor: pointer;"
    >
      Cancel
    </button>
  </div>
</div>
