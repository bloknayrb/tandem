import type { Editor as TiptapEditor } from "@tiptap/react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import {
  DEFAULT_MCP_PORT,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
} from "../../shared/constants";
import { sanitizeAnnotation } from "../../shared/sanitize";
import type { Annotation, AnnotationReply, AnnotationType, TandemMode } from "../../shared/types";
import { ApplyChangesButton } from "../components/ApplyChangesButton";
import { useReviewKeyboard } from "../hooks/useReviewKeyboard";
import { annotationToPmRange } from "../positions";
import { AnnotationCard } from "./AnnotationCard";
import { FilterSelect } from "./FilterSelect";

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

const SMALL_BTN: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: "11px",
  border: "1px solid var(--tandem-border-strong)",
  borderRadius: "3px",
  cursor: "pointer",
};

type FilterType = AnnotationType | "all" | "with-replacement" | "for-claude";
type FilterAuthor = "all" | "claude" | "user" | "import";
type FilterStatus = "all" | "pending" | "accepted" | "dismissed";

/** Apply an annotation's replacement text in the editor */
function applySuggestion(ann: Annotation, editor: TiptapEditor, ydoc: Y.Doc | null): boolean {
  if (ann.suggestedText === undefined) return false;

  const newText = ann.suggestedText;

  const resolved = annotationToPmRange(ann, editor.state.doc, ydoc);
  if (!resolved) {
    console.warn("[SidePanel] Could not resolve range for suggestion", ann.id);
    return false;
  }

  try {
    editor
      .chain()
      .focus()
      .deleteRange({ from: resolved.from, to: resolved.to })
      .insertContentAt(resolved.from, newText)
      .run();
  } catch (err) {
    console.error("[SidePanel] Editor mutation failed for suggestion", ann.id, err);
    return false;
  }
  return true;
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
  const [reviewIndex, setReviewIndex] = useState(0);
  const reviewIndexRef = useRef(0);
  const [bulkConfirm, setBulkConfirm] = useState<"accept" | "dismiss" | null>(null);
  const bulkConfirmRef = useRef(bulkConfirm);
  bulkConfirmRef.current = bulkConfirm;
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Track recently resolved annotations for timed undo (10s window)
  const [recentlyResolved, setRecentlyResolved] = useState<Set<string>>(new Set());
  // Track the last resolved annotation ID for keyboard undo (Z key)
  const lastResolvedRef = useRef<string | null>(null);
  // Timer IDs for undo window expiry — cancel on undo or unmount
  const undoTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    const timers = undoTimersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
    };
  }, []);

  // Stable refs for keyboard callbacks to avoid stale closures
  const ydocRef = useRef(ydoc);
  const editorRef = useRef(editor);
  ydocRef.current = ydoc;
  editorRef.current = editor;

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

  // Keyboard review targets only pending annotations (unfiltered)
  const reviewTargets = allPending;
  const reviewTargetsRef = useRef(reviewTargets);
  reviewTargetsRef.current = reviewTargets;

  function resolveAnnotation(id: string, status: "accepted" | "dismissed") {
    const y = ydocRef.current;
    if (!y) return;
    const map = y.getMap(Y_MAP_ANNOTATIONS);
    const raw = map.get(id) as Annotation | undefined;
    if (!raw) return;
    const ann = sanitizeAnnotation(raw);
    map.set(id, { ...ann, status });
    // Only annotations with suggestedText trigger a text replacement when
    // accepted. For plain comments/highlights/flags, accepting is just a
    // status change.
    if (status === "accepted" && ann.suggestedText !== undefined && editorRef.current) {
      const applied = applySuggestion(ann, editorRef.current, ydocRef.current);
      if (!applied) {
        // Revert annotation status — text replacement failed
        map.set(id, { ...ann, status: "pending" });
        return;
      }
    }

    // Track for timed undo
    lastResolvedRef.current = id;
    setRecentlyResolved((prev) => new Set(prev).add(id));
    const existingTimer = undoTimersRef.current.get(id);
    if (existingTimer) clearTimeout(existingTimer);
    const timerId = setTimeout(() => {
      undoTimersRef.current.delete(id);
      setRecentlyResolved((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (lastResolvedRef.current === id) {
        lastResolvedRef.current = null;
      }
    }, 10_000);
    undoTimersRef.current.set(id, timerId);
  }

  /** Revert a resolved annotation back to pending, undoing text changes for accepted suggestions */
  function undoResolveAnnotation(id: string) {
    const y = ydocRef.current;
    if (!y) return;
    const map = y.getMap(Y_MAP_ANNOTATIONS);
    const raw = map.get(id) as Annotation | undefined;
    if (!raw || raw.status === "pending") return;
    const ann = sanitizeAnnotation(raw);

    // If it was an accepted annotation with suggestedText, revert the text edit first.
    // If text revert fails, don't revert status — half-undo is worse than no undo.
    if (ann.status === "accepted" && ann.suggestedText !== undefined && editorRef.current) {
      try {
        const newText = ann.suggestedText;
        const oldText = ann.textSnapshot;
        if (typeof newText === "string" && typeof oldText === "string") {
          const resolved = annotationToPmRange(ann, editorRef.current.state.doc, y);
          if (!resolved) {
            console.warn(`[undo] Cannot resolve range for annotation ${id}, skipping`);
            return;
          }
          const currentText = editorRef.current.state.doc.textBetween(resolved.from, resolved.to);
          if (currentText !== newText) {
            console.warn(`[undo] Text changed since accept for annotation ${id}, skipping`);
            return;
          }
          editorRef.current
            .chain()
            .focus()
            .deleteRange({ from: resolved.from, to: resolved.to })
            .insertContentAt(resolved.from, oldText)
            .run();
        }
      } catch (err) {
        console.warn(`[undo] Failed to revert text for annotation ${id}:`, err);
        return;
      }
    }

    // Revert status to pending
    map.set(id, { ...ann, status: "pending" as const });

    // Clean up undo tracking
    const timer = undoTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      undoTimersRef.current.delete(id);
    }
    setRecentlyResolved((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    if (lastResolvedRef.current === id) {
      lastResolvedRef.current = null;
    }
  }

  function handleAccept(id: string) {
    resolveAnnotation(id, "accepted");
  }

  function handleDismiss(id: string) {
    resolveAnnotation(id, "dismissed");
  }

  function handleUndo(id: string) {
    undoResolveAnnotation(id);
  }

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

  function handleBulkAccept() {
    for (const ann of pending) resolveAnnotation(ann.id, "accepted");
    setBulkConfirm(null);
  }

  function handleBulkDismiss() {
    for (const ann of pending) resolveAnnotation(ann.id, "dismissed");
    setBulkConfirm(null);
  }

  // Scroll editor to an annotation's range
  const scrollToAnnotation = useCallback(
    (ann: Annotation) => {
      const ed = editorRef.current;
      if (!ed) return;
      const resolved = annotationToPmRange(ann, ed.state.doc, ydocRef.current);
      if (!resolved) return;
      ed.chain().focus().setTextSelection({ from: resolved.from, to: resolved.to }).run();
      const domAtPos = ed.view.domAtPos(resolved.from);
      const el = domAtPos.node instanceof HTMLElement ? domAtPos.node : domAtPos.node.parentElement;
      el?.scrollIntoView({ behavior: scrollBehavior, block: "center" });
    },
    [scrollBehavior],
  );

  // Stable keyboard review callbacks (use refs to avoid dep cascade)
  const navigateReview = useCallback(
    (direction: "next" | "prev") => {
      const targets = reviewTargetsRef.current;
      if (targets.length === 0) return;
      let idx = reviewIndexRef.current;
      idx =
        direction === "next"
          ? (idx + 1) % targets.length
          : (idx - 1 + targets.length) % targets.length;
      reviewIndexRef.current = idx;
      setReviewIndex(idx);
      scrollToAnnotation(targets[idx]);
    },
    [scrollToAnnotation],
  );

  const acceptCurrent = useCallback(() => {
    const targets = reviewTargetsRef.current;
    if (targets.length === 0) return;
    const ann = targets[reviewIndexRef.current];
    if (ann) resolveAnnotation(ann.id, "accepted");
  }, []);

  const dismissCurrent = useCallback(() => {
    const targets = reviewTargetsRef.current;
    if (targets.length === 0) return;
    const ann = targets[reviewIndexRef.current];
    if (ann) resolveAnnotation(ann.id, "dismissed");
  }, []);

  // Reset review index and scroll to first annotation when entering review mode
  const prevReviewModeRef = useRef(false);
  useEffect(() => {
    if (reviewMode && !prevReviewModeRef.current && reviewTargets.length > 0) {
      reviewIndexRef.current = 0;
      setReviewIndex(0);
      scrollToAnnotation(reviewTargets[0]);
    }
    prevReviewModeRef.current = reviewMode;
  }, [reviewMode, reviewTargets, scrollToAnnotation]);

  // Sync activeAnnotationId when review index changes
  useEffect(() => {
    if (reviewMode && reviewTargets.length > 0) {
      onActiveAnnotationChange(reviewTargets[reviewIndex]?.id ?? null);
    } else {
      onActiveAnnotationChange(null);
    }
  }, [reviewMode, reviewIndex, reviewTargets, onActiveAnnotationChange]);

  const scrollToCurrentAndExit = useCallback(() => {
    const targets = reviewTargetsRef.current;
    const ann = targets[reviewIndexRef.current];
    if (ann) scrollToAnnotation(ann);
    onExitReviewMode();
  }, [scrollToAnnotation, onExitReviewMode]);

  const undoLast = useCallback(() => {
    const id = lastResolvedRef.current;
    if (id) undoResolveAnnotation(id);
  }, []);

  const cancelBulkOrExit = useCallback(() => {
    if (bulkConfirmRef.current) {
      setBulkConfirm(null);
    } else {
      onExitReviewMode();
    }
  }, [onExitReviewMode]);

  const reviewCallbacks = useMemo(
    () => ({
      onToggleReviewMode,
      onExitReviewMode,
      navigateReview,
      acceptCurrent,
      dismissCurrent,
      scrollToCurrentAndExit,
      cancelBulkOrExit,
      undoLast,
    }),
    [
      onToggleReviewMode,
      onExitReviewMode,
      navigateReview,
      acceptCurrent,
      dismissCurrent,
      scrollToCurrentAndExit,
      cancelBulkOrExit,
      undoLast,
    ],
  );

  useReviewKeyboard(reviewMode, reviewCallbacks);

  // Focus confirm button when bulk confirmation appears
  useEffect(() => {
    if (bulkConfirm) confirmRef.current?.focus();
  }, [bulkConfirm]);

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

  // Keep review index in bounds when annotations change
  useEffect(() => {
    if (reviewMode && reviewIndexRef.current >= reviewTargets.length) {
      const newIdx = Math.max(0, reviewTargets.length - 1);
      reviewIndexRef.current = newIdx;
      setReviewIndex(newIdx);
    }
  }, [reviewMode, reviewTargets.length]);

  // Auto-exit review mode when no pending left
  useEffect(() => {
    if (reviewMode && reviewTargets.length === 0) {
      onExitReviewMode();
    }
  }, [reviewMode, reviewTargets.length, onExitReviewMode]);

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
  const activeReviewAnn =
    reviewMode && reviewTargets.length > 0 ? reviewTargets[reviewIndex] : null;

  return (
    <div
      ref={scrollContainerRef}
      data-testid="annotation-list-scroll-container"
      style={{
        width: "100%",
        background: "#fafafa",
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
            background: "#fef3c7",
            borderBottom: "1px solid #fde68a",
            fontSize: "12px",
            color: "#92400e",
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
              border: "1px solid #fbbf24",
              borderRadius: "4px",
              background: "#fff",
              color: "#92400e",
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
                  color: "white",
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
                  background: reviewMode ? "var(--tandem-accent-bg)" : "#fff",
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
      {reviewMode && reviewTargets.length > 0 && (
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
            Reviewing {reviewIndex + 1} / {reviewTargets.length}
          </div>
          <div style={{ color: "var(--tandem-accent)" }}>
            Tab: next · Shift+Tab: prev · Y: accept · N: dismiss · Z: undo · E: examine · Esc: exit
          </div>
        </div>
      )}

      {/* Filters */}
      <div
        style={{
          padding: "8px 16px",
          borderBottom: "1px solid var(--tandem-border)",
          display: "flex",
          gap: "4px",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <FilterSelect
          testId="filter-type"
          value={filterType}
          onChange={(v) => setFilterType(v as FilterType)}
          options={[
            { value: "all", label: "All types" },
            { value: "highlight", label: "Highlights" },
            { value: "comment", label: "Comments" },
            { value: "with-replacement", label: "With replacement" },
            { value: "for-claude", label: "For Claude" },
            { value: "flag", label: "Flags" },
          ]}
        />
        <FilterSelect
          testId="filter-author"
          value={filterAuthor}
          onChange={(v) => setFilterAuthor(v as FilterAuthor)}
          options={[
            { value: "all", label: "Anyone" },
            { value: "claude", label: "Claude" },
            { value: "user", label: "You" },
            { value: "import", label: "Imported" },
          ]}
        />
        <FilterSelect
          testId="filter-status"
          value={filterStatus}
          onChange={(v) => setFilterStatus(v as FilterStatus)}
          options={[
            { value: "all", label: "Any status" },
            { value: "pending", label: "Pending" },
            { value: "accepted", label: "Accepted" },
            { value: "dismissed", label: "Dismissed" },
          ]}
        />
        {hasFilters && (
          <button
            data-testid="clear-filters-btn"
            onClick={() => {
              setFilterType("all");
              setFilterAuthor("all");
              setFilterStatus("all");
              // Scroll reset is handled centrally by the filter-change
              // useEffect above — it also scrolls active review annotations
              // into view instead of jumping to the top.
            }}
            style={{
              background: "none",
              border: "none",
              color: "var(--tandem-accent)",
              fontSize: "11px",
              cursor: "pointer",
              padding: "2px 4px",
            }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Apply as tracked changes (docx only) */}
      <div style={{ padding: "4px 16px 0" }}>
        <ApplyChangesButton
          annotations={annotations}
          activeDocFormat={activeDocFormat}
          documentId={documentId}
        />
      </div>

      {/* Bulk actions */}
      {pending.length > 1 && (
        <div
          style={{
            padding: "6px 16px",
            borderBottom: "1px solid var(--tandem-border)",
            display: "flex",
            gap: "6px",
            alignItems: "center",
          }}
        >
          {bulkConfirm ? (
            (() => {
              const isAccept = bulkConfirm === "accept";
              return (
                <>
                  <span style={{ fontSize: "11px", color: "var(--tandem-fg)" }}>
                    {isAccept ? "Accept" : "Reject"}{" "}
                    {pending.length === allPending.length
                      ? `${pending.length} annotations?`
                      : `${pending.length} of ${allPending.length} pending?`}
                  </span>
                  <button
                    ref={confirmRef}
                    data-testid="bulk-confirm-btn"
                    onClick={isAccept ? handleBulkAccept : handleBulkDismiss}
                    style={{
                      ...SMALL_BTN,
                      background: isAccept
                        ? "#f0fdf4"
                        : "color-mix(in srgb, var(--tandem-error) 10%, var(--tandem-surface))",
                      color: isAccept ? "#166534" : "var(--tandem-error)",
                      fontWeight: 600,
                    }}
                  >
                    Confirm
                  </button>
                  <button
                    data-testid="bulk-cancel-btn"
                    onClick={() => setBulkConfirm(null)}
                    style={{ ...SMALL_BTN, background: "#fff", color: "var(--tandem-fg-muted)" }}
                  >
                    Cancel
                  </button>
                </>
              );
            })()
          ) : (
            <>
              <button
                data-testid="bulk-accept-btn"
                onClick={() => setBulkConfirm("accept")}
                style={{ ...SMALL_BTN, background: "#f0fdf4", color: "#166534" }}
              >
                Accept All ({pending.length})
              </button>
              <button
                data-testid="bulk-dismiss-btn"
                onClick={() => setBulkConfirm("dismiss")}
                style={{
                  ...SMALL_BTN,
                  background: "color-mix(in srgb, var(--tandem-error) 10%, var(--tandem-surface))",
                  color: "var(--tandem-error)",
                }}
              >
                Reject All
              </button>
            </>
          )}
        </div>
      )}

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
              const isTarget = activeReviewAnn?.id === ann.id;
              return (
                <AnnotationCard
                  key={ann.id}
                  annotation={ann}
                  replies={repliesMap.get(ann.id) ?? []}
                  isReviewTarget={isTarget}
                  onAccept={handleAccept}
                  onDismiss={handleDismiss}
                  onEdit={handleEdit}
                  onReply={handleReply}
                  onClick={() => scrollToAnnotation(ann)}
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
                      onUndo={handleUndo}
                      undoable={recentlyResolved.has(ann.id)}
                      onClick={() => scrollToAnnotation(ann)}
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
          0% { background-color: rgba(99, 102, 241, 0.2); }
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
