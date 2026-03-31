import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { Editor as TiptapEditor } from "@tiptap/react";
import * as Y from "yjs";
import type { Annotation, AnnotationType, InterruptionMode } from "../../shared/types";
import { Y_MAP_ANNOTATIONS } from "../../shared/constants";
import { annotationToPmRange } from "../positions";
import { AnnotationCard } from "./AnnotationCard";
import { FilterSelect } from "./FilterSelect";
import { useReviewKeyboard } from "../hooks/useReviewKeyboard";

interface SidePanelProps {
  annotations: Annotation[];
  editor: TiptapEditor | null;
  ydoc: Y.Doc | null;
  heldCount?: number;
  interruptionMode?: InterruptionMode;
  onModeChange?: (mode: InterruptionMode) => void;
  reviewMode: boolean;
  onToggleReviewMode: () => void;
  onExitReviewMode: () => void;
  activeAnnotationId: string | null;
  onActiveAnnotationChange: (id: string | null) => void;
}

const SMALL_BTN: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: "11px",
  border: "1px solid #d1d5db",
  borderRadius: "3px",
  cursor: "pointer",
};

type FilterType = AnnotationType | "all";
type FilterAuthor = "all" | "claude" | "user" | "import";
type FilterStatus = "all" | "pending" | "accepted" | "dismissed";

/** Apply a suggestion annotation's text replacement in the editor */
function applySuggestion(ann: Annotation, editor: TiptapEditor, ydoc: Y.Doc | null) {
  if (ann.type !== "suggestion") return;
  try {
    const { newText } = JSON.parse(ann.content);
    if (typeof newText === "string") {
      const resolved = annotationToPmRange(ann, editor.state.doc, ydoc);
      if (!resolved) return;
      editor
        .chain()
        .focus()
        .deleteRange({ from: resolved.from, to: resolved.to })
        .insertContentAt(resolved.from, newText)
        .run();
    }
  } catch {
    // Malformed suggestion content
  }
}

