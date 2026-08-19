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

// Ties the warning sentence to the commit button via aria-describedby. Focus is
// moved here programmatically, and the button's accessible name ("Send to
// Claude") is identical to the two ungated Send controls elsewhere — so without
// the description a screen-reader user meets a gate that announces nothing
// about the thing it is gating.
const uid = $props.id();

// Pill skeleton shared by every button in this bar's send/confirm/cancel set.
// The explicit border is what keeps these visible under forced colors, where
// --tandem-border-strong maps to CanvasText, so none of them needs the kind of
// `index.html` carve-out that `[data-testid="bulk-confirm-btn"]` carries. That
// carve-out is a leftover, not a precedent: BulkActions' `smallBtnBase` already
// sets the same border token, so the button it targets is not background-only
// either. (Same token, different metrics — that bar uses 2px/8px and
// `--tandem-r-1` against this one's 3px/12px pill.)
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
    style="position: sticky; top: 0; z-index: var(--tandem-z-base); display: flex; flex-wrap: wrap; align-items: center; gap: var(--tandem-space-2); padding: var(--tandem-space-2) var(--tandem-space-4); background: var(--tandem-surface); border-bottom: 1px solid var(--tandem-border); box-shadow: var(--tandem-shadow-1);"
  >
    {#if promoteConfirm}
      <!-- The whole row is replaced, as BulkActions does, rather than appending
           the sentence to the count and Clear. That is a width decision, and it
           was measured: keeping them made the confirm row 147-191px tall at the
           300px default rail and pushed it 93-129px past the 200px minimum at
           every density, where the sticky bar's scroll container (overflow-y
           auto, so overflow-x computes to auto) puts the commit button behind a
           horizontal scrollbar. Replacing the row lands it at 57-99px instead.
           Nothing is stranded by dropping Clear: Cancel returns to the selection
           with Clear back in reach. `flex: 1; min-width: 0` on the sentence is
           what lets it wrap instead of shoving the buttons out, and the bar
           wraps as a second net at the minimum width. -->
      <span
        id="{uid}-warn"
        style="flex: 1; min-width: 0; font-size: var(--tandem-text-xs); color: var(--tandem-fg);"
      >
        Send {selectedCount}
        {selectedCount === 1 ? "comment" : "comments"} as you? This cannot be undone.
      </span>
      <button
        bind:this={confirmRef}
        data-testid="batch-promote-commit"
        onclick={onConfirmPromote}
        aria-describedby="{uid}-warn"
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
      <!-- The count is read live rather than captured, so a prune that shrinks
           the selection cannot leave it lying. -->
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
