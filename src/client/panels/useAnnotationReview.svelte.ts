import type { Editor as TiptapEditor } from "@tiptap/core";
import { onDestroy } from "svelte";
import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../shared/constants";
import type { SanitizationEvent } from "../../shared/sanitize";
import { sanitizeAnnotation } from "../../shared/sanitize";
import { isSnapshotTruncated } from "../../shared/snapshot";
import type { Annotation } from "../../shared/types";
import { isPendingReviewTarget } from "../../shared/types";
import { AUTHORSHIP_ORIGIN_META } from "../editor/extensions/authorship";
import { annotationToPmRange } from "../positions";

/** Browser DevTools breadcrumb — only forensic trail client-side when sanitize coerces. */
const devSanitizeWarn = (event: SanitizationEvent): void => {
  console.warn("[sanitize]", event);
};

/**
 * Apply an annotation's replacement text in the editor.
 *
 * Exported for tests only. The hook's own suite drives it through a fully
 * mocked editor, which cannot observe the transaction — and a mutation that
 * deletes the authorship tag below passes every assertion there. The real
 * behaviour is pinned in `tests/client/authorship-stamp.test.ts` against a
 * live Tiptap editor.
 */
export function applySuggestion(
  ann: Annotation,
  editor: TiptapEditor,
  ydoc: Y.Doc | null,
): boolean {
  if (ann.suggestedText === undefined) return false;

  const newText = ann.suggestedText;
  const resolved = annotationToPmRange(ann, editor.state.doc, ydoc);
  if (!resolved) {
    console.warn("[SidePanel] Could not resolve range for suggestion", ann.id);
    return false;
  }

  try {
    return (
      editor
        .chain()
        .focus()
        // Claude wrote this text; without the tag `Authorship.onTransaction`
        // stamps it as the user's, which is #1388. The tag must live INSIDE the
        // chain — a chain batches every step into one transaction, and a
        // separate dispatch would tag a different one.
        .setMeta(AUTHORSHIP_ORIGIN_META, "claude")
        .deleteRange({ from: resolved.from, to: resolved.to })
        .insertContentAt(resolved.from, newText)
        .run()
    );
  } catch (err) {
    console.error("[SidePanel] Editor mutation failed for suggestion", ann.id, err);
    return false;
  }
}

export interface UseAnnotationReviewParams {
  /** Getter for current Y.Doc — avoids React-style ref ceremony. */
  getYdoc: () => Y.Doc | null;
  /** Getter for current editor instance. */
  getEditor: () => TiptapEditor | null;
  /** Reactive annotations array. */
  getAnnotations: () => Annotation[];
  onActiveAnnotationChange: (id: string | null) => void;
  getScrollBehavior: () => ScrollBehavior;
  /**
   * Getter for the current active annotation id. The auto-advance effect uses
   * this to AVOID clobbering an externally-set active id (e.g., from the
   * Alt+]/Alt+[ keyboard shortcut). Without this, every reactive read of
   * `getAnnotations()` would re-fire the effect and reset the active id to
   * `targets[reviewIndex]`.
   */
  getActiveAnnotationId?: () => string | null;
  /**
   * Called when accepting a suggestion fails because its range could not be
   * resolved (e.g. the underlying text changed since the suggestion was
   * created). The annotation has already been reverted to `"pending"` by the
   * time this fires. Callers use this to surface a toast — keep any message
   * generic per ADR-027 (never echo annotation content here).
   */
  onApplyFailed?: (ann: Annotation) => void;
  /**
   * Called when undoing an accepted suggestion is refused because the stored
   * `textSnapshot` is a truncated prefix (#1486) — restoring it would delete
   * everything past the 200-character cap.
   *
   * Separate from `onApplyFailed` because the two failures differ in kind, and
   * the difference is what the user needs told. An apply failure is transient:
   * the text moved, and retrying after a scroll or an edit can succeed. This
   * one is a property of the stored record, so it will refuse identically
   * forever — a message promising a retry would be a lie. The annotation stays
   * `accepted` and the document keeps the suggested text; the editor's own
   * Ctrl+Z is the remaining route back.
   *
   * ADR-027 applies as above: never echo annotation content into the message.
   */
  onUndoFailed?: (ann: Annotation) => void;
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
}

