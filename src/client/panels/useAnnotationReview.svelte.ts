import type { Editor as TiptapEditor } from "@tiptap/core";
import { onDestroy } from "svelte";
import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../shared/constants";
import type { SanitizationEvent } from "../../shared/sanitize";
import { sanitizeAnnotation } from "../../shared/sanitize";
import type { Annotation } from "../../shared/types";
import { isPendingReviewTarget } from "../../shared/types";
import { annotationToPmRange } from "../positions";

/** Browser DevTools breadcrumb — only forensic trail client-side when sanitize coerces. */
const devSanitizeWarn = (event: SanitizationEvent): void => {
  console.warn("[sanitize]", event);
};

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

export interface UseAnnotationReviewParams {
  /** Getter for current Y.Doc — avoids React-style ref ceremony. */
  getYdoc: () => Y.Doc | null;
  /** Getter for current editor instance. */
  getEditor: () => TiptapEditor | null;
  /** Reactive annotations array. */
  getAnnotations: () => Annotation[];
  onActiveAnnotationChange: (id: string | null) => void;
  getReviewMode: () => boolean;
  onToggleReviewMode: () => void;
  onExitReviewMode: () => void;
  getBulkConfirm: () => "accept" | "dismiss" | null;
  setBulkConfirm: (v: "accept" | "dismiss" | null) => void;
  getScrollBehavior: () => ScrollBehavior;
}

export interface UseAnnotationReviewReturn {
  resolveAnnotation: (id: string, status: "accepted" | "dismissed") => void;
  undoResolveAnnotation: (id: string) => boolean;
  handleAccept: (id: string) => void;
  handleDismiss: (id: string) => void;
  scrollToAnnotation: (ann: Annotation) => void;
  getRecentlyResolved: () => Set<string>;
  getReviewIndex: () => number;
  getReviewTargets: () => Annotation[];
  getActiveReviewAnn: () => Annotation | null;
  /** Bind a button element here to allow programmatic focus on bulk confirm. */
  confirmEl: HTMLButtonElement | null;
}

/**
 * Svelte 5 port of useAnnotationReview.ts.
 *
 * Uses getter functions instead of React RefObjects to avoid stale-closure
 * issues. Internal state is Svelte $state runes; reactive derivations are
 * computed inline within returned getters.
 */
