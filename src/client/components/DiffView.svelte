<script lang="ts">
import { type CompareResult, comparisonLabel } from "../utils/backups.js";
import { buildDiffRows } from "../utils/compare.js";
import { SR_ONLY_STYLE } from "./live-region";

/**
 * A read-only unified diff of another version of a document against the
 * document as it is now (ADR-057, PR 4), with the fetch's loading and error
 * states, so both compare views (Version history, and the conflict banner's
 * Compare) show them alike. The caller fetches (`compareDocument`); `result`
 * is null while it runs.
 */

interface Props {
  result: CompareResult | null;
}

const { result }: Props = $props();

const comparison = $derived(result?.ok ? result.comparison : null);
const otherLabel = $derived(comparison ? comparisonLabel(comparison.otherLabel) : "");
const rows = $derived(comparison ? buildDiffRows(comparison.other, comparison.current) : null);
</script>

{#if result === null}
  <p class="note">Comparing…</p>
{:else if !result.ok}
  <p class="note note--error" data-testid="compare-error">{result.message}</p>
{:else}
<div class="diff-view" data-testid="diff-view">
  <p class="legend">
    <span class="legend-remove">− {otherLabel}</span>
    <span class="legend-add">+ The document now, as saving would write it</span>
  </p>
  {#if result.comparison.truncated}
    <p class="note" data-testid="diff-truncated">
      These versions are large, so only their beginnings are compared.
    </p>
  {/if}
  {#if rows === null}
    <p class="note" data-testid="diff-too-large">These versions are too different to compare here.</p>
  {:else if rows.length === 0}
    <p class="note" data-testid="diff-none">
      {result.comparison.truncated ? "No differences in the part compared." : "No differences."}
    </p>
  {:else}
    <div class="lines" role="list">
      {#each rows as row, i (i)}
        {#if row.kind === "gap"}
          <div class="line line--gap" role="listitem" data-testid="diff-line" data-kind="gap">
            {row.count} unchanged {row.count === 1 ? "line" : "lines"}
          </div>
        {:else if row.kind === "more"}
          <div class="line line--gap" role="listitem" data-testid="diff-more">
            {row.count} more {row.count === 1 ? "line" : "lines"} not shown
          </div>
        {:else}
          <div
            class="line line--{row.kind}"
            role="listitem"
            data-testid="diff-line"
            data-kind={row.kind}
          >
            <span class="marker" aria-hidden="true"
              >{row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "}</span
            >
            <span style={SR_ONLY_STYLE}
              >{row.kind === "add"
                ? "Only in the document now: "
                : row.kind === "remove"
                  ? `Only in ${otherLabel.toLowerCase()}: `
                  : ""}</span
            >
            {#if row.kind !== "same" && row.segments}
              <span class="text"
                >{#each row.segments as seg, k (k)}<span class:word-changed={seg.changed}
                    >{seg.text}</span
                  >{/each}</span
              >
            {:else}
              <span class="text">{row.text === "" ? " " : row.text}</span>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>
{/if}

<style>
  .diff-view {
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-2);
    min-height: 0;
  }

  .legend {
    display: flex;
    gap: var(--tandem-space-4);
    margin: 0;
    font-size: var(--tandem-text-xs);
    color: var(--tandem-fg-muted);
  }
  .legend-remove {
    color: var(--tandem-error-fg-strong);
  }
  .legend-add {
    color: var(--tandem-success-fg-strong);
  }

  .note {
    margin: 0;
    font-size: var(--tandem-text-sm);
    color: var(--tandem-fg-muted);
  }
  .note--error {
    color: var(--tandem-error-fg-strong);
  }

  .lines {
    font-family: var(--tandem-font-mono, monospace);
    font-size: var(--tandem-text-xs);
    line-height: 1.5;
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-2);
    overflow: auto;
    max-height: 55vh;
  }

  .line {
    position: relative;
    display: flex;
    gap: var(--tandem-space-2);
    padding: 0 var(--tandem-space-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .line--add {
    background: var(--tandem-success-bg);
    color: var(--tandem-success-fg-strong);
  }
  .line--remove {
    background: var(--tandem-error-bg);
    color: var(--tandem-error-fg-strong);
  }
  .line--gap {
    justify-content: center;
    color: var(--tandem-fg-subtle);
    background: var(--tandem-surface-sunk);
    font-style: italic;
  }

  .marker {
    flex: 0 0 auto;
    user-select: none;
  }
  .text {
    flex: 1 1 auto;
    min-width: 0;
  }

  .word-changed {
    border-radius: 2px;
    background: color-mix(in srgb, currentColor 18%, transparent);
    font-weight: 600;
  }

</style>
