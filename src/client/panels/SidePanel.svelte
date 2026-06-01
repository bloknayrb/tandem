<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import { untrack } from "svelte";
import * as Y from "yjs";
import { Y_MAP_ANNOTATION_REPLIES } from "../../shared/constants";
import type { Annotation, AnnotationReply } from "../../shared/types";
import { isPendingReviewTarget } from "../../shared/types";
import { scrollFade } from "../actions/scrollFade.svelte.js";
import ApplyChangesButton from "../components/ApplyChangesButton.svelte";
import { createAgentLabel } from "../hooks/useAgentLabel.svelte";
import { createTandemSettings } from "../hooks/useTandemSettings.svelte";
import { warningStateColors } from "../utils/colors";
import AnnotationCard from "./AnnotationCard.svelte";
import {
  editAnnotation,
  promoteNotesToComments,
  removeAnnotation,
  replyToAnnotation,
  sendNoteToClaude,
} from "./annotation-actions";
import BatchPromoteBar from "./BatchPromoteBar.svelte";
import BulkActions from "./BulkActions.svelte";
import type { FilterAuthor, FilterStatus, FilterType } from "./FilterBar.svelte";
import FilterBar from "./FilterBar.svelte";
import type { UseAnnotationReviewReturn } from "./useAnnotationReview.svelte";

interface Props {
  annotations: Annotation[];
  editor: TiptapEditor | null;
  ydoc: Y.Doc | null;
  activeDocFormat?: string;
  documentId?: string;
  activeAnnotationId: string | null;
  onActiveAnnotationChange: (id: string | null) => void;
  reduceMotion?: boolean;
  onFilterChange?: (type: FilterType, author: FilterAuthor, status: FilterStatus) => void;
  /** True when the annotation store is locked by another Tandem instance. */
  storeReadOnly?: boolean;
  /**
   * #651: annotation ID Claude is currently working on (subscribed once at
   * the YjsSync layer, threaded through as a single string so each card can
   * derive its own boolean instead of observing the awareness map directly).
   */
  claudeWorkingAnnotationId?: string | null;
  /**
   * Annotation-review API lifted to App.svelte so there's exactly one
   * instance across both rails. Provides accept/dismiss/scrollToAnnotation
   * + getReviewTargets for the bulk-confirm UI.
   */
  review: UseAnnotationReviewReturn;
}

let {
  annotations,
  // editor is part of the public Props for API stability but is now unused
  // here — App.svelte passes the editor to the lifted useAnnotationReview.
  editor: _editor,
  ydoc,
  activeDocFormat,
  documentId,
  activeAnnotationId,
  // The lifted review writes activeAnnotationId directly via App.svelte's setter,
  // but we also call this to CLEAR selection (null) on an empty-rail click.
  onActiveAnnotationChange,
  reduceMotion,
  onFilterChange,
  storeReadOnly = false,
  claudeWorkingAnnotationId = null,
  review,
}: Props = $props();

const scrollBehavior: ScrollBehavior = $derived(reduceMotion ? "auto" : "smooth");

const STORE_READ_ONLY_DISMISS_KEY = "tandem:storeReadOnlyBannerDismissed";

function readStoreReadOnlyDismissed(): boolean {
  try {
    return localStorage.getItem(STORE_READ_ONLY_DISMISS_KEY) === "true";
  } catch {
    return false;
  }
}

let storeReadOnlyDismissed = $state(readStoreReadOnlyDismissed());

$effect(() => {
  if (!storeReadOnly) {
    storeReadOnlyDismissed = false;
    try {
      localStorage.removeItem(STORE_READ_ONLY_DISMISS_KEY);
    } catch {
      // storage unavailable
    }
  }
});

function handleStoreReadOnlyDismiss() {
  try {
    localStorage.setItem(STORE_READ_ONLY_DISMISS_KEY, "true");
  } catch {
    // storage unavailable
  }
  storeReadOnlyDismissed = true;
}

// Filter state
let filterType = $state<FilterType>("all");
let filterAuthor = $state<FilterAuthor>("all");
let filterStatus = $state<FilterStatus>("all");
let filterBarOpen = $state(false);
let bulkConfirm = $state<"accept" | "dismiss" | null>(null);

