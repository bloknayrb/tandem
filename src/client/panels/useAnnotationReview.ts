import type { Editor as TiptapEditor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../shared/constants";
import { sanitizeAnnotation } from "../../shared/sanitize";
import type { Annotation } from "../../shared/types";
import { useReviewKeyboard } from "../hooks/useReviewKeyboard";
import { annotationToPmRange } from "../positions";

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

interface UseAnnotationReviewParams {
  ydocRef: React.RefObject<Y.Doc | null>;
  editorRef: React.RefObject<TiptapEditor | null>;
  annotations: Annotation[];
  onActiveAnnotationChange: (id: string | null) => void;
  reviewMode: boolean;
  onToggleReviewMode: () => void;
  onExitReviewMode: () => void;
  bulkConfirmRef: React.RefObject<"accept" | "dismiss" | null>;
  setBulkConfirm: (v: "accept" | "dismiss" | null) => void;
  scrollBehavior: ScrollBehavior;
}

export interface UseAnnotationReviewReturn {
  resolveAnnotation: (id: string, status: "accepted" | "dismissed") => void;
  undoResolveAnnotation: (id: string) => boolean;
  handleAccept: (id: string) => void;
  handleDismiss: (id: string) => void;
  scrollToAnnotation: (ann: Annotation) => void;
  recentlyResolved: Set<string>;
  reviewIndex: number;
  reviewTargets: Annotation[];
  activeReviewAnn: Annotation | null;
  confirmRef: React.RefObject<HTMLButtonElement | null>;
}

export function useAnnotationReview({
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
}: UseAnnotationReviewParams): UseAnnotationReviewReturn {
  const [reviewIndex, setReviewIndex] = useState(0);
  const reviewIndexRef = useRef(0);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  const [recentlyResolved, setRecentlyResolved] = useState<Set<string>>(new Set());
  const lastResolvedRef = useRef<string | null>(null);
  const pendingRemovalTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(
    () => () => {
      for (const timer of pendingRemovalTimers.current.values()) clearTimeout(timer);
    },
    [],
  );

  // Keyboard review targets only pending annotations (unfiltered)
  const reviewTargets = useMemo(
    () => annotations.filter((a) => a.status === "pending"),
    [annotations],
  );
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

    lastResolvedRef.current = id;
    setRecentlyResolved((prev) => new Set(prev).add(id));
  }

  function scheduleRemoval(id: string) {
    const existing = pendingRemovalTimers.current.get(id);
    if (existing) clearTimeout(existing);
    pendingRemovalTimers.current.set(
      id,
      setTimeout(() => {
        pendingRemovalTimers.current.delete(id);
        setRecentlyResolved((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 3000),
    );
  }

  function removeFromResolved(id: string) {
    const timer = pendingRemovalTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      pendingRemovalTimers.current.delete(id);
    }
    setRecentlyResolved((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  /** Revert a resolved annotation back to pending, undoing text changes for accepted suggestions.
   * Returns true on success, false when the text-changed guard fires (undo blocked). */
  function undoResolveAnnotation(id: string): boolean {
    const y = ydocRef.current;
    if (!y) return false;
    const map = y.getMap(Y_MAP_ANNOTATIONS);
    const raw = map.get(id) as Annotation | undefined;
    if (!raw || raw.status === "pending") {
      removeFromResolved(id);
      return false;
    }
    const ann = sanitizeAnnotation(raw);

    if (ann.status === "accepted" && ann.suggestedText !== undefined && editorRef.current) {
      try {
        const newText = ann.suggestedText;
        const oldText = ann.textSnapshot;
        if (typeof newText === "string" && typeof oldText === "string") {
          const resolved = annotationToPmRange(ann, editorRef.current.state.doc, y);
          if (!resolved) {
            console.warn(`[undo] Cannot resolve range for annotation ${id}, skipping`);
            scheduleRemoval(id);
            return false;
          }
          const currentText = editorRef.current.state.doc.textBetween(resolved.from, resolved.to);
          if (currentText !== newText) {
            console.warn(`[undo] Text changed since accept for annotation ${id}, skipping`);
            scheduleRemoval(id);
            return false;
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
        scheduleRemoval(id);
        return false;
      }
    }

    map.set(id, { ...ann, status: "pending" as const });
    removeFromResolved(id);
    if (lastResolvedRef.current === id) {
      lastResolvedRef.current = null;
    }
    return true;
  }

  function handleAccept(id: string) {
    resolveAnnotation(id, "accepted");
  }

  function handleDismiss(id: string) {
    resolveAnnotation(id, "dismissed");
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
    [scrollBehavior, editorRef, ydocRef],
  );

  // Stable keyboard review callbacks (use refs to avoid stale closures)
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
  }, [onExitReviewMode, bulkConfirmRef, setBulkConfirm]);

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

  const activeReviewAnn =
    reviewMode && reviewTargets.length > 0 ? reviewTargets[reviewIndex] : null;

  return {
    resolveAnnotation,
    undoResolveAnnotation,
    handleAccept,
    handleDismiss,
    scrollToAnnotation,
    recentlyResolved,
    reviewIndex,
    reviewTargets,
    activeReviewAnn,
    confirmRef,
  };
}
