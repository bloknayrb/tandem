import * as Y from "yjs";

import { TUTORIAL_ANNOTATION_PREFIX, Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { withInternal } from "../../shared/origins.js";
import type { Annotation, AnnotationType, HighlightColor } from "../../shared/types.js";
import { toFlatOffset } from "../../shared/types.js";
import { docHash } from "../annotations/doc-hash.js";
import { nextRev } from "../annotations/schema.js";
import { getTombstones } from "../annotations/sync.js";
import { anchoredRange, describeRangeFailure } from "../positions.js";
import { extractText } from "./document-model.js";

interface TutorialAnnotationDef {
  id: string;
  type: AnnotationType;
  /**
   * Who the seed is written as. Stated per seed, never derived from `type`:
   * highlights and notes are the user's own marks (ADR-027; `tandem_highlight`
   * is deprecated as "highlights are user-only"), so the highlight seed is the
   * user's too (#1725). Only the two comments are Claude's, and they are the
   * tutorial's review targets.
   */
  author: "user" | "claude";
  targetText: string;
  content: string;
  color?: HighlightColor;
  suggestedText?: string;
}

export const TUTORIAL_ANNOTATIONS: readonly TutorialAnnotationDef[] = [
  {
    id: `${TUTORIAL_ANNOTATION_PREFIX}highlight-1`,
    type: "highlight",
    author: "user",
    targetText: "highlight text and your AI sees it",
    content: "This is a highlight \u2014 it marks text for attention without suggesting changes.",
    color: "yellow",
  },
  {
    id: `${TUTORIAL_ANNOTATION_PREFIX}comment-1`,
    type: "comment",
    author: "claude",
    targetText: "edit this document at the same time",
    content: "Comments let you or your AI leave notes on specific text passages.",
  },
  {
    id: `${TUTORIAL_ANNOTATION_PREFIX}suggest-1`,
    type: "comment",
    author: "claude",
    targetText: "simplify onboarding",
    content: "More precise verb choice",
    suggestedText: "streamline onboarding",
  },
  {
    id: `${TUTORIAL_ANNOTATION_PREFIX}note-1`,
    type: "note",
    author: "user",
    targetText: "accept or dismiss",
    content:
      "Notes are personal \u2014 your AI won\u2019t act on them unless you convert them to comments.",
  },
];

/**
 * Idempotent — skips a seed already in the Y.Map, and a seed the user deleted:
 * an id tombstoned in the ledger for `filePath` is not re-created (#1696). Call
 * after `wireAnnotationStore`, whose merge seeds that ledger from the envelope —
 * `map.has` alone reads a merged-away deletion as absence and re-mints it.
 *
 * The tombstone check relies on bulk clears (`clearDocMaps` in
 * `documents/populate.ts`, reached only by `evictPartialDocState` since #2269
 * stopped the reloads clearing the annotation map) running with the annotation
 * observer detached, since the observer tombstones deletes from every origin and
 * would otherwise suppress every seed a clear removed.
 *
 * A seed still in the map survives a reload (it is remapped like any record),
 * and on a file-backed document the post-reload merge then persists it as a
 * map-only record — so it is durable from then on, despite the `withInternal`
 * write below.
 *
 * `replay` is the explicit "bring the seeds back" request (Settings > Replay
 * tutorial, which opens welcome.md with `force: true`). It re-creates a
 * tombstoned seed instead of skipping it, minted at a `rev` ABOVE its tombstone
 * so a later merge reads it as a resurrection rather than deleting it again.
 *
 * Returns how many TOMBSTONED seeds it re-created. The write is `withInternal`
 * (`DURABLE_SKIP`), so nothing queues the resurrection to disk, and the
 * envelope keeps the tombstone as the newest record for that id. The only other
 * carrier is the session file, which a changed source file or session expiry
 * discards; a reopen after that deleted the replayed seeds again. So a caller
 * that gets a non-zero count must persist a snapshot (`persistEnvelopeNow`)
 * for the replay to outlive the session.
 */
export function injectTutorialAnnotations(
  doc: Y.Doc,
  filePath: string,
  options?: { replay?: boolean },
): number {
  const map = doc.getMap(Y_MAP_ANNOTATIONS);

  const fullText = extractText(doc);
  if (!fullText) {
    console.error("[tutorial] Y.Doc has no text content — cannot inject tutorial annotations");
    return 0;
  }

  const deleted = new Map(getTombstones(docHash(filePath)).map((t) => [t.id, t]));
  const replay = options?.replay === true;

  let injected = 0;
  let resurrected = 0;
  withInternal(doc, () => {
    for (const def of TUTORIAL_ANNOTATIONS) {
      const tombstone = deleted.get(def.id);
      if (map.has(def.id) || (tombstone !== undefined && !replay)) continue;
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
          `[tutorial] anchoredRange failed for "${def.targetText}" — skipping ${def.id}: ${describeRangeFailure(result)}`,
        );
        continue;
      }

      const annotation = {
        id: def.id,
        author: def.author,
        type: def.type,
        // Stated, not derived. A Claude seed is outbound, matching what
        // `mintAnnotation` stamps on every Claude-authored annotation
        // (`annotations/lifecycle.ts`): the comments are review targets
        // (`isReviewTarget` is `author !== "user"`) the user is invited to
        // accept or dismiss, and a stored audience is what `sanitize.ts` reads
        // first, so the seed does not lean on a type-keyed default two modules
        // away. A review target that read as private would have its accept or
        // dismiss withheld from Claude: the user clicks, the card animates
        // away, and Claude is never told.
        //
        // A user seed (the highlight and the note, #1725) is private: both are
        // the user's own marks, and sanitize's demote guard would force a
        // user-authored highlight or note to `private` on every read anyway
        // (emitting `audience-conflict-resolved` each time). Storing it private
        // here means the stored record and the read view agree. Being the
        // user's, the highlight is no review target, so it carries no
        // Accept/Dismiss and is withheld from Claude like any user highlight.
        audience: def.author === "user" ? ("private" as const) : ("outbound" as const),
        range: result.range,
        // Only attach a CRDT-anchored relRange when fully resolved. Matches
        // the reloadFromDisk pattern (documents/watcher.ts) — a partial anchor
        // leaks a half-resolved RelativePosition that downstream code would
        // re-anchor anyway via the lazy-attach path in refreshRange.
        ...(result.fullyAnchored ? { relRange: result.relRange } : {}),
        content: def.content,
        status: "pending" as const,
        timestamp: Date.now(),
        textSnapshot: def.targetText,
        rev: nextRev(tombstone),
        ...(def.color !== undefined ? { color: def.color } : {}),
        ...(def.suggestedText !== undefined ? { suggestedText: def.suggestedText } : {}),
      } as Annotation;

      map.set(def.id, annotation);
      injected++;
      if (tombstone !== undefined) resurrected++;
    }
  });

  console.error(
    `[tutorial] Injected ${injected}/${TUTORIAL_ANNOTATIONS.length} tutorial annotations`,
  );
  return resurrected;
}
