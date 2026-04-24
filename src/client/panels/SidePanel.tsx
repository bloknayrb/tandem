import type { Editor as TiptapEditor } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import {
  DEFAULT_MCP_PORT,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
} from "../../shared/constants";
import { sanitizeAnnotation } from "../../shared/sanitize";
import type { Annotation, AnnotationReply, TandemMode } from "../../shared/types";
import { ApplyChangesButton } from "../components/ApplyChangesButton";
import { warningStateColors } from "../utils/colors";
import { AnnotationCard } from "./AnnotationCard";
import { BulkActions } from "./BulkActions";
import type { FilterAuthor, FilterStatus, FilterType } from "./FilterBar";
import { FilterBar } from "./FilterBar";
import { useAnnotationReview } from "./useAnnotationReview";

interface SidePanelProps {
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

export function SidePanel({
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
}: SidePanelProps) {
  const scrollBehavior: ScrollBehavior = reduceMotion ? "auto" : "smooth";
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [filterAuthor, setFilterAuthor] = useState<FilterAuthor>("all");
  const [filterStatus, setFilterStatus] = useState<FilterStatus>("all");
  const [bulkConfirm, setBulkConfirm] = useState<"accept" | "dismiss" | null>(null);
  const bulkConfirmRef = useRef(bulkConfirm);
  bulkConfirmRef.current = bulkConfirm;

  // Stable refs for keyboard callbacks to avoid stale closures
  const ydocRef = useRef(ydoc);
  const editorRef = useRef(editor);
  ydocRef.current = ydoc;
  editorRef.current = editor;

  const review = useAnnotationReview({
    ydocRef,
    editorRef,
    annotations,
    onActiveAnnotationChange,
    reviewMode,
    onToggleReviewMode,
    onExitReviewMode,
    bulkConfirmRef,
    setBulkConfirm,
    scrollBehavior,
  });

  // Focus confirm button when bulk confirmation appears.
  // Depends on the state value (not the ref) so it fires on every toggle.
  useEffect(() => {
    if (bulkConfirm) review.confirmRef.current?.focus();
  }, [bulkConfirm, review.confirmRef]);

  // Replies: observe the annotationReplies Y.Map
  const [repliesMap, setRepliesMap] = useState<Map<string, AnnotationReply[]>>(new Map());
  useEffect(() => {
    if (!ydoc) {
      setRepliesMap(new Map());
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
      // Sort each group chronologically
      for (const list of grouped.values()) {
        list.sort((a, b) => a.timestamp - b.timestamp);
      }
      setRepliesMap(grouped);
    }

    rebuild();
    const obs = () => rebuild();
    ymap.observe(obs);
    return () => ymap.unobserve(obs);
  }, [ydoc]);

  // Single-pass filtering + categorization
  const { filtered, pending, resolved, allPending } = useMemo(() => {
    const filtered: Annotation[] = [];
    const allPending: Annotation[] = [];

    for (const a of annotations) {
      if (a.status === "pending") allPending.push(a);
      let matchType: boolean;
      if (filterType === "all") matchType = true;
      else if (filterType === "with-replacement") matchType = a.suggestedText !== undefined;
      else if (filterType === "for-claude") matchType = a.directedAt === "claude";
      else matchType = a.type === filterType;
      const matchAuthor = filterAuthor === "all" || a.author === filterAuthor;
      const matchStatus = filterStatus === "all" || a.status === filterStatus;
      if (matchType && matchAuthor && matchStatus) filtered.push(a);
    }

    const pending = filtered.filter((a) => a.status === "pending");
    const resolved = filtered.filter((a) => a.status !== "pending");

    return { filtered, pending, resolved, allPending };
  }, [annotations, filterType, filterAuthor, filterStatus]);

  function handleEdit(id: string, newContent: string) {
    const y = ydocRef.current;
    if (!y) return;
    const map = y.getMap(Y_MAP_ANNOTATIONS);
    const raw = map.get(id) as Annotation | undefined;
    if (!raw) return;
    const ann = sanitizeAnnotation(raw);

    // If the annotation has suggestedText, newContent is JSON-encoded
    // {suggestedText, content} from the AnnotationCard edit form.
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
      return; // Never fall through to raw-content write for suggestedText annotations
    }
    map.set(id, { ...ann, content: newContent, editedAt: Date.now() });
  }

