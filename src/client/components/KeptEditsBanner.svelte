<script lang="ts">
import { backupsRevision, bumpBackupsRevision } from "../hooks/backupsRevision.svelte.js";
import {
  acknowledgeKeptEdits,
  formatBackupTimestamp,
  type KeptNotice,
  listBackups,
} from "../utils/backups.js";
import LiveRegion from "./LiveRegion.svelte";
import "./tandem-banner.css";

/**
 * "Your unsaved edits were kept" (ADR-057, PR 2). The durable half of the
 * `unsaved-edits-kept` notice: derived from the document's backups on the
 * server (`GET /api/backups`' `keptNotice`), not from the notice, so it is
 * there when the user comes back — after a restart, a reopen after Claude
 * closed the tab, or a notice that arrived while no window was open.
 *
 * It shows while a Claude action has kept edits the user has not acknowledged.
 * The user's own Version history restores acknowledge their keeps on the
 * server before any notice goes out, so they never raise it. Dismiss
 * acknowledges exactly the snapshots it was showing; a newer keep shows again.
 *
 * Not mounted in source view (App.svelte), for the reason the conflict banner
 * is not: its View leads to a restore, which a stale source-view draft would
 * silently undo on its next commit.
 */

interface Props {
  documentId: string;
  fileName: string;
  /** Open the Version history for this document. */
  onOpenHistory: (documentId: string) => void;
}

const { documentId, fileName, onOpenHistory }: Props = $props();

let notice = $state<KeptNotice | null>(null);
let dismissing = $state(false);
let error = $state<string | null>(null);

// Latest request wins. Plain `let`: nothing renders it, and the effect below
// must not depend on it.
let requestSeq = 0;

$effect(() => {
  // Re-read on every bump and for this document. The response is applied only
  // if it is still the latest request, so a slow early answer (one that ran
  // before a restore acknowledged its keeps) can never overwrite a later one.
  backupsRevision();
  const forDoc = documentId;
  const seq = ++requestSeq;
  void listBackups(forDoc).then((r) => {
    if (seq !== requestSeq || forDoc !== documentId) return;
    // A failed read stays silent: the banner is a convenience over Version
    // history, and an error on every document (a poisoned backup folder)
    // would be noise. The tray notice still said what happened.
    notice = r.ok ? r.listing.keptNotice : null;
    if (notice === null) error = null;
  });
});

// Coming back to the window: what happened while it was hidden may not have
// reached the notify stream (a sleep, a dropped connection).
$effect(() => {
  const onVisible = () => {
    if (document.visibilityState === "visible") bumpBackupsRevision();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => document.removeEventListener("visibilitychange", onVisible);
});

const message = $derived(
  notice
    ? `Claude replaced or closed ${fileName} while it had unsaved edits. They were kept as a backup (${formatBackupTimestamp(notice.timestamp)}).`
    : "",
);

const announcement = $derived(notice ? [message, error].filter(Boolean).join(" ") : "");

async function dismiss() {
  if (!notice || dismissing) return;
  const forDoc = documentId;
  const names = notice.names;
  dismissing = true;
  error = null;
  const ok = await acknowledgeKeptEdits(forDoc, names);
  if (forDoc !== documentId) return;
  dismissing = false;
  if (!ok) {
    error = "Couldn't dismiss this. Try again.";
    return;
  }
  // Re-read rather than hide: a newer keep may have landed meanwhile.
  bumpBackupsRevision();
}
</script>

<LiveRegion srOnly message={announcement} data-testid="kept-edits-live" />

{#if notice}
  <div class="tandem-banner tandem-banner--info" data-testid="kept-edits-banner">
    <span class="tandem-banner__message" aria-hidden="true">{message}</span>
    {#if error}
      <span class="kept-edits-error" aria-hidden="true">{error}</span>
    {/if}
    <button
      type="button"
      class="tandem-banner__cta"
      data-testid="kept-edits-banner-view"
      onclick={() => onOpenHistory(documentId)}
    >
      Version history
    </button>
    <button
      type="button"
      class="tandem-banner__cta"
      data-testid="kept-edits-banner-dismiss"
      onclick={dismiss}
      disabled={dismissing}
    >
      Dismiss
    </button>
  </div>
{/if}

<style>
  .kept-edits-error {
    color: var(--tandem-error-fg-strong);
    font-size: var(--tandem-text-xs);
  }
</style>
