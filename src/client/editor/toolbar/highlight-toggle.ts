import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../../shared/constants";
import { withBrowser } from "../../../shared/origins";
import type { Annotation, HighlightColor } from "../../../shared/types";
import { generateAnnotationId } from "../../../shared/utils";

/**
 * Toggle highlight behavior for repeat clicks on the same text range.
 *
 * Match criterion (all five must hold for an existing annotation to be a candidate):
 *   - type === "highlight"
 *   - range.from === from && range.to === to  (flat-offset equality)
 *   - author === "user"
 *   - status === "pending"
 *   - content === ""
 *
 * If status or content guard fails, fall through to add — preserving reviewed /
 * user-edited state is intentional (user shouldn't lose accepted highlights on
 * an accidental re-click).
 *
 * Returns:
 *   "added"    — no match found, new annotation inserted
 *   "removed"  — same-color match deleted (toggle off)
 *   "recolored" — different-color match replaced atomically (toggle color)
 */
export function toggleHighlight(
  ydoc: Y.Doc,
  range: { from: number; to: number },
  color: HighlightColor,
): "added" | "removed" | "recolored" {
  const map = ydoc.getMap<Annotation>(Y_MAP_ANNOTATIONS);

  // Find the first candidate that passes all five match guards.
  let matchKey: string | null = null;
  let matchColor: HighlightColor | undefined;

  for (const [key, ann] of map.entries()) {
    if (
      ann.type === "highlight" &&
      ann.range.from === range.from &&
      ann.range.to === range.to &&
      ann.author === "user" &&
      ann.status === "pending" &&
      ann.content === ""
    ) {
      matchKey = key;
      matchColor = ann.color;
      break;
    }
  }

  if (matchKey === null) {
    // No eligible match — insert new annotation.
    const id = generateAnnotationId();
    const annotation = {
      id,
      author: "user" as const,
      type: "highlight" as const,
      audience: "private" as const,
      range: { from: range.from, to: range.to },
      content: "",
      status: "pending" as const,
      timestamp: Date.now(),
      color,
    } as Annotation;
    // ADR-031: browser-initiated user edit — origin-tag so observers route correctly
    // (channel emits, durable-sync persists, tombstones record).
    withBrowser(ydoc, () => map.set(id, annotation));
    return "added";
  }

  if (matchColor === color) {
    // Same color — toggle off.
    withBrowser(ydoc, () => map.delete(matchKey as string));
    return "removed";
  }

  // Different color — replace atomically so observers see one event.
  const id = generateAnnotationId();
  const annotation = {
    id,
    author: "user" as const,
    type: "highlight" as const,
    audience: "private" as const,
    range: { from: range.from, to: range.to },
    content: "",
    status: "pending" as const,
    timestamp: Date.now(),
    color,
  } as Annotation;
  withBrowser(ydoc, () => {
    map.delete(matchKey as string);
    map.set(id, annotation);
  });
  return "recolored";
}
