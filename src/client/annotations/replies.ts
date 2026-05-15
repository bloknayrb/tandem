import type { Annotation, AnnotationReply } from "../../shared/types.js";

/**
 * Return the replies that are safe to display for `annotation`.
 *
 * ADR-027: notes are user-private and highlights are user-only UI markup —
 * neither should ever surface a reply thread to Claude. Mirrors the server-
 * side guard in `src/server/events/observers/replies.ts`: replies only flow
 * (UI + channel) for `type === "comment"`.
 *
 * Consumers MUST route through this helper rather than reading the raw
 * replies map. Keeping the privacy filter in one place means a future change
 * to annotation types (e.g. adding a new private subtype) updates every
 * surface that renders replies in one edit.
 *
 * NOTE on signature: annotations do not embed their replies — replies live
 * in `Y_MAP_ANNOTATION_REPLIES` keyed by `annotationId`. Callers pass the
 * already-collected reply list (see `SidePanel.svelte`'s `repliesMap`).
 */
export function getVisibleReplies(
  annotation: Annotation,
  replies: AnnotationReply[] | undefined,
): AnnotationReply[] {
  if (annotation.type !== "comment") return [];
  return replies ?? [];
}
