<script lang="ts">
/**
 * The owner badge's popover (#2358 PR 5b; ownership design §10.2): who works
 * on this document, Release (saying where the document goes), Assign to any
 * session that can take it (from `GET /api/ownership/owners`, fetched on
 * open), and Start where a hint is active and Start can help. Opened from the
 * badge, or from the native tab menu's Assign leaf.
 *
 * Rendered only while the document's entry carries owner fields, so a dark
 * build never mounts it. It writes no Y.Doc: every change goes through
 * `POST /api/ownership`, and the result arrives as the server's republish.
 */
import { onMount, untrack } from "svelte";
import type { OwnershipSummary, PublishedOwnerFields } from "../../shared/ownership-published";
import {
  badgeOffersStart,
  canRelease,
  describeOwner,
  holderName,
  ownershipErrorText,
  RELEASE_TO_TANDEM_TEXT,
  RELEASE_UNASSIGNED_TEXT,
  releaseGoesToTandem,
  takeBackText,
} from "../ownership/owner-view";
import {
  fetchOwnerChoices,
  type OwnerChoice,
  postDocumentOwnership,
} from "../ownership/ownership-api";
import { onOutsideEvent } from "../utils/dismiss-outside";

interface Props {
  documentId: string;
  fileName: string;
  fields: PublishedOwnerFields;
  summary: OwnershipSummary | null;
  now: number;
  /** Viewport coordinates of the element the popover hangs from. */
  anchor: { left: number; bottom: number };
  /** Documents a Start would take back, by file name (ownership design §8.2). */
  takeBack: readonly string[];
  /** A refusal to show at once (the native menu's Release that failed). */
  initialError?: string | null;
  onclose: () => void;
  onstart: () => void;
}

const {
  documentId,
  fileName,
  fields,
  summary,
  now,
  anchor,
  takeBack,
  initialError = null,
  onclose,
  onstart,
}: Props = $props();

const view = $derived(describeOwner(fields, now));
const showRelease = $derived(canRelease(fields, summary));
const releaseText = $derived(
  releaseGoesToTandem(summary) ? RELEASE_TO_TANDEM_TEXT : RELEASE_UNASSIGNED_TEXT,
);
const showStart = $derived(badgeOffersStart(fields, summary));
const startNote = $derived(takeBackText(takeBack));

let choices = $state<OwnerChoice[] | null>(null);
// Seeded once: the popover is keyed on its open request, so a new request remounts it.
let error = $state<string | null>(untrack(() => initialError));
let pending = $state(false);
let el: HTMLDivElement | null = $state(null);

onMount(() => {
  let live = true;
  void fetchOwnerChoices().then((list) => {
    if (live) choices = list ?? [];
  });
  return () => {
    live = false;
  };
});

$effect(() =>
  onOutsideEvent(
    () => el,
    ["mousedown"],
    () => onclose(),
  ),
);

$effect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") onclose();
  };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
});

async function run(action: "release" | "assign", ownerLabel?: string) {
  if (pending) return;
  pending = true;
  error = null;
  const result = await postDocumentOwnership(documentId, action, ownerLabel);
  pending = false;
  if (result.ok) onclose();
  else error = ownershipErrorText(result.error);
}
</script>

<div
  bind:this={el}
  class="owner-popover"
  role="dialog"
  aria-label={`Who works on ${fileName}`}
  data-testid="tab-owner-menu"
  style={`left: ${anchor.left}px; top: ${anchor.bottom + 4}px;`}
>
  <div class="owner-heading" data-stale={view.stale ?? undefined}>{view.detail}</div>
  {#if error}
    <div class="owner-error" role="alert" data-testid="tab-owner-error">{error}</div>
  {/if}
  {#if showRelease}
    <button
      type="button"
      class="owner-row"
      data-testid="tab-owner-release"
      disabled={pending}
      onclick={() => void run("release")}
    >
      <span class="owner-row-main">Release</span>
      <span class="owner-row-sub">{releaseText}</span>
    </button>
  {/if}
  {#if choices && choices.length > 0}
    <div class="owner-section">Assign</div>
    {#each choices as choice (choice.label)}
      <button
        type="button"
        class="owner-row"
        data-testid={`tab-owner-assign-${choice.label}`}
        disabled={pending}
        onclick={() => void run("assign", choice.label)}
      >
        <span class="owner-row-main">{holderName(choice)}</span>
        {#if choice.holds.length > 0}
          <span class="owner-row-sub">holds {choice.holds.map((h) => `“${h}”`).join(", ")}</span>
        {/if}
      </button>
    {/each}
  {/if}
  {#if showStart}
    <button
      type="button"
      class="owner-row"
      data-testid="tab-owner-start"
      disabled={pending}
      onclick={() => {
        onstart();
        onclose();
      }}
    >
      <span class="owner-row-main">Start Tandem's Claude</span>
      {#if startNote}
        <span class="owner-row-sub">{startNote}</span>
      {/if}
    </button>
  {/if}
</div>

<style>
  .owner-popover {
    position: fixed;
    z-index: 60;
    min-width: 220px;
    max-width: 340px;
    padding: var(--tandem-space-1);
    background: var(--tandem-surface);
    color: var(--tandem-fg);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-2);
    box-shadow: var(--tandem-shadow-2);
    font-size: var(--tandem-text-sm);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .owner-heading {
    padding: var(--tandem-space-1) var(--tandem-space-2);
    color: var(--tandem-fg-muted);
    overflow-wrap: anywhere;
  }
  .owner-heading[data-stale] {
    color: var(--tandem-warning-fg-strong);
  }
  .owner-error {
    padding: var(--tandem-space-1) var(--tandem-space-2);
    color: var(--tandem-error-fg-strong);
  }
  .owner-section {
    padding: var(--tandem-space-1) var(--tandem-space-2) 0;
    font-size: var(--tandem-text-xs);
    color: var(--tandem-fg-subtle);
  }
  .owner-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    width: 100%;
    padding: var(--tandem-space-1) var(--tandem-space-2);
    background: none;
    border: none;
    border-radius: var(--tandem-r-1);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .owner-row:hover:not(:disabled),
  .owner-row:focus-visible {
    background: var(--tandem-surface-muted);
  }
  .owner-row:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .owner-row-sub {
    font-size: var(--tandem-text-xs);
    color: var(--tandem-fg-muted);
    overflow-wrap: anywhere;
  }
</style>