export function useAnnotationReview({
  getYdoc,
  getEditor,
  getAnnotations,
  onActiveAnnotationChange,
  getReviewMode,
  onToggleReviewMode,
  onExitReviewMode,
  getBulkConfirm,
  setBulkConfirm,
  getScrollBehavior,
}: UseAnnotationReviewParams): UseAnnotationReviewReturn {
  // Reactive state
  let reviewIndex = $state(0);
  let recentlyResolved = $state(new Set<string>());
  const pendingRemovalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let lastResolvedId: string | null = null;

  // Confirm button DOM binding (caller uses bind:this or sets directly)
  const confirmEl: HTMLButtonElement | null = $state(null);

  // Cleanup timers on component destroy
  onDestroy(() => {
    for (const timer of pendingRemovalTimers.values()) clearTimeout(timer);
    pendingRemovalTimers.clear();
  });

  function getReviewTargets(): Annotation[] {
    return getAnnotations().filter(isPendingReviewTarget);
  }

  function getActiveReviewAnn(): Annotation | null {
    const reviewMode = getReviewMode();
    const targets = getReviewTargets();
    return reviewMode && targets.length > 0 ? (targets[reviewIndex] ?? null) : null;
  }

  function resolveAnnotation(id: string, status: "accepted" | "dismissed") {
    const y = getYdoc();
    if (!y) return;
    const map = y.getMap(Y_MAP_ANNOTATIONS);
    const raw = map.get(id) as Annotation | undefined;
    if (!raw) return;
    const ann = sanitizeAnnotation(raw, devSanitizeWarn);
    map.set(id, { ...ann, status });

    if (status === "accepted" && ann.suggestedText !== undefined) {
      const editor = getEditor();
      if (editor) {
        const applied = applySuggestion(ann, editor, y);
        if (!applied) {
          // Revert annotation status — text replacement failed
          map.set(id, { ...ann, status: "pending" });
          return;
        }
      }
    }

    lastResolvedId = id;
    recentlyResolved = new Set(recentlyResolved).add(id);
  }

  function scheduleRemoval(id: string) {
    const existing = pendingRemovalTimers.get(id);
    if (existing) clearTimeout(existing);
    pendingRemovalTimers.set(
      id,
      setTimeout(() => {
        pendingRemovalTimers.delete(id);
        const next = new Set(recentlyResolved);
        next.delete(id);
        recentlyResolved = next;
      }, 3000),
    );
  }

  function removeFromResolved(id: string) {
    const timer = pendingRemovalTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      pendingRemovalTimers.delete(id);
    }
    const next = new Set(recentlyResolved);
    next.delete(id);
    recentlyResolved = next;
  }

  function undoResolveAnnotation(id: string): boolean {
    const y = getYdoc();
    if (!y) return false;
    const map = y.getMap(Y_MAP_ANNOTATIONS);
    const raw = map.get(id) as Annotation | undefined;
    if (!raw || raw.status === "pending") {
      removeFromResolved(id);
      return false;
    }
    const ann = sanitizeAnnotation(raw, devSanitizeWarn);
    const editor = getEditor();

    if (ann.status === "accepted" && ann.suggestedText !== undefined && editor) {
      try {
        const newText = ann.suggestedText;
        const oldText = ann.textSnapshot;
        if (typeof newText === "string" && typeof oldText === "string") {
          const resolved = annotationToPmRange(ann, editor.state.doc, y);
          if (!resolved) {
            console.warn(`[undo] Cannot resolve range for annotation ${id}, skipping`);
            scheduleRemoval(id);
            return false;
          }
          const currentText = editor.state.doc.textBetween(resolved.from, resolved.to);
          if (currentText !== newText) {
            console.warn(`[undo] Text changed since accept for annotation ${id}, skipping`);
            scheduleRemoval(id);
            return false;
          }
          editor
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
    if (lastResolvedId === id) {
      lastResolvedId = null;
    }
    return true;
  }

  function handleAccept(id: string) {
    resolveAnnotation(id, "accepted");
  }

  function handleDismiss(id: string) {
    resolveAnnotation(id, "dismissed");
  }

  function scrollToAnnotation(ann: Annotation) {
    const ed = getEditor();
    if (!ed) return;
    const resolved = annotationToPmRange(ann, ed.state.doc, getYdoc());
    if (!resolved) return;
    ed.chain().focus().setTextSelection({ from: resolved.from, to: resolved.to }).run();
    const domAtPos = ed.view.domAtPos(resolved.from);
    const el = domAtPos.node instanceof HTMLElement ? domAtPos.node : domAtPos.node.parentElement;
    el?.scrollIntoView({ behavior: getScrollBehavior(), block: "center" });
  }

  // Navigation
  function navigateReview(direction: "next" | "prev") {
    const targets = getReviewTargets();
    if (targets.length === 0) return;
    let idx = reviewIndex;
    idx =
      direction === "next"
        ? (idx + 1) % targets.length
        : (idx - 1 + targets.length) % targets.length;
    reviewIndex = idx;
    const target = targets[idx];
    if (target) scrollToAnnotation(target);
  }

  function acceptCurrent() {
    const targets = getReviewTargets();
    if (targets.length === 0) return;
    const ann = targets[reviewIndex];
    if (ann) resolveAnnotation(ann.id, "accepted");
  }

  function dismissCurrent() {
    const targets = getReviewTargets();
    if (targets.length === 0) return;
    const ann = targets[reviewIndex];
    if (ann) resolveAnnotation(ann.id, "dismissed");
  }

  function scrollToCurrentAndExit() {
    const targets = getReviewTargets();
    const ann = targets[reviewIndex];
    if (ann) scrollToAnnotation(ann);
    onExitReviewMode();
  }

  function undoLast() {
    if (lastResolvedId) undoResolveAnnotation(lastResolvedId);
  }

  function cancelBulkOrExit() {
    if (getBulkConfirm()) {
      setBulkConfirm(null);
    } else {
      onExitReviewMode();
    }
  }

  // Keyboard handler for review mode
  function handleKeyDown(e: KeyboardEvent) {
    if (e.ctrlKey && e.shiftKey && e.key === "R") {
      e.preventDefault();
      onToggleReviewMode();
      return;
    }

    if (!getReviewMode()) return;

    if (e.key === "Tab" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      navigateReview(e.shiftKey ? "prev" : "next");
    } else if (e.key === "y" || e.key === "Y") {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      acceptCurrent();
    } else if (e.key === "n" || e.key === "N") {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      dismissCurrent();
    } else if (e.key === "z" || e.key === "Z") {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      undoLast();
    } else if (e.key === "e" || e.key === "E") {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      scrollToCurrentAndExit();
    } else if (e.key === "Escape") {
      cancelBulkOrExit();
    }
  }

  // Register keyboard listener; re-register whenever reviewMode changes.
  // Because Svelte effects track reactive reads, we read getReviewMode() inside
  // the effect body so it re-runs on changes.
  $effect(() => {
    // Capture current reviewMode for the closure — not strictly needed since
    // handleKeyDown() calls getReviewMode() fresh, but needed to make the
    // effect reactive to reviewMode changes so the listener is always current.
    const _reviewMode = getReviewMode();
    void _reviewMode; // consumed for reactivity tracking
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  // Sync activeAnnotationId when review index changes
  $effect(() => {
    const reviewMode = getReviewMode();
    const targets = getReviewTargets();
    if (reviewMode && targets.length > 0) {
      onActiveAnnotationChange(targets[reviewIndex]?.id ?? null);
    } else {
      onActiveAnnotationChange(null);
    }
  });

  // Scroll to first annotation when entering review mode
  let prevReviewMode = false;
  $effect(() => {
    const reviewMode = getReviewMode();
    const targets = getReviewTargets();
    if (reviewMode && !prevReviewMode && targets.length > 0) {
      reviewIndex = 0;
      scrollToAnnotation(targets[0]);
    }
    prevReviewMode = reviewMode;
  });

  // Keep review index in bounds when annotations change
  $effect(() => {
    const reviewMode = getReviewMode();
    const targets = getReviewTargets();
    if (reviewMode && reviewIndex >= targets.length) {
      reviewIndex = Math.max(0, targets.length - 1);
    }
  });

  // Auto-exit when no pending left
  $effect(() => {
    const reviewMode = getReviewMode();
    const targets = getReviewTargets();
    if (reviewMode && targets.length === 0) {
      onExitReviewMode();
    }
  });

  return {
    resolveAnnotation,
    undoResolveAnnotation,
    handleAccept,
    handleDismiss,
    scrollToAnnotation,
    getRecentlyResolved: () => recentlyResolved,
    getReviewIndex: () => reviewIndex,
    getReviewTargets,
    getActiveReviewAnn,
    confirmEl,
  };
}
