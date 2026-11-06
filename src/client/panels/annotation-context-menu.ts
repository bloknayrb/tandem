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

import { isSnapshotTruncated } from "../../shared/snapshot";
import type { Annotation, AnnotationReply } from "../../shared/types";

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
  "ctx:annotation:resolve",
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
 * Resolve: a user closing their OWN comment (#2360). Writes `dismissed`, applies
 * nothing and tells Claude nothing (the observer's dismiss arm needs a Claude
 * author). Not an AI write, so it is not licence-gated. Comments only: a note is
 * Archived and a highlight Removed, and neither has a conversation to close.
 */
export const canResolve = (a: AnnotationGate): boolean =>
  a.author === "user" && a.type === "comment" && isPending(a);

/**
 * The reply half of {@link canAcceptReplySuggestion}: a Claude-authored,
 * non-private reply carrying a replacement proposal (#2360).
 *
 * `private` is matched against the two values that mean "not private" rather
 * than `!== true`, the spelling `projection.ts`'s reply narrow warns against: a
 * stored `"true"` or `1` arrives over a Y.Map any connected client can write.
 */
export const isAcceptableReplyRewrite = (
  r: Pick<AnnotationReply, "author" | "private" | "suggestedText">,
): boolean =>
  r.author === "claude" &&
  (r.private === undefined || r.private === false) &&
  typeof r.suggestedText === "string";

/**
 * May the user accept the rewrite this REPLY proposes over its parent's range
 * (#1626, #2360)? Unlike {@link canAccept} this holds for a USER-authored
 * parent: Claude answers a user's comment inside its thread, and a rewrite there
 * is the user's to take.
 *
 * Parent half: pending, a comment, and Claude-facing. `audience === "outbound"`
 * is the client spelling of the server's `isClaudeFacing` (which the client
 * cannot import); an absent audience is not consent. Read it on a SANITIZED
 * record, which is what the rails render and what the hook builds, so a legacy
 * shape is normalized before it is judged.
 *
 * The card's own Accept/Dismiss, Ctrl+Enter and the palette Accept all stay on
 * {@link canAccept}: a reply rewrite is accepted by its own button only.
 */
export const canAcceptReplySuggestion = (
  parent: Pick<Annotation, "id" | "type" | "status" | "audience">,
  reply: Pick<AnnotationReply, "annotationId" | "author" | "private" | "suggestedText">,
): boolean =>
  parent.status === "pending" &&
  parent.type === "comment" &&
  parent.audience === "outbound" &&
  reply.annotationId === parent.id &&
  isAcceptableReplyRewrite(reply);

/** The reason a blocked Accept shows (#1632). Generic per ADR-027: no annotation content. */
export const ACCEPT_BLOCKED_REASON =
  "The text this suggestion was written against has changed, so it can't be applied.";

/**
 * Why a reply rewrite over a user comment with no `textSnapshot` is blocked
 * (#2360). Nothing CHANGED, so {@link ACCEPT_BLOCKED_REASON} would be false:
 * there is simply nothing to check the target against, or to restore on Undo.
 */
export const ACCEPT_UNVERIFIABLE_REASON =
  "Tandem can't confirm the text this replacement was written for, so it can't be applied.";

type UnverifiableGate = Pick<
  Annotation,
  "id" | "author" | "textSnapshot" | "textSnapshotTruncated"
>;

/**
 * A rewrite over this record's range can be neither checked nor undone (#2360):
 * a USER comment with no `textSnapshot` (every browser-made one) or a truncated
 * one (undo declines those permanently). A fact about the record alone, so the
 * thread can disable Accept without waiting for the document scan, and
 * `checkSuggestionTarget`'s `"unverifiable"` verdict is this same function.
 */
export const isUnverifiableTarget = (a: UnverifiableGate): boolean =>
  a.author === "user" && (a.textSnapshot === undefined || isSnapshotTruncated(a));

/** The reason a blocked Accept over `parent`'s range shows. */
export const acceptBlockedReason = (parent: UnverifiableGate): string =>
  isUnverifiableTarget(parent) ? ACCEPT_UNVERIFIABLE_REASON : ACCEPT_BLOCKED_REASON;

/**
 * Accept is OFFERED but cannot succeed (#1632): the record's target text is
 * gone, so `applySuggestion` would refuse the rewrite.
 *
 * `targetLost` is a fact about the record AND the document — computed by
 * `useAnnotationReview`'s `isTargetLost` — which is why it is a parameter and
 * not folded into {@link canAccept}: the predicates above stay pure functions
 * of the record. This one is still the single place the card's button, its
 * click guard and the native menu all ask, so they cannot drift.
 *
 * Only a record with `suggestedText` is blocked. Accepting a plain comment is a
 * status change that writes no text, so a lost target cannot make it fail.
 * (A reply's proposal rewrites the PARENT's range, so "Accept replacement" is
 * blocked on `targetLost` alone — see `CommentThread.svelte`.)
 *
 * The card props that carry this are optional and default to not lost: that is
 * the pre-#1632 behaviour, and `applySuggestion` refuses the click either way,
 * so a mount that forgets one loses the explanation, never the safety.
 */
export const isAcceptBlocked = (
  a: Pick<Annotation, "suggestedText">,
  targetLost: boolean,
): boolean => targetLost && a.suggestedText !== undefined;

/**
 * Reply — comment + note (post-#1000 notes carry PRIVATE user-authored reply threads
 * shown only to the owning user; the Claude privacy boundary is server-side and
 * untouched). Highlights have no body to thread. Bryan-approved 2026-06-03.
 *
 * `aiDisabled` (the licence refuses the AI, #1521): a reply to a comment is an
 * AI write, so it is refused; a reply inside the user's own note thread (#1000)
 * stays live. Required, so every consumer has to decide.
 */
export const canReply = (a: AnnotationGate, aiDisabled: boolean): boolean =>
  (a.type === "note" || (a.type === "comment" && !aiDisabled)) && isPending(a);

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
 * Refused while the licence refuses the AI (`aiDisabled`, #1521).
 */
export const canSendToClaude = (a: AnnotationGate, aiDisabled: boolean): boolean =>
  !aiDisabled && a.author === "user" && a.type === "note" && isPending(a);

/**
 * Archive (note) / Remove (highlight/comment) — user-authored only. Pending, or a
 * comment of the user's that is no longer pending: resolved (`dismissed`, #2360) or
 * closed by accepting Claude's reply rewrite (`accepted`). Without the second arm a
 * resolved comment has no action at all once Undo's window ends or the page
 * reloads (Bryan, 2026-11-05: "allow remove"). Notes and highlights never leave
 * pending through the UI, so they keep the pending rule.
 */
export const canRemove = (a: AnnotationGate): boolean =>
  a.author === "user" && (isPending(a) || a.type === "comment");

/**
 * Remove sweeps every reply on the record, Claude's included, with no undo. So a
 * comment that has replies asks once, inline, before it goes (Bryan, 2026-11-05:
 * "yes, inline confirmation"). The native menu cannot ask twice, so it leaves
 * Remove out for such a comment and the card's two-step is the only route.
 */
export const needsRemoveConfirm = (a: Pick<Annotation, "type">, replyCount: number): boolean =>
  a.type === "comment" && replyCount > 0;

/** Copy text — available on any card (incl. resolved); a pure clipboard read of the body. */
export const canCopy = (_a: AnnotationGate): boolean => true;

/** Boolean-only request sent to the `show_annotation_context_menu` Tauri command. */
export interface AnnotationContextMenuRequest {
  canAccept: boolean;
  canDismiss: boolean;
  canResolve: boolean;
  canReply: boolean;
  canEdit: boolean;
  canSendToClaude: boolean;
  canCopy: boolean;
  canRemove: boolean;
  /** Remove item label: note → "Archive", else → "Remove". */
  isNote: boolean;
}

/**
 * Compute the booleans-only menu request for a right-clicked annotation.
 *
 * `targetLost` (#1632) is required, so every caller has to decide. The native
 * menu has nowhere to put a reason, so a blocked Accept is left out of it,
 * like every other item that does not apply; the card shows it disabled with
 * the reason instead.
 */
export function buildAnnotationMenuContext(
  a: AnnotationGate & Pick<Annotation, "suggestedText">,
  aiDisabled: boolean,
  targetLost: boolean,
  replyCount = 0,
): AnnotationContextMenuRequest {
  return {
    canAccept: canAccept(a) && !isAcceptBlocked(a, targetLost),
    canDismiss: canDismiss(a),
    canResolve: canResolve(a),
    canReply: canReply(a, aiDisabled),
    canEdit: canEdit(a),
    canSendToClaude: canSendToClaude(a, aiDisabled),
    canCopy: canCopy(a),
    canRemove: canRemove(a) && !needsRemoveConfirm(a, replyCount),
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