export function useAnnotationReview({
  getYdoc,
  getEditor,
  getAnnotations,
  onActiveAnnotationChange,
  getScrollBehavior,
  getActiveAnnotationId,
  onApplyFailed,
  onUndoFailed,
}: UseAnnotationReviewParams): UseAnnotationReviewReturn {
  // Reactive state
  let reviewIndex = $state(0);
  let recentlyResolved = $state(new Set<string>());
  const pendingRemovalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let lastResolvedId: string | null = null;

  // Cleanup timers on component destroy
  onDestroy(() => {
    for (const timer of pendingRemovalTimers.values()) clearTimeout(timer);
    pendingRemovalTimers.clear();
  });

  function getReviewTargets(): Annotation[] {
    return getAnnotations().filter(isPendingReviewTarget);
  }

  function resolveAnnotation(id: string, status: "accepted" | "dismissed") {
    const y = getYdoc();
    if (!y) return;
    const map = y.getMap(Y_MAP_ANNOTATIONS);
    const raw = map.get(id) as Annotation | undefined;
    if (!raw) return;
    // Idempotency: if the annotation has already been resolved (accepted or
    // dismissed), no-op. Defends against any future double-fire path —
    // critically, prevents `applySuggestion` from running twice and inserting
    // the suggested text twice.
    if (raw.status !== "pending") return;
    const ann = sanitizeAnnotation(raw, devSanitizeWarn);
    map.set(id, { ...ann, status });

    if (status === "accepted" && ann.suggestedText !== undefined) {
      const editor = getEditor();
      if (editor) {
        const applied = applySuggestion(ann, editor, y);
        if (!applied) {
          // Revert annotation status — text replacement failed
          map.set(id, { ...ann, status: "pending" });
          onApplyFailed?.(ann);
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
          // A truncated snapshot is a PREFIX of what was there (#1486).
          // Restoring it would delete everything past the 200-char cap, which
          // is the opposite of what undo is for — decline instead.
          //
          // `isSnapshotTruncated` also catches records written BEFORE this
          // change, which carry no flag and are marked only by the old trailing
          // ellipsis. Without that arm the fix would protect new annotations
          // while leaving every existing one corrupting on undo.
          //
          // Unlike the two declines below this one is DETERMINISTIC and
          // permanent — no later click will ever undo this annotation — so it
          // reports through `onUndoFailed` rather than only `console.warn`.
          if (isSnapshotTruncated(ann)) {
            console.warn(
              `[undo] Snapshot for annotation ${id} was truncated at capture; refusing to restore a partial revert`,
            );
            onUndoFailed?.(ann);
            // `removeFromResolved`, not `scheduleRemoval` like the transient
            // declines below. Those reschedule the 3s window because a retry
            // might succeed; this one never will, and rescheduling would keep
            // a dead Undo button on screen for another three seconds after
            // every click. Retiring it immediately matches the toast.
            removeFromResolved(id);
            return false;
          }
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
          // Deliberately NOT tagged with AUTHORSHIP_ORIGIN_META, so this falls
          // to the `"user"` default. `textSnapshot` is the document's PRIOR
          // content, whose author this site does not know: usually the user,
          // but Claude if an earlier `tandem_edit` wrote it and then suggested
          // a revision on top. The correct answer is to restore the authorship
          // entry the accept reaped, which needs the durable/`relRange` work in
          // #1471 — until then the common case is right and the rare one is
          // #1388's inversion in miniature. Tracked there, not silently left.
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

  // Empty selection is a valid resting state — there's no dedicated review mode
  // anymore, so we never force-select on null (that was the old bulk-review
  // model that always parked a target on the first pending annotation). We only
  // AUTO-ADVANCE: when the currently-active annotation stops being a live pending
  // one (deleted/accepted/dismissed), move selection to the FIRST remaining
  // review target. (`reviewIndex` has no sequential cursor anymore — nothing
  // increments it, so it sits at 0 and `targets[reviewIndex]` is `targets[0]`;
  // the second effect below only ever clamps it back down.) When no targets
  // remain that fallback is null, so selection naturally lands on empty. A
  // deliberate deselect (Escape / click-off) sets null and stays null here.
  //
  // #768 Bug 2 nuance preserved: "still live" checks the full pending annotation
  // set, not just review targets, so a user-clicked highlight overlapping a Claude
  // comment (author === "user", excluded from getReviewTargets) stays focused
  // instead of being clobbered back to the comment.
  $effect(() => {
    const currentActive = getActiveAnnotationId?.() ?? null;
    if (currentActive === null) return;
    const stillLive = getAnnotations().some(
      (a) => a.id === currentActive && a.status === "pending",
    );
    if (!stillLive) {
      const targets = getReviewTargets();
      onActiveAnnotationChange(targets[reviewIndex]?.id ?? null);
    }
  });

  // Keep review index in bounds when annotations change
  $effect(() => {
    const targets = getReviewTargets();
    if (reviewIndex >= targets.length) {
      reviewIndex = Math.max(0, targets.length - 1);
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
  };
}