// Scroll container ref
let scrollContainerEl: HTMLDivElement | undefined = $state();

// Confirm button element (from BulkActions)
let confirmBtnEl: HTMLButtonElement | null = $state(null);

// Focus confirm button when bulk confirmation appears
$effect(() => {
  if (bulkConfirm) confirmBtnEl?.focus();
});

// Reset bulk confirm when filters change
$effect(() => {
  // read filter state to establish reactivity
  void filterType;
  void filterAuthor;
  void filterStatus;
  bulkConfirm = null;
});

// Notify parent of filter changes (enables filter-aware annotation counts in OutlinePanel)
$effect(() => {
  onFilterChange?.(filterType, filterAuthor, filterStatus);
});

// Replies: observe Y.Map(annotationReplies)
let repliesMap = $state(new Map<string, AnnotationReply[]>());

$effect(() => {
  if (!ydoc) {
    repliesMap = new Map();
    return;
  }

  const ymap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);

  function rebuild() {
    const grouped = new Map<string, AnnotationReply[]>();
    ymap.forEach((value) => {
      const reply = value as AnnotationReply;
      if (reply && typeof reply === "object" && reply.annotationId) {
        const list = grouped.get(reply.annotationId) ?? [];
        list.push(reply);
        grouped.set(reply.annotationId, list);
      }
    });
    for (const list of grouped.values()) {
      list.sort((a, b) => a.timestamp - b.timestamp);
    }
    repliesMap = grouped;
  }

  rebuild();
  ymap.observe(rebuild);
  return () => ymap.unobserve(rebuild);
});

// Single-pass filtering + categorization
const filteredData = $derived.by(() => {
  const filtered: Annotation[] = [];
  const allPending: Annotation[] = [];

  for (const a of annotations) {
    if (a.status === "pending") allPending.push(a);
    let matchType: boolean;
    if (filterType === "all") matchType = true;
    else if (filterType === "with-replacement") matchType = a.suggestedText !== undefined;
    else matchType = a.type === filterType;
    const matchAuthor = filterAuthor === "all" || a.author === filterAuthor;
    const matchStatus = filterStatus === "all" || a.status === filterStatus;
    if (matchType && matchAuthor && matchStatus) filtered.push(a);
  }

  const pending = filtered.filter((a) => a.status === "pending");
  const reviewPending = filtered.filter(isPendingReviewTarget);
  const resolved = filtered.filter((a) => a.status !== "pending");
  const reviewAllPending = annotations.filter(isPendingReviewTarget);

  return { filtered, pending, reviewPending, resolved, allPending, reviewAllPending };
});

const agentLabel = createAgentLabel(createTandemSettings());

const hasFilters = $derived(
  filterType !== "all" || filterAuthor !== "all" || filterStatus !== "all",
);

const filterLabel = $derived.by(() => {
  if (!hasFilters) return "All";
  const parts: string[] = [];
  if (filterType !== "all") {
    const labels: Record<FilterType, string> = {
      all: "All",
      highlight: "Highlights",
      comment: "Comments",
      note: "Notes",
      "with-replacement": "With replacement",
    };
    parts.push(labels[filterType]);
  }
  if (filterAuthor !== "all") {
    const labels: Record<FilterAuthor, string> = {
      all: "Anyone",
      claude: agentLabel.family,
      user: "You",
      import: "Imported",
    };
    parts.push(labels[filterAuthor]);
  }
  if (filterStatus !== "all") {
    const labels: Record<FilterStatus, string> = {
      all: "Any status",
      pending: "Pending",
      accepted: "Accepted",
      dismissed: "Dismissed",
    };
    parts.push(labels[filterStatus]);
  }
  return parts.join(" · ") || "All";
});

// `review` is a prop now (lifted to App.svelte) — see App.svelte for the single
// useAnnotationReview() instantiation that both rails share.

