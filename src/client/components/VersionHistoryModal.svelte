<script lang="ts">
import { tick, untrack } from "svelte";
import {
  type BackupSnapshot,
  backupKindLabel,
  type CompareResult,
  compareDocument,
  formatBackupAge,
  formatBackupSize,
  formatBackupTimestamp,
  listBackups,
  restoreBackup,
} from "../utils/backups.js";
import { trapTab } from "../utils/focus-trap.js";
import DiffView from "./DiffView.svelte";
import LiveRegion from "./LiveRegion.svelte";

/**
 * Version history (ADR-057, PR 2): every backup of one document, newest
 * first, each restorable by name. Replaces the palette's "restore the most
 * recent backup" confirm.
 *
 * A restore keeps the document's unsaved edits as a backup first (the server
 * does it, `POST /api/backups/restore`), and snapshots the bytes it overwrites,
 * so every restore made here can be undone from this same list. If the edits
 * cannot be kept, nothing is restored and the row offers "Restore anyway".
 *
 * Open while `documentId` is set. The opener fixes it for as long as the modal
 * is open: Claude changing the active tab meanwhile must not retarget a
 * restore. App clears it if that document's tab goes away.
 */

interface Props {
  documentId: string | null;
  fileName: string;
  onClose: () => void;
  /** A restore landed. `editsKept`: the document's unsaved edits were kept first. */
  onRestored: (editsKept: boolean) => void;
  /** Rows offer Compare: the document is one `canCompareWithDisk` admits. */
  canCompare?: boolean;
}

let { documentId, fileName, onClose, onRestored, canCompare = false }: Props = $props();

const open = $derived(documentId !== null);

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; backups: BackupSnapshot[] };

let phase = $state<Phase>({ kind: "loading" });
/** The row whose in-place confirm is showing. */
let confirming = $state<string | null>(null);
/** The row whose restore is in flight; every Restore is disabled meanwhile. */
let restoring = $state<string | null>(null);
/** The backup being compared with the document now; `result` null while loading. */
let comparing = $state<{ name: string; result: CompareResult | null } | null>(null);
/** A row's failed restore. `backupFailed` offers "Restore anyway". */
let rowError = $state<{ name: string; backupFailed: boolean; message: string } | null>(null);

/** What the screen reader hears: derived, so no transition can leave it stale. */
const status = $derived(
  !open
    ? ""
    : comparing !== null
      ? "" // DiffView announces the comparison itself, outcome included.
      : restoring !== null
        ? "Restoring…"
        : rowError
          ? rowError.message
          : phase.kind === "error"
            ? phase.message
            : phase.kind === "ready"
              ? phase.backups.length === 0
                ? "No backups yet."
                : phase.backups.length === 1
                  ? "1 backup."
                  : `${phase.backups.length} backups.`
              : "",
);

let dialogEl: HTMLElement | null = $state(null);
let prevFocus: Element | null = null;
let loadSeq = 0;

async function load(forDoc: string) {
  const seq = ++loadSeq;
  phase = { kind: "loading" };
  const r = await listBackups(forDoc);
  if (seq !== loadSeq || forDoc !== documentId) return;
  if (r.ok) {
    phase = { kind: "ready", backups: r.listing.backups };
    return;
  }
  // A body that is not a listing is "couldn't read", never "no backups": the
  // reader may have come here because a save said their original is backed up.
  phase = {
    kind: "error",
    message:
      r.reason === "unreadable"
        ? "Couldn't read the list of backups."
        : r.reason === "network"
          ? "Couldn't reach Tandem."
          : `Couldn't list backups: ${r.message ?? "the request failed"}.`,
  };
}

$effect(() => {
  if (documentId === null) {
    // Cleared on close, so a later open never mounts (and diffs) a stale comparison.
    untrack(() => {
      comparing = null;
    });
    return;
  }
  const forDoc = documentId;
  untrack(() => {
    confirming = null;
    restoring = null;
    rowError = null;
    comparing = null;
    void load(forDoc);
  });
});

// Focus: into the dialog on open, back where it was on close.
$effect(() => {
  if (!open) return;
  const el = untrack(() => dialogEl);
  if (!el) return;
  prevFocus = document.activeElement;
  el.focus();
  const onFocusIn = (e: FocusEvent) => {
    if (el && !el.contains(e.target as Node)) el.focus();
  };
  document.addEventListener("focusin", onFocusIn);
  return () => {
    document.removeEventListener("focusin", onFocusIn);
    if (prevFocus instanceof HTMLElement && document.contains(prevFocus)) prevFocus.focus();
  };
});

// Escape steps back one level: an open confirm or row error first, then the
// modal. Capture phase + stopPropagation, as HelpModal, so the app's global
// Escape handler never sees it.
$effect(() => {
  if (!open) return;
  const handler = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (untrack(() => restoring) !== null) return;
    if (untrack(() => comparing) !== null) {
      void closeCompare();
      return;
    }
    if (untrack(() => confirming) !== null || untrack(() => rowError) !== null) {
      confirming = null;
      rowError = null;
      return;
    }
    onClose();
  };
  window.addEventListener("keydown", handler, { capture: true });
  return () => window.removeEventListener("keydown", handler, { capture: true });
});

