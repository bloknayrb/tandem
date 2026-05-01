<script lang="ts">
import type { Editor as TiptapEditor } from "@tiptap/core";
import { untrack } from "svelte";
import * as Y from "yjs";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../shared/constants";
import { sanitizeAnnotation } from "../../shared/sanitize";
import type { Annotation, AnnotationReply, TandemMode } from "../../shared/types";
import ApplyChangesButton from "../components/ApplyChangesButton.svelte";
import { warningStateColors } from "../utils/colors";
import { API_BASE } from "../utils/fileUpload";
import AnnotationCard from "./AnnotationCard.svelte";
import BulkActions from "./BulkActions.svelte";
import type { FilterAuthor, FilterStatus, FilterType } from "./FilterBar.svelte";
import FilterBar from "./FilterBar.svelte";
import { useAnnotationReview } from "./useAnnotationReview.svelte";

interface Props {
  annotations: Annotation[];
  editor: TiptapEditor | null;
  ydoc: Y.Doc | null;
  heldCount?: number;
  tandemMode?: TandemMode;
  onModeChange?: (mode: TandemMode) => void;
  activeDocFormat?: string;
  documentId?: string;
  reviewMode: boolean;
  onToggleReviewMode: () => void;
  onExitReviewMode: () => void;
  activeAnnotationId: string | null;
  onActiveAnnotationChange: (id: string | null) => void;
  reduceMotion?: boolean;
}

let {
  annotations,
  editor,
  ydoc,
  heldCount = 0,
  tandemMode: _tandemMode,
  onModeChange,
  activeDocFormat,
  documentId,
  reviewMode,
  onToggleReviewMode,
  onExitReviewMode,
  activeAnnotationId,
  onActiveAnnotationChange,
  reduceMotion,
}: Props = $props();

const scrollBehavior: ScrollBehavior = $derived(reduceMotion ? "auto" : "smooth");

// Filter state
let filterType = $state<FilterType>("all");
let filterAuthor = $state<FilterAuthor>("all");
let filterStatus = $state<FilterStatus>("all");
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
  const resolved = filtered.filter((a) => a.status !== "pending");

  return { filtered, pending, resolved, allPending };
});

const hasFilters = $derived(
  filterType !== "all" || filterAuthor !== "all" || filterStatus !== "all",
);

// useAnnotationReview hook
const review = useAnnotationReview({
  getYdoc: () => ydoc,
  getEditor: () => editor,
  getAnnotations: () => annotations,
  onActiveAnnotationChange: (id) => onActiveAnnotationChange(id),
  getReviewMode: () => reviewMode,
  onToggleReviewMode: () => onToggleReviewMode(),
  onExitReviewMode: () => onExitReviewMode(),
  getBulkConfirm: () => bulkConfirm,
  setBulkConfirm: (v) => (bulkConfirm = v),
  getScrollBehavior: () => scrollBehavior,
});

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

