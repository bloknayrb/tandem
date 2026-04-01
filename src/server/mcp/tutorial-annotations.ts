import * as Y from "yjs";

import { Y_MAP_ANNOTATIONS, TUTORIAL_ANNOTATION_PREFIX } from "../../shared/constants.js";
import type { Annotation, AnnotationType, HighlightColor } from "../../shared/types.js";
import { MCP_ORIGIN } from "../events/queue.js";
import { anchoredRange } from "../positions.js";
import { toFlatOffset } from "../../shared/types.js";
import { extractText } from "./document-model.js";

interface TutorialAnnotationDef {
  id: string;
  type: AnnotationType;
  targetText: string;
  content: string;
  color?: HighlightColor;
}

const TUTORIAL_ANNOTATIONS: TutorialAnnotationDef[] = [
  {
    id: `${TUTORIAL_ANNOTATION_PREFIX}highlight-1`,
    type: "highlight",
    targetText: "collaborative document editor",
    content: "This is a highlight \u2014 it marks text for attention without suggesting changes.",
    color: "yellow",
  },
  {
    id: `${TUTORIAL_ANNOTATION_PREFIX}comment-1`,
    type: "comment",
    targetText: "review your documents",
    content: "Comments let you or Claude leave notes on specific text passages.",
  },
  {
    id: `${TUTORIAL_ANNOTATION_PREFIX}suggest-1`,
    type: "suggestion",
    targetText: "simplify onboarding",
    content: JSON.stringify({
      newText: "streamline onboarding",
      reason: "More precise verb choice",
    }),
  },
];

/** Idempotent — skips if the guard annotation already exists. */
export function injectTutorialAnnotations(doc: Y.Doc): void {
  const map = doc.getMap(Y_MAP_ANNOTATIONS);

  if (map.has(`${TUTORIAL_ANNOTATION_PREFIX}highlight-1`)) return;

  const fullText = extractText(doc);
  if (!fullText) {
    console.error("[tutorial] Y.Doc has no text content — cannot inject tutorial annotations");
    return;
  }

  let injected = 0;
  doc.transact(() => {
    for (const def of TUTORIAL_ANNOTATIONS) {
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

      const annotation: Annotation = {
        id: def.id,
        author: "claude",
        type: def.type,
        range: result.range,
        relRange: result.relRange,
        content: def.content,
        status: "pending",
        timestamp: Date.now(),
        color: def.color,
        textSnapshot: def.targetText,
      };

      map.set(def.id, annotation);
      injected++;
    }
  }, MCP_ORIGIN);

  console.error(
    `[tutorial] Injected ${injected}/${TUTORIAL_ANNOTATIONS.length} tutorial annotations`,
  );
}
