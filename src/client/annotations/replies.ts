import type { Annotation, AnnotationReply } from "../../shared/types.js";

/**
 * Return the replies that are safe to display IN THE USER'S OWN UI for
 * `annotation`.
 *
 * Notes carry private reply threads (#1000) — including imported Word reply
 * threads — so notes AND comments display their replies here. Highlights are
 * user-only UI markup with no body to thread, so they never show replies.
 *
 * This is a CLIENT-DISPLAY filter only. It is NOT the privacy boundary: the
 * guarantee that note/import replies never reach Claude is enforced server-side
 * (the channel observer in `src/server/events/observers/replies.ts` and
 * `channelVisibleReplies` on the MCP read paths). Showing a note's private
 * replies to the user who owns them is correct — "private" means private from
 * Claude, not from the user.
 *
 * NOTE on signature: annotations do not embed their replies — replies live
 * in `Y_MAP_ANNOTATION_REPLIES` keyed by `annotationId`. Callers pass the
 * already-collected reply list (see `SidePanel.svelte`'s `repliesMap`).
 */
export function getVisibleReplies(
  annotation: Annotation,
  replies: AnnotationReply[] | undefined,
): AnnotationReply[] {
  if (annotation.type === "highlight") return [];
  return replies ?? [];
}
