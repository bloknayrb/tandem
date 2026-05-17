<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import { untrack } from "svelte";
import * as Y from "yjs";
import { API_ANNOTATION_REPLY, API_REMOVE_ANNOTATION } from "../../shared/api-paths";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../shared/constants";
import { sanitizeAnnotation } from "../../shared/sanitize";
import type { Annotation, AnnotationReply, TandemMode } from "../../shared/types";
import { isPendingReviewTarget } from "../../shared/types";
import ApplyChangesButton from "../components/ApplyChangesButton.svelte";
import { warningStateColors } from "../utils/colors";
import { API_BASE } from "../utils/fileUpload";
import AnnotationCard from "./AnnotationCard.svelte";
import BulkActions from "./BulkActions.svelte";
import type { FilterAuthor, FilterStatus, FilterType } from "./FilterBar.svelte";
import FilterBar from "./FilterBar.svelte";
import type { UseAnnotationReviewReturn } from "./useAnnotationReview.svelte";

interface Props {
  annotations: Annotation[];
  editor: TiptapEditor | null;
  ydoc: Y.Doc | null;
  heldCount?: number;
  tandemMode?: TandemMode;
  onModeChange?: (mode: TandemMode) => void;
  activeDocFormat?: string;
  documentId?: string;
  activeAnnotationId: string | null;
  onActiveAnnotationChange: (id: string | null) => void;
  reduceMotion?: boolean;
  onFilterChange?: (type: FilterType, author: FilterAuthor, status: FilterStatus) => void;
  /** True when the annotation store is locked by another Tandem instance. */
  storeReadOnly?: boolean;
  /**
   * Annotation-review API lifted to App.svelte so there's exactly one
   * instance across both rails. Provides accept/dismiss/scrollToAnnotation
   * + getReviewTargets/getActiveReviewAnn for the bulk-confirm UI.
   */
  review: UseAnnotationReviewReturn;
}

let {
  annotations,
  // editor is part of the public Props for API stability but is now unused
  // here — App.svelte passes the editor to the lifted useAnnotationReview.
  editor: _editor,
  ydoc,
  heldCount = 0,
  tandemMode: _tandemMode,
  onModeChange,
  activeDocFormat,
  documentId,
  activeAnnotationId,
  // onActiveAnnotationChange likewise: the lifted review writes activeAnnotationId
  // directly via App.svelte's setter.
  onActiveAnnotationChange: _onActiveAnnotationChange,
  reduceMotion,
  onFilterChange,
  storeReadOnly = false,
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
      claude: "Claude",
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

  const timer = setTimeout(() => {
    const card = document.querySelector(`[data-testid="annotation-card-${aid}"]`);
    if (card) {
      card.scrollIntoView({ behavior: sb, block: "nearest" });
      card.classList.add("tandem-annotation-flash");
      const onEnd = () => card.classList.remove("tandem-annotation-flash");
      card.addEventListener("animationend", onEnd, { once: true });
    } else {
      console.warn(
        `[tandem] SidePanel: active annotation ${aid} not found after 50ms delay; scroll-to-card skipped`,
      );
    }
  }, 50);

  return () => clearTimeout(timer);
});

function handleEdit(id: string, newContent: string) {
  if (!ydoc) return;
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  const raw = map.get(id) as Annotation | undefined;
  if (!raw) return;
  const ann = sanitizeAnnotation(raw, (event) => {
    console.warn("[sanitize]", event);
  });

  if (ann.suggestedText !== undefined) {
    try {
      const parsed = JSON.parse(newContent) as { suggestedText: string; content: string };
      map.set(id, {
        ...ann,
        suggestedText: parsed.suggestedText,
        content: parsed.content,
        editedAt: Date.now(),
      });
    } catch {
      console.warn(`[SidePanel] Failed to parse edit payload for annotation ${id}`);
    }
    return;
  }
  map.set(id, { ...ann, content: newContent, editedAt: Date.now() });
}

function handleSendToClaude(annotationId: string): void {
  if (!ydoc) return;
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  const raw = map.get(annotationId) as Annotation | undefined;
  if (!raw) return;
  const ann = sanitizeAnnotation(raw, (event) => {
    console.warn("[sanitize]", event);
  });
  map.set(annotationId, { ...ann, type: "comment" });
}

async function handleRemove(annotationId: string): Promise<void> {
  try {
    const resp = await fetch(`${API_BASE}${API_REMOVE_ANNOTATION}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ annotationId, documentId }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ message: "Unknown error" }));
      console.error("[Tandem] Remove annotation failed:", err);
    }
  } catch (e) {
    console.error("[Tandem] Remove annotation failed:", e);
  }
}

async function handleReply(annotationId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}${API_ANNOTATION_REPLY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ annotationId, text, documentId }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      console.warn(`[SidePanel] Reply failed (${res.status}): ${data.message ?? "unknown error"}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[SidePanel] Reply request failed:", err);
    return false;
  }
}

function handleBulk(status: "accepted" | "dismissed") {
  for (const ann of filteredData.reviewPending) review.resolveAnnotation(ann.id, status);
  bulkConfirm = null;
}
</script>

<div
  bind:this={scrollContainerEl}
  data-testid="annotation-list-scroll-container"
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

  <!-- Held-annotation banner -->
  {#if heldCount > 0}
    <div
      style="padding: 10px 14px; margin: 10px 14px 0; background: {warningStateColors.background}; border: 1px solid {warningStateColors.border}; border-radius: var(--tandem-r-4); font-size: var(--tandem-text-xs); color: {warningStateColors.color}; display: flex; justify-content: space-between; align-items: center; gap: 10px;"
    >
      <span data-testid="held-banner">
        {heldCount} annotation{heldCount !== 1 ? "s" : ""} held
      </span>
      <button
        onclick={() => onModeChange?.("tandem")}
        style="font-size: var(--tandem-text-xs); padding: 4px 10px; border: 1px solid var(--tandem-author-claude); border-radius: var(--tandem-r-2); background: var(--tandem-author-claude); color: var(--tandem-author-claude-fg); cursor: pointer; font-weight: 500;"
      >
        Show all
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
  />

  <!-- Annotation list -->
  <!-- Empty state lives outside role="list" — role="list" must only contain role="listitem" children -->
  {#if filteredData.filtered.length === 0}
    <div style="padding: var(--tandem-space-3); flex: 1;" aria-live="polite">
      <p style="font-size: var(--tandem-text-base); color: var(--tandem-fg-subtle); margin-top: 8px;">
        {hasFilters
          ? "No annotations match filters."
          : "No annotations yet. Open a document to get started."}
      </p>
    </div>
  {:else}
  <div style="padding: var(--tandem-space-3); flex: 1;" role="list" aria-label="Annotations">
      {#each filteredData.pending as ann (ann.id)}
        {@const isTarget =
          activeAnnotationId !== null
            ? activeAnnotationId === ann.id
            : review.getActiveReviewAnn()?.id === ann.id}
        <AnnotationCard
          annotation={ann}
          replies={repliesMap.get(ann.id) ?? []}
          isReviewTarget={isTarget}
          onAccept={ann.author !== "user" ? review.handleAccept : undefined}
          onDismiss={ann.author !== "user" ? review.handleDismiss : undefined}
          onRemove={ann.author === "user" ? handleRemove : undefined}
          onSendToClaude={ann.type === "note" ? handleSendToClaude : undefined}
          onEdit={handleEdit}
          onReply={handleReply}
          onClick={() => review.scrollToAnnotation(ann)}
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
