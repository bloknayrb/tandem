import type { JSONContent, Editor as TiptapEditor } from "@tiptap/core";
import { onDestroy } from "svelte";
import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../shared/constants";
import type { SanitizationEvent } from "../../shared/sanitize";
import { sanitizeAnnotation } from "../../shared/sanitize";
import type { Annotation } from "../../shared/types";
import { isPendingReviewTarget } from "../../shared/types";
import { AUTHORSHIP_ORIGIN_META } from "../editor/extensions/authorship";
import { literalInlineContent } from "../editor/utils/literal-content";
import { annotationToPmRange } from "../positions";

/**
 * Is this position inside a node that stores newlines literally?
 *
 * `codeBlock` declares `code: true` and does not admit `hardBreak` in its
 * content expression, so the two contexts need different representations of the
 * same newline. See `literalInlineContent`.
 */
function isCodeContext(editor: TiptapEditor, pos: number): boolean {
  try {
    // Not named `$pos` despite the ProseMirror convention: this is a
    // `.svelte.ts` module and the Svelte compiler reserves the `$` prefix.
    const resolvedPos = editor.state.doc.resolve(pos);
    // Depth 0 — parent is the DOC rather than a textblock — is reachable: it is
    // where `flatOffsetToPmPos` clamps an over-long flat offset, at
    // `doc.content.size`. `doc.spec.code` is undefined there so this answers
    // "prose", and that is CORRECT rather than a gap: `insertContentAt` at the
    // document end appends a NEW PARAGRAPH, so the receiving node is a paragraph
    // even when the last block is a code block. Reading the preceding node
    // instead looks more careful and is wrong — it puts a literal newline, i.e.
    // a soft wrap, into that paragraph. Measured, not reasoned.
    return resolvedPos.parent.type.spec.code === true;
  } catch {
    // A position that will not resolve is about to fail the surrounding
    // transaction anyway; prose is the safe assumption.
    return false;
  }
}

/**
 * The flat text a PM range covers, in the SERVER's flat-text projection.
 *
 * Both separators are load-bearing, and they are the same argument made twice.
 * `suggestedText` and `textSnapshot` come from `extractText()`, which spells a
 * hard break "\n" (`leafText`) AND joins blocks with "\n" (`blockSeparator`).
 * Drop the first and every multi-line suggestion looks edited-since-accept;
 * drop the second and a range that has DRIFTED across a block boundary can
 * concatenate to exactly the snapshot, passing a guard that exists to stop
 * precisely that — after which undo deletes across the boundary and merges two
 * blocks.
 */
export function rangeText(editor: TiptapEditor, from: number, to: number): string {
  return editor.state.doc.textBetween(from, to, "\n", "\n");
}

/**
 * The marks spanning a range, as JSON, for `literalInlineContent` to stamp.
 *
 * `marksAcross` returns null when the endpoints disagree, which is the right
 * answer: a replacement straddling a bold boundary should not pick a side.
 */
function marksAcrossRange(
  editor: TiptapEditor,
  from: number,
  to: number,
): JSONContent["marks"] | undefined {
  try {
    const { doc } = editor.state;
    return doc
      .resolve(from)
      .marksAcross(doc.resolve(to))
      ?.map((m) => m.toJSON());
  } catch {
    return undefined;
  }
}

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
    // Inline JSON, never the raw string: `insertContentAt` HTML-parses a string
    // argument, which downgraded every hard break to a soft wrap and let markup
    // in a suggestion restructure the document (#1477).
    const content = literalInlineContent(
      newText,
      isCodeContext(editor, resolved.from),
      marksAcrossRange(editor, resolved.from, resolved.to),
    );
    let chain = editor
      .chain()
      .focus()
      // Claude wrote this text; without the tag `Authorship.onTransaction`
      // stamps it as the user's, which is #1388. The tag must live INSIDE the
      // chain — a chain batches every step into one transaction, and a
      // separate dispatch would tag a different one.
      .setMeta(AUTHORSHIP_ORIGIN_META, "claude")
      .deleteRange({ from: resolved.from, to: resolved.to });
    // An empty suggestion is a deletion. Inserting `[]` would not be a clean
    // no-op — `createNodeFromContent` gates its array branch on a non-empty
    // length, so `[]` falls through to `schema.nodeFromJSON([])`, throws, and is
    // caught into an empty fragment plus a `[tiptap warn]: Invalid content.`
    if (content.length > 0) chain = chain.insertContentAt(resolved.from, content);
    return chain.run();
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
          const resolved = annotationToPmRange(ann, editor.state.doc, y);
          if (!resolved) {
            console.warn(`[undo] Cannot resolve range for annotation ${id}, skipping`);
            scheduleRemoval(id);
            return false;
          }
          const currentText = rangeText(editor, resolved.from, resolved.to);
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
          // Same literal-content treatment as accept (#1477): restoring through
          // a raw string put back a literal newline where the snapshot recorded
          // a hard break as "\n", so undo could not restore what accept took
          // away even when the range was right.
          //
          // KNOWN LIMIT (#1486): `textSnapshot` uses ONE "\n" for both a hard
          // break and a block boundary, so undoing an accept that spanned two
          // blocks restores a single block with a hard break rather than the two
          // blocks that were there. The string cannot distinguish them; the fix
          // is a structural snapshot, not a smarter parse of this one.
          const restored = literalInlineContent(
            oldText,
            isCodeContext(editor, resolved.from),
            marksAcrossRange(editor, resolved.from, resolved.to),
          );
          let chain = editor.chain().focus().deleteRange({ from: resolved.from, to: resolved.to });
          if (restored.length > 0) chain = chain.insertContentAt(resolved.from, restored);
          chain.run();
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
