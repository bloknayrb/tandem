<script lang="ts">
import { tick, untrack } from "svelte";
import {
  type BackupSnapshot,
  backupKindLabel,
  formatBackupSize,
  formatBackupTimestamp,
  formatRelativeTime,
  listBackups,
  restoreBackup,
} from "../utils/backups.js";
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
 * `documentId` is fixed by the opener for as long as the modal is open: Claude
 * changing the active tab meanwhile must not retarget a restore. App closes the
 * modal if that document's tab goes away.
 */

interface Props {
  open: boolean;
  documentId: string | null;
  fileName: string;
  onClose: () => void;
  /** A restore landed. `editsKept`: the document's unsaved edits were kept first. */
  onRestored: (editsKept: boolean) => void;
}

let { open, documentId, fileName, onClose, onRestored }: Props = $props();

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; backups: BackupSnapshot[] };

let phase = $state<Phase>({ kind: "loading" });
/** The row whose in-place confirm is showing. */
let confirming = $state<string | null>(null);
/** The row whose restore is in flight; every Restore is disabled meanwhile. */
let restoring = $state<string | null>(null);
/** A row's failed restore. `backup-failed` offers "Restore anyway". */
let rowError = $state<{ name: string; backupFailed: boolean; message: string } | null>(null);
let status = $state("");

let dialogEl: HTMLElement | null = $state(null);
let prevFocus: Element | null = null;
let loadSeq = 0;

async function load(forDoc: string) {
  const seq = ++loadSeq;
  phase = { kind: "loading" };
  const r = await listBackups(forDoc);
  if (seq !== loadSeq || forDoc !== documentId || !open) return;
  if (r.ok) {
    phase = { kind: "ready", backups: r.listing.backups };
    status =
      r.listing.backups.length === 0 ? "No backups yet." : `${r.listing.backups.length} backups.`;
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
  status = phase.message;
}

$effect(() => {
  if (!open || documentId === null) return;
  const forDoc = documentId;
  untrack(() => {
    confirming = null;
    restoring = null;
    rowError = null;
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

async function doRestore(name: string, discardUnsavedEdits: boolean) {
  if (restoring !== null || documentId === null) return;
  const forDoc = documentId;
  confirming = null;
  rowError = null;
  restoring = name;
  status = "Restoring…";
  const r = await restoreBackup(forDoc, name, discardUnsavedEdits);
  if (forDoc !== documentId || !open) return;
  restoring = null;
  if (r.ok) {
    status = "";
    onRestored(r.editsKept);
    onClose();
    return;
  }
  rowError =
    r.reason === "backup-failed"
      ? {
          name,
          backupFailed: true,
          message:
            "Couldn't keep a backup of your unsaved edits first, so nothing was restored. Tandem's backup folder may be full or not writable.",
        }
      : {
          name,
          backupFailed: false,
          message:
            r.reason === "network"
              ? "Couldn't reach Tandem. Nothing was restored."
              : `Restore failed: ${r.message ?? "the request failed"}.`,
        };
  status = rowError.message;
}

function onDialogKeydown(e: KeyboardEvent) {
  e.stopPropagation();
  if (e.key !== "Tab" || !dialogEl) return;
  const focusable = Array.from(
    dialogEl.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
  if (focusable.length === 0) {
    e.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
</script>

<LiveRegion srOnly message={open ? status : ""} data-testid="version-history-live" />

{#if open}
  <div
    role="presentation"
    class="modal-backdrop"
    onclick={() => {
      if (restoring === null) onClose();
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
      onkeydown={onDialogKeydown}
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
                    {formatRelativeTime(b.timestamp)} · {formatBackupSize(b.size)}
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