export function SidePanel({
  annotations,
  editor,
  ydoc,
  heldCount = 0,
  interruptionMode: _interruptionMode,
  onModeChange,
  reviewMode,
  onToggleReviewMode,
  onExitReviewMode,
  activeAnnotationId: _activeAnnotationId,
  onActiveAnnotationChange,
}: SidePanelProps) {
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

  // Single-pass filtering + categorization
  const { filtered, pending, resolved, allPending } = useMemo(() => {
    const filtered: Annotation[] = [];
    const allPending: Annotation[] = [];

    for (const a of annotations) {
      if (a.status === "pending") allPending.push(a);
      const matchType = filterType === "all" || a.type === filterType;
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
    const ann = map.get(id) as Annotation | undefined;
    if (!ann) return;
    map.set(id, { ...ann, status });
    if (status === "accepted" && editorRef.current) {
      applySuggestion(ann, editorRef.current, ydocRef.current);
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
    const ann = map.get(id) as Annotation | undefined;
    if (!ann || ann.status === "pending") return;

    // If it was an accepted suggestion, revert the text edit first.
    // If text revert fails, don't revert status — half-undo is worse than no undo.
    if (ann.status === "accepted" && ann.type === "suggestion" && editorRef.current) {
      try {
        const { newText } = JSON.parse(ann.content);
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
    const ann = map.get(id) as Annotation | undefined;
    if (!ann) return;
    map.set(id, { ...ann, content: newContent, editedAt: Date.now() });
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
  const scrollToAnnotation = useCallback((ann: Annotation) => {
    const ed = editorRef.current;
    if (!ed) return;
    const resolved = annotationToPmRange(ann, ed.state.doc, ydocRef.current);
    if (!resolved) return;
    ed.chain().focus().setTextSelection({ from: resolved.from, to: resolved.to }).run();
    const domAtPos = ed.view.domAtPos(resolved.from);
    const el = domAtPos.node instanceof HTMLElement ? domAtPos.node : domAtPos.node.parentElement;
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

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

  // Reset confirmation when filtered pending set changes
  useEffect(() => {
    setBulkConfirm(null);
  }, [pending.length]);

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

  const hasFilters = filterType !== "all" || filterAuthor !== "all" || filterStatus !== "all";
  const activeReviewAnn =
    reviewMode && reviewTargets.length > 0 ? reviewTargets[reviewIndex] : null;

  return (
    <div
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
          <span>
            {heldCount} annotation{heldCount !== 1 ? "s" : ""} held
          </span>
          <button
            onClick={() => onModeChange?.("all")}
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
      <div style={{ padding: "12px 16px", borderBottom: "1px solid #e5e7eb" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ fontSize: "14px", fontWeight: 600, margin: 0 }}>
            Annotations
            {allPending.length > 0 && (
              <span
                style={{
                  marginLeft: "8px",
                  padding: "1px 6px",
                  fontSize: "11px",
                  background: "#6366f1",
                  color: "white",
                  borderRadius: "10px",
                }}
              >
                {allPending.length}
              </span>
            )}
          </h3>
          {allPending.length > 0 && (
            <button
              data-testid="review-mode-btn"
              onClick={onToggleReviewMode}
              title="Keyboard review mode (Ctrl+Shift+R)"
              style={{
                padding: "2px 8px",
                fontSize: "11px",
                border: `1px solid ${reviewMode ? "#6366f1" : "#d1d5db"}`,
                borderRadius: "3px",
                background: reviewMode ? "#eef2ff" : "#fff",
                color: reviewMode ? "#6366f1" : "#6b7280",
                cursor: "pointer",
                fontWeight: reviewMode ? 600 : 400,
              }}
            >
              {reviewMode ? "Exit Review" : "Review"}
            </button>
          )}
        </div>
      </div>

      {/* Review mode indicator */}
      {reviewMode && reviewTargets.length > 0 && (
        <div
          style={{
            padding: "8px 16px",
            background: "#eef2ff",
            borderBottom: "1px solid #e5e7eb",
            fontSize: "12px",
            color: "#4338ca",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: "2px" }}>
            Reviewing {reviewIndex + 1} / {reviewTargets.length}
          </div>
          <div style={{ color: "#6366f1" }}>
            Tab: next · Shift+Tab: prev · Y: accept · N: dismiss · Z: undo · E: examine · Esc: exit
          </div>
        </div>
      )}

      {/* Filters */}
      <div
        style={{
          padding: "8px 16px",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          gap: "4px",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <FilterSelect
          value={filterType}
          onChange={(v) => setFilterType(v as FilterType)}
          options={[
            { value: "all", label: "All types" },
            { value: "highlight", label: "Highlights" },
            { value: "comment", label: "Comments" },
            { value: "suggestion", label: "Suggestions" },
            { value: "question", label: "Questions" },
            { value: "flag", label: "Flags" },
          ]}
        />
        <FilterSelect
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
            onClick={() => {
              setFilterType("all");
              setFilterAuthor("all");
              setFilterStatus("all");
            }}
            style={{
              background: "none",
              border: "none",
              color: "#6366f1",
              fontSize: "11px",
              cursor: "pointer",
              padding: "2px 4px",
            }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Bulk actions */}
      {pending.length > 1 && (
        <div
          style={{
            padding: "6px 16px",
            borderBottom: "1px solid #e5e7eb",
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
                  <span style={{ fontSize: "11px", color: "#374151" }}>
                    {isAccept ? "Accept" : "Dismiss"}{" "}
                    {pending.length === allPending.length
                      ? `${pending.length} annotations?`
                      : `${pending.length} of ${allPending.length} pending?`}
                  </span>
                  <button
                    ref={confirmRef}
                    onClick={isAccept ? handleBulkAccept : handleBulkDismiss}
                    style={{
                      ...SMALL_BTN,
                      background: isAccept ? "#f0fdf4" : "#fef2f2",
                      color: isAccept ? "#166534" : "#991b1b",
                      fontWeight: 600,
                    }}
                  >
                    Confirm
                  </button>
                  <button
                    onClick={() => setBulkConfirm(null)}
                    style={{ ...SMALL_BTN, background: "#fff", color: "#6b7280" }}
                  >
                    Cancel
                  </button>
                </>
              );
            })()
          ) : (
            <>
              <button
                onClick={() => setBulkConfirm("accept")}
                style={{ ...SMALL_BTN, background: "#f0fdf4", color: "#166534" }}
              >
                Accept All ({pending.length})
              </button>
              <button
                onClick={() => setBulkConfirm("dismiss")}
                style={{ ...SMALL_BTN, background: "#fef2f2", color: "#991b1b" }}
              >
                Dismiss All
              </button>
            </>
          )}
        </div>
      )}

      {/* Annotation list */}
      <div style={{ padding: "8px 16px", flex: 1 }}>
        {filtered.length === 0 ? (
          <p style={{ fontSize: "13px", color: "#9ca3af", marginTop: "8px" }}>
            {hasFilters
              ? "No annotations match filters."
              : "No annotations yet. Open a document to get started."}
          </p>
        ) : (
          <>
            {pending.map((ann) => (
              <AnnotationCard
                key={ann.id}
                annotation={ann}
                isReviewTarget={activeReviewAnn?.id === ann.id}
                onAccept={handleAccept}
                onDismiss={handleDismiss}
                onEdit={handleEdit}
                onClick={() => scrollToAnnotation(ann)}
              />
            ))}
            {resolved.length > 0 && (
              <details style={{ marginTop: "12px" }}>
                <summary style={{ fontSize: "12px", color: "#9ca3af", cursor: "pointer" }}>
                  {resolved.length} resolved
                </summary>
                {resolved.map((ann) => (
                  <AnnotationCard
                    key={ann.id}
                    annotation={ann}
                    onUndo={handleUndo}
                    undoable={recentlyResolved.has(ann.id)}
                    onClick={() => scrollToAnnotation(ann)}
                  />
                ))}
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