// Scroll container reset on filter change
let didMountFilters = false;
$effect(() => {
  // track filter state — these are the ONLY reactive deps for this effect
  void filterType;
  void filterAuthor;
  void filterStatus;

  if (!didMountFilters) {
    didMountFilters = true;
    return;
  }

  // Use untrack so reads of activeAnnotationId and scrollContainerEl don't
  // make this effect re-fire when an annotation is clicked (only filter
  // changes should trigger scroll-reset logic).
  untrack(() => {
    if (activeAnnotationId) {
      const card = document.querySelector(`[data-testid="annotation-card-${activeAnnotationId}"]`);
      if (card) {
        card.scrollIntoView({ block: "center" });
        return;
      }
      console.warn(
        `[tandem] SidePanel: active annotation ${activeAnnotationId} not found on filter change; scrolling to top`,
      );
    }
    scrollContainerEl?.scrollTo({ top: 0 });
  });
});

// Scroll to and flash annotation card when activeAnnotationId changes externally
$effect(() => {
  const aid = activeAnnotationId;
  if (!aid) return;
  const sb = scrollBehavior;
  // Under reduced motion the flash keyframe resolves to `animation: none`, so
  // its `animationend` never fires — adding the class would be visually inert and
  // strand the listener. Skip the flash entirely (still scroll into view). Checked
  // in JS because a CSS `@media` can't gate this imperative class toggle.
  const motionOff =
    reduceMotion ||
    (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches);

  const timer = setTimeout(() => {
    const card = document.querySelector(`[data-testid="annotation-card-${aid}"]`);
    if (!card) {
      console.warn(
        `[tandem] SidePanel: active annotation ${aid} not found after 50ms delay; scroll-to-card skipped`,
      );
      return;
    }
    card.scrollIntoView({ behavior: sb, block: "nearest" });
    if (motionOff) return;
    card.classList.add("tandem-annotation-flash");
    // The card root now also carries the cardMotion in/out transitions. Svelte 5
    // drives those via the Web Animations API, which emits no `animationend`, so
    // in practice only our flash keyframe reaches this listener — but match on the
    // keyframe name (substring: Svelte scopes it `svelte-<hash>-tandem-annotation-flash`)
    // and remove manually, so it stays correct even if that mechanism changes.
    const onEnd = (e: Event) => {
      if (!(e as AnimationEvent).animationName.includes("tandem-annotation-flash")) return;
      card.classList.remove("tandem-annotation-flash");
      card.removeEventListener("animationend", onEnd);
    };
    card.addEventListener("animationend", onEnd);
  }, 50);

  return () => clearTimeout(timer);
});

const handleEdit = (id: string, newContent: string) => editAnnotation(ydoc, id, newContent);
const handleSendToClaude = (id: string) => sendNoteToClaude(ydoc, id);
const handleRemove = (id: string) => removeAnnotation(id, documentId);
const handleReply = (id: string, text: string) => replyToAnnotation(id, text, documentId);

// A1/A10 (Phase 4 / #798). Exit-direction ledger: a card resolved via Accept
// settles upward, via Reject slides right; a card that merely leaves the list
// (filtered out, removed) has no entry → neutral fade. The stamp is set
// synchronously *before* the status flip that triggers the outro, and
// `cardExit` reads-and-clears it, so the value is always fresh and the Map
// never accumulates stale entries. Plain Map (not $state): it's an imperative
// side channel for the transition, never rendered.
const exitModes = new Map<string, "accept" | "dismiss">();
function handleAcceptAnimated(id: string) {
  exitModes.set(id, "accept");
  review.handleAccept(id);
}
function handleDismissAnimated(id: string) {
  exitModes.set(id, "dismiss");
  review.handleDismiss(id);
}

function handleBulk(status: "accepted" | "dismissed") {
  for (const ann of filteredData.reviewPending) review.resolveAnnotation(ann.id, status);
  bulkConfirm = null;
}

// Batch-promote selection for imported notes (W8). Set lives in SidePanel
// so cards stay presentational; the promoted set re-renders on every
// annotation list change but we prune stale ids in an effect rather than
// inline so prune isn't a render-time side effect.
let selectedImportIds = $state(new Set<string>());

$effect(() => {
  // Prune against the FILTERED visible list, not the raw annotations list:
  // if FilterBar hides imports, the BatchPromoteBar must clear too, otherwise
  // the user sees "N selected / Send N to Claude" with no visible cards.
  const validIds = new Set(
    filteredData.pending.filter((a) => a.author === "import" && a.type === "note").map((a) => a.id),
  );
  // Read+write of selectedImportIds is wrapped in untrack() so the reactive
  // write doesn't re-trigger this effect and cause a double-run loop.
  untrack(() => {
    const pruned = new Set([...selectedImportIds].filter((id) => validIds.has(id)));
    if (pruned.size !== selectedImportIds.size) selectedImportIds = pruned;
  });
});

