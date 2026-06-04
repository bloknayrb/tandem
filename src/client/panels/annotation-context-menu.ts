// Pure helpers for the native annotation-card context menu — issue #999 (#923 Phase 3).
//
// Mirrors the editor (Phase 1) and tab-strip (Phase 2) split: the request crossing
// the Tauri IPC boundary is BOOLEANS ONLY (no annotation id, no content — the id stays
// webview-side in the gesture singleton), the action ids are a closed `ctx:annotation:*`
// set, and the heavy wiring (DOM listeners, invoke, the shared gesture singleton) lives
// in `annotation-context-menu-host.ts` + the panel components. Kept import-light (only
// the `Annotation` type) so it unit-tests without a DOM or Tauri.
//
// The gating PREDICATES below are the single source of truth shared by this menu AND the
// existing in-card buttons (the panels pass each handler only when the matching predicate
// holds), so the two can't drift. They reproduce the EFFECTIVE rendered behaviour of
// `AnnotationCardActions.svelte` (whose if/else-if branch priority means, e.g., an
// import-authored note renders Accept/Reject — not Send to Claude).

import type { Annotation } from "../../shared/types";

/**
 * Closed set of annotation action ids Rust may emit back over `context-menu-action`.
 * Shared event with the editor + tab menus; each surface validates against its own set
 * and drops the others' ids (harmless cross-delivery). Archive (note) and Remove
 * (highlight/comment) share the single `remove` id — the label difference is decided in
 * Rust from `isNote`; the dispatch (`onRemove`) is identical.
 */
export const ANNOTATION_CONTEXT_MENU_ACTION_IDS = [
  "ctx:annotation:accept",
  "ctx:annotation:dismiss",
  "ctx:annotation:reply",
  "ctx:annotation:edit",
  "ctx:annotation:sendToClaude",
  "ctx:annotation:copy",
  "ctx:annotation:remove",
] as const;

export type AnnotationContextMenuActionId = (typeof ANNOTATION_CONTEXT_MENU_ACTION_IDS)[number];

const ACTION_ID_SET = new Set<string>(ANNOTATION_CONTEXT_MENU_ACTION_IDS);

export function isAnnotationContextMenuActionId(id: unknown): id is AnnotationContextMenuActionId {
  return typeof id === "string" && ACTION_ID_SET.has(id);
}

/** Minimal annotation shape the gating needs — `Pick` so callers can pass a full Annotation. */
export type AnnotationGate = Pick<Annotation, "type" | "author" | "status">;

const isPending = (a: AnnotationGate): boolean => a.status === "pending";

// ---- Gating predicates (shared with the in-card buttons) -------------------
// Each mirrors the EFFECTIVE rendered button in AnnotationCardActions.svelte.

/** Accept/Reject — review actions on non-user annotations (claude comments, import notes/comments). */
export const canAccept = (a: AnnotationGate): boolean => a.author !== "user" && isPending(a);
export const canDismiss = (a: AnnotationGate): boolean => a.author !== "user" && isPending(a);

/**
 * Reply — comment + note (post-#1000 notes carry PRIVATE user-authored reply threads
 * shown only to the owning user; the Claude privacy boundary is server-side and
 * untouched). Highlights have no body to thread. Bryan-approved 2026-06-03.
 */
export const canReply = (a: AnnotationGate): boolean =>
  (a.type === "note" || a.type === "comment") && isPending(a);

/**
 * Edit — CORRECTED to user-authored only (#999). A user must not rewrite Claude's or an
 * import's annotation text; `tandem_editAnnotation` is Claude's own path for its pending
 * annotations. (Today Edit shows on claude/import too because `onEdit` is passed
 * unconditionally — this predicate fixes both the button and the menu item.)
 */
export const canEdit = (a: AnnotationGate): boolean => a.author === "user" && isPending(a);

/**
 * Send to Claude — promotes a USER note → comment. Author-gated to `user` because the
 * Send button only reaches the `else-if type==="note"` branch when the Accept/Reject
 * branch doesn't fire (i.e. author === "user"); import notes render Accept instead.
 */
export const canSendToClaude = (a: AnnotationGate): boolean =>
  a.author === "user" && a.type === "note" && isPending(a);

/** Archive (note) / Remove (highlight/comment) — user-authored only, pending. */
export const canRemove = (a: AnnotationGate): boolean => a.author === "user" && isPending(a);

/** Copy text — available on any card (incl. resolved); a pure clipboard read of the body. */
export const canCopy = (_a: AnnotationGate): boolean => true;

/** Boolean-only request sent to the `show_annotation_context_menu` Tauri command. */
export interface AnnotationContextMenuRequest {
  canAccept: boolean;
  canDismiss: boolean;
  canReply: boolean;
  canEdit: boolean;
  canSendToClaude: boolean;
  canCopy: boolean;
  canRemove: boolean;
  /** Remove item label: note → "Archive", else → "Remove". */
  isNote: boolean;
}

/** Compute the booleans-only menu request for a right-clicked annotation. */
export function buildAnnotationMenuContext(a: AnnotationGate): AnnotationContextMenuRequest {
  return {
    canAccept: canAccept(a),
    canDismiss: canDismiss(a),
    canReply: canReply(a),
    canEdit: canEdit(a),
    canSendToClaude: canSendToClaude(a),
    canCopy: canCopy(a),
    canRemove: canRemove(a),
    isNote: a.type === "note",
  };
}

/**
 * Text written to the OS clipboard for "Copy text". Prefers the annotation body
 * (`content`); a highlight has empty content, so fall back to the captured text snapshot.
 * Never returns `undefined` (the caller's clipboard write is best-effort but must not
 * receive a non-string).
 */
export function copyTextFor(a: Pick<Annotation, "content" | "textSnapshot">): string {
  const body = a.content?.trim();
  if (body) return a.content;
  return a.textSnapshot ?? "";
}
