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
    // Normalize on read: the report is PERSISTED in the session and is never
    // re-validated on a docx session-restore, so a stale or forward-version
    // shape (missing an array) must not crash the `$derived` `.length` access.
    // Mirrors the server save path's defensive `prev?.importLosses ?? []`.
    const raw = meta.get(Y_MAP_FIDELITY_REPORT) as Partial<FidelityReport> | undefined;
    report = raw
      ? {
          importLosses: Array.isArray(raw.importLosses) ? raw.importLosses : [],
          exportDowngrades: Array.isArray(raw.exportDowngrades) ? raw.exportDowngrades : [],
          // Optional/forward-compat (#1123 0e): pre-0e reports lack this field.
          integrityWarnings: Array.isArray(raw.integrityWarnings) ? raw.integrityWarnings : [],
          updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
        }
      : null;
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

// Post-write verification advisories (#1123 0e) are LOUDER than announced
// import/export losses — when present the banner elevates to warning severity
// and leads with the integrity message + restore on-ramp. `?? []` for reports
// persisted before 0e existed.
const integrityWarnings = $derived(report?.integrityWarnings ?? []);
const hasIntegrity = $derived(integrityWarnings.length > 0);
const hasLosses = $derived(
  !!report &&
    (report.importLosses.length > 0 || report.exportDowngrades.length > 0 || hasIntegrity),
);
</script>

{#if hasLosses && report}
  <div
    class="tandem-banner {hasIntegrity ? 'tandem-banner--warning' : 'tandem-banner--info'}"
    role={hasIntegrity ? "alert" : "status"}
    aria-live={hasIntegrity ? "assertive" : "polite"}
    data-testid="fidelity-report-banner"
  >
    <span class="tandem-banner__message">
      {#if hasIntegrity}
        This save of {fileName} may have changed more than expected — your original is backed up and
        can be restored.
      {:else}
        Some Word features in {fileName} aren't fully supported. Tandem imported the text and
        structure, but the items below won't survive a save back to .docx.
      {/if}
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
    <div
      class="fidelity-report-details {hasIntegrity ? 'fidelity-report-details--warning' : ''}"
      data-testid="fidelity-report-details"
    >
      {#if hasIntegrity}
        <section data-testid="fidelity-report-integrity-warnings">
          <h4>This save may not have preserved everything</h4>
          <ul>
            {#each integrityWarnings as warning}
              <li>{warning}</li>
            {/each}
          </ul>
          <p class="fidelity-report-restore-hint">
            To recover, run "Restore a backup of this document…" from the command palette.
          </p>
        </section>
      {/if}
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

  /* Post-write verification advisory (#1123 0e) — warning severity, distinct
     from the calm info treatment of announced import/export losses. */
  .fidelity-report-details--warning {
    background: var(--tandem-warning-bg);
    border-color: var(--tandem-warning-border);
    color: var(--tandem-warning-fg-strong);
  }

  .fidelity-report-restore-hint {
    margin: var(--tandem-space-1) 0 0;
    font-style: italic;
  }
</style>