function toggleImportSelection(id: string) {
  const next = new Set(selectedImportIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedImportIds = next;
}

function handleBatchPromote() {
  const ids = Array.from(selectedImportIds);
  promoteNotesToComments(ydoc, ids);
  selectedImportIds = new Set();
}

function handleClearSelection() {
  selectedImportIds = new Set();
}

// Deselect the active annotation when the user clicks empty rail background (not
// a card). Mirrors the Escape-key deselect — a pointer affordance for the same
// intent. `target === currentTarget` restricts this to the list container's own
// background, so clicks that land on a card or the "resolved" summary pass
// through untouched.
function handleRailBackgroundClick(e: MouseEvent) {
  if (e.target !== e.currentTarget) return;
  onActiveAnnotationChange(null);
}
</script>

<div
  bind:this={scrollContainerEl}
  data-testid="annotation-list-scroll-container"
  class="tandem-scroll-fade-y"
  use:scrollFade={"y"}
  style="width: 100%; background: var(--tandem-surface-muted); display: flex; flex-direction: column; overflow-y: auto;"
>
  <!-- Store read-only banner: shown when the annotation store is locked by another Tandem instance -->
  {#if storeReadOnly && !storeReadOnlyDismissed}
    <div
      data-testid="store-readonly-banner"
      style="padding: 10px 14px; margin: 10px 14px 0; background: {warningStateColors.background}; border: 1px solid {warningStateColors.border}; border-radius: var(--tandem-r-4); font-size: var(--tandem-text-xs); color: {warningStateColors.color}; display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;"
    >
      <span>
        Annotation store is read-only — another Tandem instance holds the lock. Annotations
        won't be saved. Close the other instance and restart.
      </span>
      <button
        data-testid="store-readonly-dismiss"
        onclick={handleStoreReadOnlyDismiss}
        style="flex-shrink: 0; font-size: var(--tandem-text-xs); padding: 2px 8px; border: none; border-radius: var(--tandem-r-2); background: none; color: {warningStateColors.color}; cursor: pointer; font-weight: 500;"
      >
        Dismiss
      </button>
    </div>
  {/if}

  <!-- Header -->
  <div style="padding: var(--tandem-space-3) var(--tandem-space-4); border-bottom: 1px solid var(--tandem-border);">
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <h3 style="font-size: 13px; font-weight: 600; margin: 0;">
        Annotations
        {#if filteredData.allPending.length > 0}
          <span
            style="margin-left: 8px; padding: 1px 6px; font-size: var(--tandem-text-xs); background: var(--tandem-accent); color: var(--tandem-accent-fg); border-radius: var(--tandem-r-pill);"
          >
            {filteredData.allPending.length}
          </span>
        {/if}
      </h3>
      <span
        aria-live="polite"
        style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0);"
      >
        {filteredData.allPending.length} pending annotation{filteredData.allPending.length !== 1
          ? "s"
          : ""}
      </span>
      <button
        data-testid="filter-bar-toggle"
        onclick={() => (filterBarOpen = !filterBarOpen)}
        style="display: flex; align-items: center; gap: 4px; background: none; border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-pill); padding: 3px 10px; font-size: var(--tandem-text-xs); color: var(--tandem-fg-subtle); cursor: pointer; white-space: nowrap;"
      >
        <span>{filterLabel} {filteredData.filtered.length}</span>
        <span style="font-size: 9px; opacity: 0.7;">▾</span>
        <span>Filter</span>
      </button>
    </div>
  </div>

  <!-- Filters -->
  <FilterBar
    {filterType}
    {filterAuthor}
    {filterStatus}
    {hasFilters}
    open={filterBarOpen}
    onToggleOpen={() => (filterBarOpen = !filterBarOpen)}
    onSetFilterType={(v) => { filterType = v; }}
    onSetFilterAuthor={(v) => { filterAuthor = v; }}
    onSetFilterStatus={(v) => { filterStatus = v; }}
    onClearFilters={() => {
      filterType = "all";
      filterAuthor = "all";
      filterStatus = "all";
    }}
  />

  <!-- Apply as tracked changes (docx only) -->
  <div style="padding: var(--tandem-space-1) var(--tandem-space-4) 0;">
    <ApplyChangesButton {annotations} {activeDocFormat} {documentId} />
  </div>

  <!-- Batch-promote bar: appears when one or more imported notes are checked. -->
  <BatchPromoteBar
    selectedCount={selectedImportIds.size}
    onPromote={handleBatchPromote}
    onClear={handleClearSelection}
    {reduceMotion}
  />

  <!-- Bulk actions -->
  <BulkActions
    {bulkConfirm}
    pendingCount={filteredData.reviewPending.length}
    allPendingCount={filteredData.reviewAllPending.length}
    bind:confirmRef={confirmBtnEl}
    onConfirmAccept={() => handleBulk("accepted")}
    onConfirmDismiss={() => handleBulk("dismissed")}
    onCancel={() => (bulkConfirm = null)}
    onRequestAccept={() => (bulkConfirm = "accept")}
    onRequestDismiss={() => (bulkConfirm = "dismiss")}
    {reduceMotion}
  />

  <!-- Annotation list -->
  <!-- Empty state lives outside role="list" — role="list" must only contain role="listitem" children -->
  {#if filteredData.filtered.length === 0}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      style="padding: var(--tandem-space-3); flex: 1;"
      aria-live="polite"
      onclick={handleRailBackgroundClick}
    >
      <p style="font-size: var(--tandem-text-base); color: var(--tandem-fg-subtle); margin-top: 8px;">
        {hasFilters
          ? "No annotations match filters."
          : "No annotations yet. Open a document to get started."}
      </p>
    </div>
  {:else}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    style="padding: var(--tandem-space-3); flex: 1;"
    role="list"
    aria-label="Annotations"
    onclick={handleRailBackgroundClick}
  >
      {#each filteredData.pending as ann (ann.id)}
        {@const isTarget = activeAnnotationId === ann.id}
        <AnnotationCard
          annotation={ann}
          replies={repliesMap.get(ann.id) ?? []}
          isReviewTarget={isTarget}
          claudeTyping={claudeWorkingAnnotationId === ann.id}
          lifecycleMotion={true}
          {reduceMotion}
          {exitModes}
          onAccept={ann.author !== "user" ? handleAcceptAnimated : undefined}
          onDismiss={ann.author !== "user" ? handleDismissAnimated : undefined}
          onRemove={ann.author === "user" ? handleRemove : undefined}
          onSendToClaude={ann.type === "note" ? handleSendToClaude : undefined}
          onEdit={handleEdit}
          onReply={handleReply}
          onClick={() => review.scrollToAnnotation(ann)}
          selected={selectedImportIds.has(ann.id)}
          onToggleSelect={ann.author === "import" && ann.type === "note"
            ? toggleImportSelection
            : undefined}
        />
      {/each}
      {#if filteredData.resolved.length > 0}
        <details style="margin-top: 12px;">
          <summary style="font-size: 12px; color: var(--tandem-fg-subtle); cursor: pointer;">
            {filteredData.resolved.length} resolved
          </summary>
          <div role="list" aria-label="Resolved annotations">
            {#each filteredData.resolved as ann (ann.id)}
              <AnnotationCard
                annotation={ann}
                replies={repliesMap.get(ann.id) ?? []}
                onUndo={review.undoResolveAnnotation}
                undoable={review.getRecentlyResolved().has(ann.id)}
                onClick={() => review.scrollToAnnotation(ann)}
              />
            {/each}
          </div>
        </details>
      {/if}
  </div>
  {/if}
</div>

<style>
  @keyframes tandem-annotation-flash {
    0% {
      background-color: color-mix(in srgb, var(--tandem-accent) 20%, transparent);
    }
    100% {
      background-color: transparent;
    }
  }

  :global(.tandem-annotation-flash) {
    animation: tandem-annotation-flash 0.8s ease-out;
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.tandem-annotation-flash) {
      animation: none;
    }
  }

  :global(body.tandem-reduce-motion .tandem-annotation-flash) {
    animation: none;
  }
</style>