async function askConfirm(name: string) {
  rowError = null;
  confirming = name;
  await tick();
  dialogEl?.querySelector<HTMLElement>('[data-testid="version-history-confirm"]')?.focus();
}

/** Bumped per compare request; only the latest may land (Back then Compare again). */
let compareSeq = 0;

/** Show the difference between backup `name` and the document now, in place of the list. */
async function openCompare(name: string) {
  if (documentId === null) return;
  const forDoc = documentId;
  confirming = null;
  rowError = null;
  const mine = ++compareSeq;
  comparing = { name, result: null };
  // The row's button is gone with the list; keep focus inside the dialog.
  await tick();
  dialogEl?.querySelector<HTMLElement>('[data-testid="version-history-compare-back"]')?.focus();
  const result = await compareDocument(forDoc, name);
  if (mine !== compareSeq || forDoc !== documentId || comparing?.name !== name) return;
  comparing = { name, result };
}

/** Back to the list, focus on the row that was being compared. */
async function closeCompare() {
  const name = comparing?.name;
  comparing = null;
  await tick();
  const buttons = dialogEl?.querySelectorAll<HTMLElement>(
    '[data-testid="version-history-compare"]',
  );
  const row = [...(buttons ?? [])].find((b) => b.dataset.backup === name);
  (row ?? dialogEl)?.focus();
}

/** True only for a click whose press also began on the backdrop, not a text-selection drag out of the dialog. */
let pressedOnBackdrop = false;

const BACKUP_FAILED_FALLBACK =
  "Couldn't keep a backup of your unsaved edits first, so nothing was restored.";

async function doRestore(name: string, discardUnsavedEdits: boolean) {
  if (restoring !== null || documentId === null) return;
  const forDoc = documentId;
  confirming = null;
  rowError = null;
  restoring = name;
  const r = await restoreBackup(forDoc, name, discardUnsavedEdits);
  if (forDoc !== documentId) return;
  restoring = null;
  if (r.ok) {
    onRestored(r.editsKept);
    onClose();
    return;
  }
  rowError =
    r.reason === "backup-failed"
      ? { name, backupFailed: true, message: r.message ?? BACKUP_FAILED_FALLBACK }
      : {
          name,
          backupFailed: false,
          message:
            r.reason === "network"
              ? "Couldn't reach Tandem. Nothing was restored."
              : `Restore failed: ${r.message ?? "the request failed"}`,
        };
  // Anything but a refused keep may have changed the list (a failure after the
  // write leaves new backups; a missing snapshot is gone): re-read it. The
  // error stays, on its row, or above the list if that row is gone.
  if (r.reason !== "backup-failed") void load(forDoc);
}
</script>

<LiveRegion srOnly message={status} data-testid="version-history-live" />