async function handleRemove(annotationId: string): Promise<void> {
  try {
    const resp = await fetch(`${API_BASE}/remove-annotation`, {
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
    const res = await fetch(`${API_BASE}/annotation-reply`, {
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
  for (const ann of filteredData.pending) review.resolveAnnotation(ann.id, status);
  bulkConfirm = null;
}
</script>

<div
  bind:this={scrollContainerEl}
  data-testid="annotation-list-scroll-container"
  style="width: 100%; background: var(--tandem-surface-muted); display: flex; flex-direction: column; overflow-y: auto;"
>
  <!-- Held-annotation banner -->
  {#if heldCount > 0}
    <div
      style="padding: 6px 16px; background: {warningStateColors.background}; border-bottom: 1px solid {warningStateColors.border}; font-size: 12px; color: {warningStateColors.color}; display: flex; justify-content: space-between; align-items: center;"
    >
      <span data-testid="held-banner">
        {heldCount} annotation{heldCount !== 1 ? "s" : ""} held
      </span>
      <button
        onclick={() => onModeChange?.("tandem")}
        style="font-size: 11px; padding: 1px 8px; border: 1px solid var(--tandem-warning-border); border-radius: 4px; background: var(--tandem-surface); color: var(--tandem-warning-fg-strong); cursor: pointer; font-weight: 500;"
      >
        Show all
      </button>
    </div>
  {/if}

  <!-- Header -->
  <div style="padding: 12px 16px; border-bottom: 1px solid var(--tandem-border);">
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <h3 style="font-size: 14px; font-weight: 600; margin: 0;">
        Annotations
        {#if filteredData.allPending.length > 0}
          <span
            style="margin-left: 8px; padding: 1px 6px; font-size: 11px; background: var(--tandem-accent); color: var(--tandem-accent-fg); border-radius: 10px;"
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
      {#if filteredData.allPending.length > 0}
        <div style="display: flex; flex-direction: column; align-items: flex-end;">
          <button
            data-testid="review-mode-btn"
            onclick={onToggleReviewMode}
            title="Keyboard review mode (Ctrl+Shift+R)"
            aria-pressed={reviewMode}
            style="padding: 2px 8px; font-size: 11px; border: 1px solid {reviewMode
              ? 'var(--tandem-accent)'
              : 'var(--tandem-border-strong)'}; border-radius: 3px; background: {reviewMode
              ? 'var(--tandem-accent-bg)'
              : 'var(--tandem-surface)'}; color: {reviewMode
              ? 'var(--tandem-accent)'
              : 'var(--tandem-fg-muted)'}; cursor: pointer; font-weight: {reviewMode ? 600 : 400};"
          >
            {reviewMode ? "Exit Review" : "Review"}
          </button>
          <div
            data-testid="review-shortcut-hints"
            style="font-size: 10px; color: var(--tandem-fg-subtle); margin-top: 2px;"
          >
            Y / N / ↑↓ / Z
          </div>
        </div>
      {/if}
    </div>
  </div>

  <!-- Review mode indicator -->
  {#if reviewMode && review.getReviewTargets().length > 0}
    <div
      style="padding: 8px 16px; background: var(--tandem-accent-bg); border-bottom: 1px solid var(--tandem-border); font-size: 12px; color: var(--tandem-accent-fg-strong);"
    >
      <div aria-live="polite" style="font-weight: 600; margin-bottom: 2px;">
        Reviewing {review.getReviewIndex() + 1} / {review.getReviewTargets().length}
      </div>
      <div style="color: var(--tandem-accent);">
        Tab: next · Shift+Tab: prev · Y: accept · N: dismiss · Z: undo · E: examine · Esc: exit
      </div>
    </div>
  {/if}

  <!-- Filters -->
  <FilterBar
    {filterType}
    {filterAuthor}
    {filterStatus}
    {hasFilters}
    onSetFilterType={(v) => (filterType = v)}
    onSetFilterAuthor={(v) => (filterAuthor = v)}
    onSetFilterStatus={(v) => (filterStatus = v)}
    onClearFilters={() => {
      filterType = "all";
      filterAuthor = "all";
      filterStatus = "all";
    }}
  />

  <!-- Apply as tracked changes (docx only) -->
  <div style="padding: 4px 16px 0;">
    <ApplyChangesButton {annotations} {activeDocFormat} {documentId} />
  </div>

  <!-- Bulk actions -->
  <BulkActions
    {bulkConfirm}
    pendingCount={filteredData.pending.length}
    allPendingCount={filteredData.allPending.length}
    bind:confirmRef={confirmBtnEl}
    onConfirmAccept={() => handleBulk("accepted")}
    onConfirmDismiss={() => handleBulk("dismissed")}
    onCancel={() => (bulkConfirm = null)}
    onRequestAccept={() => (bulkConfirm = "accept")}
    onRequestDismiss={() => (bulkConfirm = "dismiss")}
  />

  <!-- Annotation list -->
  <div style="padding: 8px 16px; flex: 1;" role="list" aria-label="Annotations">
    {#if filteredData.filtered.length === 0}
      <p role="status" style="font-size: 13px; color: var(--tandem-fg-subtle); margin-top: 8px;">
        {hasFilters
          ? "No annotations match filters."
          : "No annotations yet. Open a document to get started."}
      </p>
    {:else}
      {#each filteredData.pending as ann (ann.id)}
        {@const isTarget = review.getActiveReviewAnn()?.id === ann.id}
        <AnnotationCard
          annotation={ann}
          replies={repliesMap.get(ann.id) ?? []}
          isReviewTarget={isTarget}
          onAccept={ann.author !== "user" ? review.handleAccept : undefined}
          onDismiss={ann.author !== "user" ? review.handleDismiss : undefined}
          onRemove={ann.author === "user" ? handleRemove : undefined}
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
    {/if}
  </div>
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
