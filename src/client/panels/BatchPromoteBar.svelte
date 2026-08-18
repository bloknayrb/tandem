<script lang="ts">
import { createAgentLabel } from "../hooks/useAgentLabel.svelte";
import { barIn, barOut } from "./cardMotion";

interface Props {
  selectedCount: number;
  /** #1444 two-step gate; owned by SidePanel, see the note at its declaration. */
  promoteConfirm: boolean;
  onPromote: () => void;
  onConfirmPromote: () => void;
  onCancelPromote: () => void;
  onClear: () => void;
  /** Bind to get a reference to the confirm button for programmatic focus. */
  confirmRef?: HTMLButtonElement | null;
  /** App reduce-motion setting; threaded from SidePanel (A24, #798). */
  reduceMotion?: boolean;
}

let {
  selectedCount,
  promoteConfirm,
  onPromote,
  onConfirmPromote,
  onCancelPromote,
  onClear,
  confirmRef = $bindable(null),
  reduceMotion = false,
}: Props = $props();

const agentLabel = createAgentLabel();

// Pill skeleton shared by every button in this bar's send/confirm/cancel set,
// the same shape as BulkActions' `smallBtnBase`. The explicit border is what
// keeps these visible under forced colors (--tandem-border-strong maps to
// CanvasText), which is why the background-only bulk-confirm-btn needs an
// index.html carve-out and these do not.
const btnBase =
  "padding: 3px 12px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-pill); cursor: pointer; font-size: var(--tandem-text-xs);";
// #1444: the neutral send pair, colour-matched to .composer-btn and
// .aca-btn--send at rest. No hover variant — an inline style cannot carry one,
// and this bar's buttons never had one.
const neutralBtn = `${btnBase} background: var(--tandem-surface-muted); color: var(--tandem-fg); font-weight: 500;`;
// Twin of .composer-dest / .aca-dest — see the long comment in Toolbar.svelte.
// Inline because this component has no <style> block; nothing enforces the sync
// between the three copies, so change them together. `display: inline-flex` on
// the button is load-bearing: a <span> is a non-replaced inline element, so
// width/height would not apply and the marker would render as a 0x0 box.
const destDisc =
  "box-sizing: border-box; width: 10px; height: 10px; border-radius: var(--tandem-r-circle); border: 2px solid var(--tandem-author-claude); background: var(--tandem-author-claude); flex-shrink: 0;";
</script>

{#if selectedCount > 0}
  <div
    data-testid="batch-promote-bar"
    role="region"
    aria-label="Batch promote imported notes"
    in:barIn={{ reduceMotion }}
    out:barOut={{ reduceMotion, exitMs: 200 }}
    style="position: sticky; top: 0; z-index: var(--tandem-z-base); display: flex; align-items: center; gap: var(--tandem-space-2); padding: var(--tandem-space-2) var(--tandem-space-4); background: var(--tandem-surface); border-bottom: 1px solid var(--tandem-border); box-shadow: var(--tandem-shadow-1);"
  >
    <!-- The count and Clear stay mounted through the confirm, unlike BulkActions
         which swaps its whole row: Clear is one of the exits from the confirm
         state, so hiding it would strand the user in it. Only the send button is
         replaced. The count is read live rather than captured, so a prune that
         shrinks the selection mid-confirm cannot leave the sentence lying. -->
    <span
      data-testid="batch-promote-count"
      style="flex: 1; font-size: var(--tandem-text-2xs); font-weight: 500; color: var(--tandem-fg-subtle);"
    >
      {selectedCount} selected
    </span>
    <button
      data-testid="batch-promote-clear"
      onclick={onClear}
      style="padding: 3px 10px; border: 1px solid transparent; background: none; color: var(--tandem-fg-subtle); border-radius: var(--tandem-r-pill); cursor: pointer; font-size: var(--tandem-text-xs);"
    >
      Clear
    </button>
    {#if promoteConfirm}
      <span style="font-size: var(--tandem-text-xs); color: var(--tandem-fg);">
        Send {selectedCount}
        {selectedCount === 1 ? "comment" : "comments"} as you? This cannot be undone.
      </span>
      <button
        bind:this={confirmRef}
        data-testid="batch-promote-commit"
        onclick={onConfirmPromote}
        style={neutralBtn}
      >
        Send to {agentLabel.family}
      </button>
      <button
        data-testid="batch-promote-cancel"
        onclick={onCancelPromote}
        style="{btnBase} background: var(--tandem-surface); color: var(--tandem-fg-muted);"
      >
        Cancel
      </button>
    {:else}
      <!-- Keeps the `batch-promote-confirm` testid even though it now only
           requests the confirm: the testid set is a contract that may gain
           selectors but never lose one (CLAUDE.md Critical Rule 7). -->
      <button
        data-testid="batch-promote-confirm"
        onclick={onPromote}
        style="{neutralBtn} display: inline-flex; align-items: center; gap: var(--tandem-space-2);"
      >
        <span aria-hidden="true" style={destDisc}></span>
        Send {selectedCount} to {agentLabel.family}
      </button>
    {/if}
  </div>
{/if}
