<script lang="ts">
import type * as Y from "yjs";
import { Y_MAP_DOCUMENT_META, Y_MAP_FIDELITY_REPORT } from "../../shared/constants";
import type { FidelityReport } from "../../shared/types";
import "./tandem-banner.css";

/**
 * Persistent, calm docx fidelity notice (#1145, the "honesty layer" / phase
 * 0c+0f). Server-authoritative: renders while the document's
 * Y_MAP_DOCUMENT_META carries a `FidelityReport` (under Y_MAP_FIDELITY_REPORT)
 * whose `importLosses` (Word features mammoth dropped on import) or
 * `exportDowngrades` (what the export simplified on the last save) is non-empty.
 *
 * Self-erasing: hidden when both lists are empty, so as real round-trip fidelity
 * lands (roadmap phases 2–4) the banner disappears on its own. Read-only over
 * Y.js — no CTA mutates server state; the notice reflects a true property of the
 * document, so it is collapsible (Details) but not dismissible.
 */

interface Props {
  ydoc: Y.Doc;
  documentId: string;
  fileName: string;
}

// documentId is part of the mount contract (mirrors DocxConflictBanner); the
// banner keys off the active tab's ydoc, so it isn't read directly here.
const { ydoc, fileName }: Props = $props();

let report = $state<FidelityReport | null>(null);
let expanded = $state(false);

$effect(() => {
  // Read `ydoc` synchronously at the top so the effect re-tracks (re-observes)
  // when the active tab's doc changes. Do not move this below a guard.
  const meta = ydoc.getMap(Y_MAP_DOCUMENT_META);
  const read = () => {
    report = (meta.get(Y_MAP_FIDELITY_REPORT) as FidelityReport | undefined) ?? null;
  };
  read(); // unconditional first read — also catches a session-restore "add"
  const observer = (event: Y.YMapEvent<unknown>) => {
    if (!event.keysChanged.has(Y_MAP_FIDELITY_REPORT)) return;
    read();
  };
  meta.observe(observer);
  return () => {
    meta.unobserve(observer);
    report = null;
    // Reset the disclosure: the component instance is reused across docx→docx
    // tab swaps, so a left-open panel must not bleed into the next document.
    expanded = false;
  };
});

const hasLosses = $derived(
  !!report && (report.importLosses.length > 0 || report.exportDowngrades.length > 0),
);
</script>

{#if hasLosses && report}
  <div
    class="tandem-banner tandem-banner--info"
    role="status"
    aria-live="polite"
    data-testid="fidelity-report-banner"
  >
    <span class="tandem-banner__message">
      Some Word features in {fileName} aren't fully supported. Tandem imported the text and
      structure, but the items below won't survive a save back to .docx.
    </span>
    <button
      type="button"
      class="tandem-banner__cta"
      data-testid="fidelity-report-details-toggle"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
    >
      {expanded ? "Hide details" : "Details"}
    </button>
  </div>
  {#if expanded}
    <div class="fidelity-report-details" data-testid="fidelity-report-details">
      {#if report.importLosses.length > 0}
        <section data-testid="fidelity-report-import-losses">
          <h4>Not imported — lost if you save over the original</h4>
          <ul>
            {#each report.importLosses as loss}
              <li>{loss}</li>
            {/each}
          </ul>
        </section>
      {/if}
      {#if report.exportDowngrades.length > 0}
        <section data-testid="fidelity-report-export-downgrades">
          <h4>Simplified on the last save</h4>
          <ul>
            {#each report.exportDowngrades as downgrade}
              <li>{downgrade}</li>
            {/each}
          </ul>
        </section>
      {/if}
    </div>
  {/if}
{/if}

<style>
  .fidelity-report-details {
    background: var(--tandem-info-bg);
    border: 1px solid var(--tandem-info-border);
    border-top: none;
    border-radius: 0 0 var(--tandem-r-2) var(--tandem-r-2);
    padding: var(--tandem-space-3) var(--tandem-space-4);
    font-size: var(--tandem-text-xs);
    color: var(--tandem-info-fg-strong);
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-3);
  }

  .fidelity-report-details h4 {
    margin: 0 0 var(--tandem-space-1);
    font-size: var(--tandem-text-xs);
    font-weight: 600;
  }

  .fidelity-report-details ul {
    margin: 0;
    padding-left: var(--tandem-space-5);
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-1);
  }
</style>
