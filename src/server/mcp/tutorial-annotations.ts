import * as Y from "yjs";

import { TUTORIAL_ANNOTATION_PREFIX, Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { withInternal } from "../../shared/origins.js";
import type { Annotation, AnnotationType, HighlightColor } from "../../shared/types.js";
import { toFlatOffset } from "../../shared/types.js";
import { nextRev } from "../annotations/schema.js";
import { anchoredRange } from "../positions.js";
import { extractText } from "./document-model.js";

interface TutorialAnnotationDef {
  id: string;
  type: AnnotationType;
  targetText: string;
  content: string;
  color?: HighlightColor;
  suggestedText?: string;
}

export const TUTORIAL_ANNOTATIONS: TutorialAnnotationDef[] = [
  {
    id: `${TUTORIAL_ANNOTATION_PREFIX}highlight-1`,
    type: "highlight",
    targetText: "highlight text and your AI sees it",
    content: "This is a highlight \u2014 it marks text for attention without suggesting changes.",
    color: "yellow",
  },
  {
    id: `${TUTORIAL_ANNOTATION_PREFIX}comment-1`,
    type: "comment",
    targetText: "edit this document at the same time",
    content: "Comments let you or your AI leave notes on specific text passages.",
  },
  {
    id: `${TUTORIAL_ANNOTATION_PREFIX}suggest-1`,
    type: "comment",
    targetText: "simplify onboarding",
    content: "More precise verb choice",
    suggestedText: "streamline onboarding",
  },
  {
    id: `${TUTORIAL_ANNOTATION_PREFIX}note-1`,
    type: "note",
    targetText: "accept or dismiss",
    content:
      "Notes are personal \u2014 your AI won\u2019t act on them unless you convert them to comments.",
  },
];

/** Idempotent — skips annotations that already exist in the Y.Map. */
export function injectTutorialAnnotations(doc: Y.Doc): void {
  const map = doc.getMap(Y_MAP_ANNOTATIONS);

  const fullText = extractText(doc);
  if (!fullText) {
    console.error("[tutorial] Y.Doc has no text content — cannot inject tutorial annotations");
    return;
  }

  let injected = 0;
  withInternal(doc, () => {
    for (const def of TUTORIAL_ANNOTATIONS) {
      if (map.has(def.id)) continue;
      const idx = fullText.indexOf(def.targetText);
      if (idx === -1) {
        console.error(`[tutorial] Target text "${def.targetText}" not found — skipping ${def.id}`);
        continue;
      }

      const result = anchoredRange(
        doc,
        toFlatOffset(idx),
        toFlatOffset(idx + def.targetText.length),
        def.targetText,
      );
      if (!result.ok) {
        console.error(
          `[tutorial] anchoredRange failed for "${def.targetText}" — skipping ${def.id}`,
        );
        continue;
      }

      const annotation = {
        id: def.id,
        // Notes are user-private (ADR-027); Claude can't author user-private content.
        // Comments and highlights are seeded as if Claude wrote them so the user
        // sees the cross-author authorship indicator.
        author: def.type === "note" ? ("user" as const) : ("claude" as const),
        type: def.type,
        range: result.range,
        // Only attach a CRDT-anchored relRange when fully resolved. Matches
        // the reloadFromDisk pattern (file-opener.ts) — a partial anchor
        // leaks a half-resolved RelativePosition that downstream code would
        // re-anchor anyway via the lazy-attach path in refreshRange.
        ...(result.fullyAnchored ? { relRange: result.relRange } : {}),
        content: def.content,
        status: "pending" as const,
        timestamp: Date.now(),
        textSnapshot: def.targetText,
        rev: nextRev(),
        ...(def.color !== undefined ? { color: def.color } : {}),
        ...(def.suggestedText !== undefined ? { suggestedText: def.suggestedText } : {}),
      } as Annotation;

      map.set(def.id, annotation);
      injected++;
    }
  });

  console.error(
    `[tutorial] Injected ${injected}/${TUTORIAL_ANNOTATIONS.length} tutorial annotations`,
  );
}