{#if open}
  <div
    role="presentation"
    class="modal-backdrop"
    onpointerdown={(e) => (pressedOnBackdrop = e.target === e.currentTarget)}
    onclick={(e) => {
      if (e.target === e.currentTarget && pressedOnBackdrop && restoring === null) onClose();
      pressedOnBackdrop = false;
    }}
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="version-history-title"
      tabindex="-1"
      bind:this={dialogEl}
      class="version-history"
      data-testid="version-history-modal"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => {
        e.stopPropagation();
        trapTab(e, dialogEl);
      }}
    >
      <header class="modal-header">
        <h2 id="version-history-title">Version history: {fileName}</h2>
        <button
          type="button"
          class="modal-close"
          data-testid="version-history-close"
          onclick={onClose}
          disabled={restoring !== null}
          aria-label="Close version history"
        >
          ×
        </button>
      </header>
      <div class="modal-content">
        <p class="intro">
          Restoring a version replaces the document and writes it to the file. If the document has
          unsaved edits, they're kept as a backup first, so you can come back to them here.
        </p>
        {#if comparing}
          <div class="compare" data-testid="version-history-compare-view">
            <button
              type="button"
              class="btn"
              data-testid="version-history-compare-back"
              onclick={closeCompare}
            >
              ← Back to the list
            </button>
            <DiffView result={comparing.result} />
          </div>
        {:else}
        {#if rowError && !(phase.kind === "ready" && phase.backups.some((b) => b.name === rowError?.name))}
          <p class="state state--error" data-testid="version-history-row-error">{rowError.message}</p>
        {/if}
        {#if phase.kind === "loading"}
          <p class="state">Loading…</p>
        {:else if phase.kind === "error"}
          <p class="state state--error" data-testid="version-history-error">{phase.message}</p>
          <button
            type="button"
            class="btn"
            data-testid="version-history-retry"
            onclick={() => documentId !== null && load(documentId)}
          >
            Try again
          </button>
        {:else if phase.backups.length === 0}
          <p class="state" data-testid="version-history-empty">
            No backups exist for this document yet. Tandem copies the file before its first
            overwrite each session, keeps your unsaved edits when Claude reloads, restores or closes
            the document, and keeps them again before any restore made here.
          </p>
        {:else}
          <ul class="rows">
            {#each phase.backups as b (b.name)}
              <li class="row" data-testid="version-history-row" data-kind={b.kind ?? "disk"}>
                <div class="row-main">
                  <span class="kind" class:kind--unsaved={b.kind === "unsaved"}>
                    {backupKindLabel(b)}
                  </span>
                  <span class="meta" title={formatBackupTimestamp(b.timestamp)}>
                    {formatBackupAge(b.timestamp)} · {formatBackupSize(b.size)}
                  </span>
                </div>
                <div class="row-actions">
                  {#if confirming === b.name}
                    <span class="confirm-text">Restore this version?</span>
                    <button
                      type="button"
                      class="btn btn--primary"
                      data-testid="version-history-confirm"
                      onclick={() => doRestore(b.name, false)}
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      class="btn"
                      data-testid="version-history-cancel"
                      onclick={() => (confirming = null)}
                    >
                      Cancel
                    </button>
                  {:else}
                    {#if canCompare}
                      <button
                        type="button"
                        class="btn"
                        data-testid="version-history-compare"
                        data-backup={b.name}
                        disabled={restoring !== null}
                        onclick={() => openCompare(b.name)}
                      >
                        Compare
                      </button>
                    {/if}
                    <button
                      type="button"
                      class="btn"
                      data-testid="version-history-restore"
                      disabled={restoring !== null}
                      onclick={() => askConfirm(b.name)}
                    >
                      {restoring === b.name ? "Restoring…" : "Restore"}
                    </button>
                  {/if}
                </div>
                {#if rowError?.name === b.name}
                  <div class="row-error" data-testid="version-history-row-error">
                    <span>{rowError.message}</span>
                    {#if rowError.backupFailed}
                      <button
                        type="button"
                        class="btn btn--danger"
                        data-testid="version-history-restore-anyway"
                        onclick={() => doRestore(b.name, true)}
                      >
                        Restore anyway (your unsaved edits will be lost)
                      </button>
                    {/if}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--tandem-bg) 70%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: var(--tandem-z-above-titlebar);
  }

  .version-history {
    width: min(620px, 92vw);
    max-height: min(82vh, 720px);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background-color: var(--tandem-surface);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-5);
    box-shadow: var(--tandem-shadow-3);
  }

  .modal-header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--tandem-space-4);
    padding: 20px 24px 14px;
    border-bottom: 1px solid var(--tandem-border);
  }

  .modal-header h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--tandem-fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .modal-close {
    background: none;
    border: 1px solid transparent;
    cursor: pointer;
    color: var(--tandem-fg-subtle);
    font-size: 18px;
    line-height: 1;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    padding: 0;
    border-radius: var(--tandem-r-2);
    flex: 0 0 auto;
  }
  .modal-close:hover:not(:disabled),
  .modal-close:focus-visible {
    color: var(--tandem-fg);
    background: var(--tandem-surface-sunk);
    outline: none;
  }

  .modal-content {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 16px 24px 24px;
  }

  .intro,
  .state {
    margin: 0 0 var(--tandem-space-4);
    font-size: var(--tandem-text-sm);
    color: var(--tandem-fg-muted);
    line-height: 1.5;
  }
  .state--error {
    color: var(--tandem-error-fg-strong);
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--tandem-space-2);
  }

  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--tandem-space-2) var(--tandem-space-3);
    padding: var(--tandem-space-3);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-3);
  }

  .row-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .kind {
    font-size: var(--tandem-text-sm);
    font-weight: 600;
    color: var(--tandem-fg);
  }
  .kind--unsaved {
    color: var(--tandem-info-fg-strong);
  }

  .meta {
    font-size: var(--tandem-text-xs);
    color: var(--tandem-fg-subtle);
  }

  .row-actions {
    display: flex;
    align-items: center;
    gap: var(--tandem-space-2);
  }

  .confirm-text {
    font-size: var(--tandem-text-sm);
    color: var(--tandem-fg);
  }

  .compare {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--tandem-space-3);
  }
  .compare :global([data-testid="diff-view"]) {
    align-self: stretch;
  }

  .row-error {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--tandem-space-2);
    font-size: var(--tandem-text-xs);
    color: var(--tandem-error-fg-strong);
  }

  .btn {
    font: inherit;
    font-size: var(--tandem-text-sm);
    padding: 4px 12px;
    border-radius: var(--tandem-r-2);
    border: 1px solid var(--tandem-border);
    background: var(--tandem-surface);
    color: var(--tandem-fg);
    cursor: pointer;
  }
  .btn:hover:not(:disabled) {
    background: var(--tandem-surface-sunk);
  }
  .btn:focus-visible {
    outline: 2px solid var(--tandem-accent);
    outline-offset: 1px;
  }
  .btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .btn--primary {
    background: var(--tandem-accent);
    border-color: var(--tandem-accent);
    color: var(--tandem-accent-fg);
  }
  .btn--primary:hover:not(:disabled) {
    background: var(--tandem-accent);
    filter: brightness(1.05);
  }
  .btn--danger {
    border-color: var(--tandem-error-border);
    color: var(--tandem-error-fg-strong);
  }
</style>
