import type * as Y from "yjs";
import { Y_MAP_ANNOTATION_REPLIES } from "../../shared/constants";
import type { AnnotationReply } from "../../shared/types";

export interface AnnotationReplies {
  /** Replies grouped by `annotationId`, each list sorted ascending by `timestamp`. */
  readonly byId: ReadonlyMap<string, AnnotationReply[]>;
}

export interface CreateAnnotationRepliesOpts {
  getYdoc: () => Y.Doc | null;
}

/**
 * Subscribe to `Y_MAP_ANNOTATION_REPLIES` and expose a grouped-by-annotation
 * map. Extracted from `SidePanel.svelte` so the margin view can share the
 * same observation pipeline.
 *
 * NOTE: callers must apply `getVisibleReplies(annotation, replies)` from
 * `../annotations/replies.ts` at the lookup site rather than reading the raw
 * map directly — that helper enforces the ADR-027 privacy filter (notes and
 * highlights never expose replies).
 *
 * Returns an object with a getter property to preserve Svelte 5 reactivity
 * across destructuring boundaries (per `feedback_svelte_getter_destructuring`).
 * Consumers should read `replies.byId`, never `const { byId } = replies`.
 */
export function createAnnotationReplies(opts: CreateAnnotationRepliesOpts): AnnotationReplies {
  let byId = $state<Map<string, AnnotationReply[]>>(new Map());

  $effect(() => {
    const ydoc = opts.getYdoc();
    if (!ydoc) {
      if (byId.size > 0) byId = new Map();
      return;
    }
    const ymap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    const rebuild = (): void => {
      byId = groupReplies(ymap);
    };
    rebuild();
    ymap.observe(rebuild);
    return () => ymap.unobserve(rebuild);
  });

  return {
    get byId() {
      return byId;
    },
  };
}

/**
 * Pure helper exposed for unit testing: walk a Y.Map's values, group by
 * `annotationId`, and sort each list by ascending `timestamp`. Defensive
 * against malformed entries (non-objects, missing `annotationId`).
 */
export function groupReplies(source: {
  forEach: (cb: (value: unknown) => void) => void;
}): Map<string, AnnotationReply[]> {
  const grouped = new Map<string, AnnotationReply[]>();
  source.forEach((value) => {
    const reply = value as AnnotationReply | null | undefined;
    if (!reply || typeof reply !== "object" || !reply.annotationId) return;
    const list = grouped.get(reply.annotationId) ?? [];
    list.push(reply);
    grouped.set(reply.annotationId, list);
  });
  for (const list of grouped.values()) {
    list.sort((a, b) => a.timestamp - b.timestamp);
  }
  return grouped;
}