  async function handleReply(annotationId: string, text: string): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:${DEFAULT_MCP_PORT}/api/annotation-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annotationId, text, documentId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        console.warn(
          `[SidePanel] Reply failed (${res.status}): ${data.message ?? "unknown error"}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      console.error("[SidePanel] Reply request failed:", err);
      return false;
    }
  }

  function handleBulk(status: "accepted" | "dismissed") {
    for (const ann of pending) review.resolveAnnotation(ann.id, status);
    setBulkConfirm(null);
  }

  // Reset confirmation when filters change (prevents stale Accept/Dismiss All)
  useEffect(() => {
    setBulkConfirm(null);
  }, [filterType, filterAuthor, filterStatus]);

  // When filters change, reset the annotation list scroll. If a review
  // annotation is active, scroll it into view instead of jumping to the top,
  // so the user doesn't lose their place mid-review (#202).
  //
  // Reads `activeAnnotationId` via a ref so the effect depends only on the
  // filter state. Review-mode Tab navigation mutates `activeAnnotationId`
  // without changing filters — including it in the deps would re-fire the
  // scroll-reset on every review keystroke. The sibling effect below at
  // `activeAnnotationId`-change handles the scroll-to-active flow for that
  // path. The `didMountFiltersRef` guard skips the initial mount so opening
  // a document doesn't trigger a spurious reset.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const didMountFiltersRef = useRef(false);
  const activeAnnotationIdRef = useRef(activeAnnotationId);
  activeAnnotationIdRef.current = activeAnnotationId;
  useEffect(() => {
    if (!didMountFiltersRef.current) {
      didMountFiltersRef.current = true;
      return;
    }
    const currentActive = activeAnnotationIdRef.current;
    if (currentActive) {
      const card = document.querySelector(`[data-testid="annotation-card-${currentActive}"]`);
      if (card) {
        card.scrollIntoView({ block: "center" });
        return;
      }
      // Card not in the DOM after a filter change — either the active
      // annotation was filtered out or the render hasn't committed yet.
      // Fall through to scroll-to-top but log so "scroll jumped
      // unexpectedly" bug reports are diagnosable.
      console.warn(
        `[tandem] SidePanel: active annotation ${currentActive} not found on filter change; scrolling to top`,
      );
    }
    scrollContainerRef.current?.scrollTo({ top: 0 });
  }, [filterType, filterAuthor, filterStatus]);

  // Scroll to and flash the annotation card when activeAnnotationId changes externally
  useEffect(() => {
    if (!activeAnnotationId) return;
    // Small delay to let the panel become visible if the tab was just switched
    const timer = setTimeout(() => {
      const card = document.querySelector(`[data-testid="annotation-card-${activeAnnotationId}"]`);
      if (card) {
        card.scrollIntoView({ behavior: scrollBehavior, block: "nearest" });
        card.classList.add("tandem-annotation-flash");
        const onEnd = () => card.classList.remove("tandem-annotation-flash");
        card.addEventListener("animationend", onEnd, { once: true });
      } else {
        // Mirrors the filter-change effect's fallback — without this a card
        // missing from the DOM (panel hidden, annotation filtered out,
        // listRef-wrong-element-class regression) would silently no-op and
        // "my clicked annotation didn't scroll" becomes invisible.
        console.warn(
          `[tandem] SidePanel: active annotation ${activeAnnotationId} not found after 50ms delay; scroll-to-card skipped`,
        );
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [activeAnnotationId, scrollBehavior]);

  const hasFilters = filterType !== "all" || filterAuthor !== "all" || filterStatus !== "all";

  return (
    <div
      ref={scrollContainerRef}
      data-testid="annotation-list-scroll-container"
      style={{
        width: "100%",
        background: "var(--tandem-surface-muted)",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
      }}
    >
      {/* Held-annotation banner */}
      {heldCount > 0 && (
        <div
          style={{
            padding: "6px 16px",
            background: warningStateColors.background,
            borderBottom: `1px solid ${warningStateColors.border}`,
            fontSize: "12px",
            color: warningStateColors.color,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span data-testid="held-banner">
            {heldCount} annotation{heldCount !== 1 ? "s" : ""} held
          </span>
          <button
            onClick={() => onModeChange?.("tandem")}
            style={{
              fontSize: "11px",
              padding: "1px 8px",
              border: "1px solid var(--tandem-warning-border)",
              borderRadius: "4px",
              background: "var(--tandem-surface)",
              color: "var(--tandem-warning-fg-strong)",
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            Show all
          </button>
        </div>
      )}
      {/* Header */}
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--tandem-border)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ fontSize: "14px", fontWeight: 600, margin: 0 }}>
            Annotations
            {allPending.length > 0 && (
              <span
                style={{
                  marginLeft: "8px",
                  padding: "1px 6px",
                  fontSize: "11px",
                  background: "var(--tandem-accent)",
                  color: "var(--tandem-accent-fg)",
                  borderRadius: "10px",
                }}
              >
                {allPending.length}
              </span>
            )}
          </h3>
          <span
            aria-live="polite"
            style={{
              position: "absolute",
              width: 1,
              height: 1,
              overflow: "hidden",
              clip: "rect(0,0,0,0)",
            }}
          >
            {allPending.length} pending annotation{allPending.length !== 1 ? "s" : ""}
          </span>
          {allPending.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
              <button
                data-testid="review-mode-btn"
                onClick={onToggleReviewMode}
                title="Keyboard review mode (Ctrl+Shift+R)"
                aria-pressed={reviewMode}
                style={{
                  padding: "2px 8px",
                  fontSize: "11px",
                  border: `1px solid ${reviewMode ? "var(--tandem-accent)" : "var(--tandem-border-strong)"}`,
                  borderRadius: "3px",
                  background: reviewMode ? "var(--tandem-accent-bg)" : "var(--tandem-surface)",
                  color: reviewMode ? "var(--tandem-accent)" : "var(--tandem-fg-muted)",
                  cursor: "pointer",
                  fontWeight: reviewMode ? 600 : 400,
                }}
              >
                {reviewMode ? "Exit Review" : "Review"}
              </button>
              <div
                data-testid="review-shortcut-hints"
                style={{
                  fontSize: "10px",
                  color: "var(--tandem-fg-subtle)",
                  marginTop: "2px",
                }}
              >
                Y / N / ↑↓ / Z
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Review mode indicator */}
      {reviewMode && review.reviewTargets.length > 0 && (
        <div
          style={{
            padding: "8px 16px",
            background: "var(--tandem-accent-bg)",
            borderBottom: "1px solid var(--tandem-border)",
            fontSize: "12px",
            color: "var(--tandem-accent-fg-strong)",
          }}
        >
          <div aria-live="polite" style={{ fontWeight: 600, marginBottom: "2px" }}>
            Reviewing {review.reviewIndex + 1} / {review.reviewTargets.length}
          </div>
          <div style={{ color: "var(--tandem-accent)" }}>
            Tab: next · Shift+Tab: prev · Y: accept · N: dismiss · Z: undo · E: examine · Esc: exit
          </div>
        </div>
      )}

      {/* Filters */}
      <FilterBar
        filterType={filterType}
        setFilterType={setFilterType}
        filterAuthor={filterAuthor}
        setFilterAuthor={setFilterAuthor}
        filterStatus={filterStatus}
        setFilterStatus={setFilterStatus}
        hasFilters={hasFilters}
        onClearFilters={() => {
          setFilterType("all");
          setFilterAuthor("all");
          setFilterStatus("all");
          // Scroll reset is handled centrally by the filter-change
          // useEffect above — it also scrolls active review annotations
          // into view instead of jumping to the top.
        }}
      />

      {/* Apply as tracked changes (docx only) */}
      <div style={{ padding: "4px 16px 0" }}>
        <ApplyChangesButton
          annotations={annotations}
          activeDocFormat={activeDocFormat}
          documentId={documentId}
        />
      </div>

      {/* Bulk actions */}
      <BulkActions
        bulkConfirm={bulkConfirm}
        pendingCount={pending.length}
        allPendingCount={allPending.length}
        confirmRef={review.confirmRef}
        onConfirmAccept={() => handleBulk("accepted")}
        onConfirmDismiss={() => handleBulk("dismissed")}
        onCancel={() => setBulkConfirm(null)}
        onRequestAccept={() => setBulkConfirm("accept")}
        onRequestDismiss={() => setBulkConfirm("dismiss")}
      />

      {/* Annotation list */}
      <div style={{ padding: "8px 16px", flex: 1 }} role="list" aria-label="Annotations">
        {filtered.length === 0 ? (
          <p
            role="status"
            style={{ fontSize: "13px", color: "var(--tandem-fg-subtle)", marginTop: "8px" }}
          >
            {hasFilters
              ? "No annotations match filters."
              : "No annotations yet. Open a document to get started."}
          </p>
        ) : (
          <>
            {pending.map((ann) => {
              const isTarget = review.activeReviewAnn?.id === ann.id;
              return (
                <AnnotationCard
                  key={ann.id}
                  annotation={ann}
                  replies={repliesMap.get(ann.id) ?? []}
                  isReviewTarget={isTarget}
                  onAccept={review.handleAccept}
                  onDismiss={review.handleDismiss}
                  onEdit={handleEdit}
                  onReply={handleReply}
                  onClick={() => review.scrollToAnnotation(ann)}
                />
              );
            })}
            {resolved.length > 0 && (
              <details style={{ marginTop: "12px" }}>
                <summary
                  style={{ fontSize: "12px", color: "var(--tandem-fg-subtle)", cursor: "pointer" }}
                >
                  {resolved.length} resolved
                </summary>
                <div role="list" aria-label="Resolved annotations">
                  {resolved.map((ann) => (
                    <AnnotationCard
                      key={ann.id}
                      annotation={ann}
                      replies={repliesMap.get(ann.id) ?? []}
                      onUndo={review.undoResolveAnnotation}
                      undoable={review.recentlyResolved.has(ann.id)}
                      onClick={() => review.scrollToAnnotation(ann)}
                    />
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </div>
      <style>{`
        @keyframes tandem-annotation-flash {
          0% { background-color: color-mix(in srgb, var(--tandem-accent) 20%, transparent); }
          100% { background-color: transparent; }
        }
        .tandem-annotation-flash {
          animation: tandem-annotation-flash 0.8s ease-out;
        }
        @media (prefers-reduced-motion: reduce) {
          .tandem-annotation-flash { animation: none; }
        }
        body.tandem-reduce-motion .tandem-annotation-flash { animation: none; }
      `}</style>
    </div>
  );
}
