<script lang="ts">
/**
 * The owner badge's popover (#2358 PR 5b; ownership design §10.2): who works
 * on this document, Release (saying where the document goes), Assign to any
 * session that can take it (from `GET /api/ownership/owners`, fetched on
 * open), and Start where a hint is active and Start can help. Opened from the
 * badge, or from the native tab menu's Assign leaf.
 *
 * Rendered only while the document's entry carries owner fields, so a dark
 * build never mounts it. `data-tauri-drag-region="false"` because the tab strip
 * sits inside the title bar's deep drag region, where a plain div inside an
 * open popover would otherwise become a window-drag handle (see the new-tab
 * menu's wrapper in DocumentTabs). It writes no Y.Doc: every change goes through
 * `POST /api/ownership`, and the result arrives as the server's republish.
 */
import { onMount, tick, untrack } from "svelte";
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
  /**
   * Where focus goes back when this popover closes: the badge that opened it,
   * or, opened from the native menu, whatever held focus then. Skipped when it
   * has left the DOM.
   */
  returnFocus?: HTMLElement | null;
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
  returnFocus = null,
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

// False once this popover is gone. A Release or Assign still in flight then
// must not call `onclose`: by the time it settles the strip may be showing a
// different tab's popover (the keyed remount), which it would close.
let live = true;

/** The first row that does something, or null (none yet: the owners list is still loading). */
function firstRow(): HTMLButtonElement | null {
  return el?.querySelector<HTMLButtonElement>("button.owner-row:not(:disabled)") ?? null;
}

/**
 * Close, then hand focus back to the opener. On the next task, after the
 * popover has left the DOM and any press has moved focus, and only when focus
 * then sits nowhere (it was inside the popover, or a press landed on something
 * that takes no focus): a press on the editor or another control keeps it.
 */
function dismiss() {
  // Read before `onclose`: closing clears the parent's state the prop reads from.
  const target = returnFocus;
  onclose();
  if (!target) return;
  setTimeout(() => {
    const active = document.activeElement;
    if (target.isConnected && (active === null || active === document.body)) target.focus();
  }, 0);
}

onMount(() => {
  // A dialog takes focus when it opens: its first actionable row, or the
  // dialog itself until the owners list brings one (the effect below).
  (firstRow() ?? el)?.focus();
  void fetchOwnerChoices().then((list) => {
    if (live) choices = list ?? [];
  });
  return () => {
    live = false;
  };
});

// The owners list arrived: if focus is still parked on the dialog itself, move
// it to the first row. Runs after the DOM update, so the rows exist.
$effect(() => {
  if (!choices) return;
  untrack(() => {
    if (el && document.activeElement === el) firstRow()?.focus();
  });
});

// A mousedown on an owner badge is not "outside": the badge's own click
// toggles this popover (or moves it to another tab), and closing here first
// would make that click reopen it instead.
$effect(() =>
  onOutsideEvent(
    () => el,
    ["mousedown"],
    (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-testid="tab-owner-badge"]')) return;
      dismiss();
    },
  ),
);

$effect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") dismiss();
  };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
});

async function run(action: "release" | "assign", ownerLabel?: string) {
  if (pending) return;
  pending = true;
  error = null;
  const result = await postDocumentOwnership(documentId, action, ownerLabel);
  if (!live) return;
  pending = false;
  if (result.ok) {
    dismiss();
    return;
  }
  error = ownershipErrorText(result.error);
  // The pressed row was disabled while the request ran, which dropped focus;
  // a refusal keeps the popover open, so focus comes back into it.
  await tick();
  if (live && (document.activeElement === null || document.activeElement === document.body)) {
    firstRow()?.focus();
  }
}
</script>

<div
  bind:this={el}
  class="owner-popover"
  role="dialog"
  tabindex="-1"
  aria-label={`Who works on ${fileName}`}
  data-testid="tab-owner-menu"
  data-tauri-drag-region="false"
  style={`left: clamp(8px, ${anchor.left}px, calc(100vw - 348px)); top: ${anchor.bottom + 4}px;`}
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
        dismiss();
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
    z-index: var(--tandem-z-popover);
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
