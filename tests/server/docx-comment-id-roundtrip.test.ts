// #1693 — the promoted-comment ghost, pinned as a ROUND TRIP.
//
// The defect was never in one predicate: it was that TWO consumers shared one.
// `isCanonicalWordId` gated the drift index's build AND its lookup, so a `w:id`
// it rejected missed both layers protecting an already-promoted Word comment —
// a ghost note landed beside the promotion and the next save wrote two Word
// comments for one original (#1448). It ALSO gated export's id reuse, so fixing
// only the import half moves the ghost rather than closing it: the promoted
// comment is written back under a freshly minted id the drift index has never
// seen.
//
// A spec that only asserts the predicate cannot see that, because the bug is
// two consumers agreeing wrongly. Every row here is a round trip.
//
// The two predicates are now separate and keyed on their own property:
//   - the drift index gates on LENGTH (`IMPORT_COMMENT_ID_MAX`), i.e. "this
//     stored id survived the slice un-truncated, so it equals the id the next
//     import will present";
//   - export gates on `reusableWordId`, i.e. "this id can be written into a
//     `w:id` and read back as the same string".
//
// Splitting them closes the no-save half. The half a SAVE mediates needs one
// more thing, because an id export cannot reuse is written anyway and the drift
// index is then keyed on a value the file no longer carries:
// `reconcileImportCommentIds` points the stored `importSource.commentId` at the
// `w:id` that was actually written, once the bytes are on disk. Describe 3
// covers that population; `docx-comment-id-save-reid.test.ts` covers the
// production caller.

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadDocx } from "../../src/server/file-io/docx.js";
import { prepareExportComments } from "../../src/server/file-io/docx-comment-export.js";
import {
  type DocxComment,
  extractDocxComments,
  importReplyId,
  injectCommentsAsAnnotations,
  reconcileImportCommentIds,
} from "../../src/server/file-io/docx-comments.js";
import { exportYDocToDocx } from "../../src/server/file-io/docx-export.js";
import { htmlToYDoc } from "../../src/server/file-io/docx-html.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import type { Annotation, AnnotationReply } from "../../src/shared/types.js";
import { buildDocxWithCommentIds } from "../helpers/docx-fixtures.js";
import { off } from "../helpers/positions.js";

/**
 * The four ids #1693 names as reproducing the ghost, the id family #1692's own
 * fallback created, one outside int32, and the canonical control.
 */
const REPRO_IDS = ["1000000000", "-1", "0123", "c-9182", "nc:x", "3000000000"] as const;
const CONTROL_ID = "7";

/**
 * Promote an imported note in place, to the EXACT shape `promotedAnnotation`
 * (`src/client/panels/annotation-actions.ts`) produces.
 *
 * Every save-mediated row below depends on this shape. A record left
 * `type: "note"` loses the `isImportRoundtrip` bypass in
 * `docx-comment-export.ts`, `prepareExportComments` returns `[]`, and every
 * downstream assertion passes vacuously — on unfixed code too. Hence
 * `expectPromotedShape`, which every row calls.
 */
function promoteInPlace(doc: Y.Doc, key: string): void {
  const map = doc.getMap(Y_MAP_ANNOTATIONS);
  const ann = map.get(key) as Annotation & { color?: unknown; suggestedText?: unknown };
  const { color: _color, suggestedText: _suggestedText, ...rest } = ann;
  withInternal(doc, () => {
    map.set(key, {
      ...rest,
      type: "comment" as const,
      author: "user" as const,
      audience: "outbound" as const,
      promotedFrom: "note" as const,
      status: "pending" as const,
      rev: (ann.rev ?? 0) + 1,
    });
  });
}

function expectPromotedShape(doc: Y.Doc, key: string, commentId: string): void {
  const ann = doc.getMap(Y_MAP_ANNOTATIONS).get(key) as Annotation;
  expect(ann.type).toBe("comment");
  expect(ann.author).toBe("user");
  expect(ann.audience).toBe("outbound");
  expect(ann.promotedFrom).toBe("note");
  expect(ann.status).toBe("pending");
  expect(ann.importSource?.commentId).toBe(commentId);
  expect(ann.color).toBeUndefined();
  expect(ann.suggestedText).toBeUndefined();
}

/**
 * Open a `.docx` buffer into an EXISTING Y.Doc, the way the real reload path
 * does. `htmlToYDoc` clears only `doc.getXmlFragment("default")` and leaves
 * `Y_MAP_ANNOTATIONS` alone, which is exactly what `loadAndMerge` → re-inject
 * relies on — so re-populating one doc, rather than building a second, is the
 * faithful reproduction.
 */
async function openInto(
  doc: Y.Doc,
  buffer: Buffer,
  fileName: string,
): Promise<{ comments: DocxComment[]; injected: number }> {
  const html = await loadDocx(buffer);
  htmlToYDoc(doc, html);
  const comments = await extractDocxComments(buffer);
  const injected = injectCommentsAsAnnotations(doc, comments, fileName);
  return { comments, injected };
}

// ---------------------------------------------------------------------------
// 1. Drift round trip, no save
// ---------------------------------------------------------------------------

describe("promoted Word comment survives offset drift, for every reproducing w:id", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
    htmlToYDoc(doc, "<p>Hello World</p>");
  });

  for (const commentId of [...REPRO_IDS, CONTROL_ID]) {
    it(`re-anchors rather than ghosting for w:id ${JSON.stringify(commentId)}`, () => {
      const map = doc.getMap(Y_MAP_ANNOTATIONS);
      const first: DocxComment[] = [
        { commentId, authorName: "Alice", bodyText: "Body", from: off(0), to: off(5) },
      ];
      expect(injectCommentsAsAnnotations(doc, first, "f.docx")).toBe(1);
      expect(map.size).toBe(1);

      const key = Array.from(map.keys())[0];
      promoteInPlace(doc, key);
      expectPromotedShape(doc, key, commentId);

      // Same Word comment, drifted offsets: a different `importAnnotationId`,
      // so the offset lookup misses and only the commentId index can save it.
      const drifted: DocxComment[] = [
        { commentId, authorName: "Alice", bodyText: "Body", from: off(6), to: off(11) },
      ];
      expect(injectCommentsAsAnnotations(doc, drifted, "f.docx")).toBe(0);
      expect(map.size).toBe(1);
      expect((map.get(key) as Annotation).author).toBe("user");
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Save-mediated round trip — the half a widened import gate alone misses
// ---------------------------------------------------------------------------

describe("promoted Word comment round-trips through an actual save", () => {
  // `-1` used to live here. It is now in describe 3 with the other re-minted
  // ids: reuse would have written `w:id="-1"` into the user's file, which
  // nothing in this tree shows Word accepts (#1693 review).
  for (const commentId of ["1000000000", CONTROL_ID]) {
    it(`reuses w:id ${JSON.stringify(commentId)} on export and dedupes on re-open`, async () => {
      const doc = new Y.Doc();
      const original = await buildDocxWithCommentIds([commentId]);
      const opened = await openInto(doc, original, "r.docx");
      expect(opened.injected).toBe(1);

      const map = doc.getMap(Y_MAP_ANNOTATIONS);
      const key = Array.from(map.keys())[0];
      promoteInPlace(doc, key);
      expectPromotedShape(doc, key, commentId);

      // GUARD FIRST. Without it a row cannot tell "reused the id" from
      // "emitted nothing at all", and the latter is green on unfixed code.
      const prepared = prepareExportComments(doc);
      expect(prepared).toHaveLength(1);
      expect(prepared[0].id).toBe(Number(commentId));

      const reexported = await exportYDocToDocx(doc);
      const reopened = await openInto(doc, reexported, "r.docx");

      // The written `w:id` string is identical to the original.
      expect(reopened.comments).toHaveLength(1);
      expect(reopened.comments[0].commentId).toBe(commentId);

      // No ghost: one record, still the user's promotion.
      expect(reopened.injected).toBe(0);
      expect(map.size).toBe(1);
      expect((map.get(key) as Annotation).author).toBe("user");

      // Offset stability pin. BOTH sides are OOXML walks of a `.docx`, so this
      // compares like with like; comparing against the stored annotation range
      // instead would compare two accountings the source documents as
      // divergent. It pins that the save did not move the anchor — it does NOT
      // pin the walker's per-element flat-text mapping, which
      // `docx-walker.test.ts` owns and this fixture deliberately avoids.
      const before = await extractDocxComments(original);
      expect(reopened.comments[0].from).toBe(before[0].from);
      expect(reopened.comments[0].to).toBe(before[0].to);

      doc.destroy();
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Re-minted ids, and the save-path reconcile that keeps them findable
// ---------------------------------------------------------------------------

describe("a re-minted w:id is reconciled onto the stored record", () => {
  // These rows are the population `reusableWordId` DECLINES, so export allocates
  // a fresh `w:id` for them and the stored `importSource.commentId` no longer
  // names the id in the file. Two sub-populations, and they are not one thing:
  //
  //   - NON-NUMERIC (`c-9182`, `nc:x`): `ST_DecimalNumber` has no representation
  //     for them, so ID REUSE is permanently impossible — a property of the
  //     format, not a gap.
  //   - OUTSIDE INT32 (`3000000000`) and NON-CANONICAL FORM (`0123`): reuse is
  //     closable and is not closed here. Tracked in #1951.
  //   - NEGATIVE (`-1`): reuse is possible and is REFUSED, on purpose — see the
  //     row's own comment below.
  //
  // The GHOST is a different question from reuse and it IS closed, for both:
  // after the bytes land the save path calls `reconcileImportCommentIds`, which
  // points the stored id at the `w:id` that was actually written. So the next
  // open's drift index finds the record whether or not reuse was ever possible.
  // Each row runs export → reconcile → re-open in that order, which is the order
  // `saveDocumentToDisk`'s binary branch runs them in; that the PRODUCTION path
  // really does call it is pinned end-to-end, through `saveDocumentToDisk`
  // itself, in `docx-comment-id-save-reid.test.ts` — asserting the reconcile
  // here only would pin the function and not its caller.
  const reminted: Array<{ commentId: string; mintedId?: number }> = [
    { commentId: "c-9182" },
    { commentId: "nc:x" },
    { commentId: "3000000000" },
    // NEGATIVE (`-1`): reuse is possible in `ST_DecimalNumber` and is declined
    // anyway (#1693 review) — writing `w:id="-1"` puts a value into the user's
    // saved `.docx` that nothing here shows Word emits or reopens, and the
    // verifier cannot see it. This row is what pins that the decline costs the
    // comment nothing: the reconcile keeps it findable exactly as it does for
    // the ids reuse can never rescue.
    { commentId: "-1", mintedId: 1 },
    // With one promoted record and no reuse, `nextId` starts at 1 and
    // `allocate` walks up from there, so 1 is the only value that can be
    // minted. This exact assertion is the ONLY thing that kills a
    // `reusableWordId` missing its `String(n) === raw` term: without it
    // `"0123"` reuses as `123`, which matches the shape check below and differs
    // from the stored value, so every other assertion in this row stays green.
    { commentId: "0123", mintedId: 1 },
  ];

  for (const { commentId, mintedId } of reminted) {
    it(`re-mints ${JSON.stringify(commentId)}, then reconciles so re-open finds it`, async () => {
      const doc = new Y.Doc();
      const original = await buildDocxWithCommentIds([commentId]);
      expect((await openInto(doc, original, "r.docx")).injected).toBe(1);

      const map = doc.getMap(Y_MAP_ANNOTATIONS);
      const key = Array.from(map.keys())[0];
      promoteInPlace(doc, key);
      expectPromotedShape(doc, key, commentId);

      const prepared = prepareExportComments(doc);
      expect(prepared).toHaveLength(1);
      // The reuse residual (#1951), asserted rather than described. "differs
      // from stored" on its own admits an implementation that feeds
      // `Number(raw)` through unguarded and writes `w:id="NaN"`, so the shape
      // assertion runs too.
      expect(String(prepared[0].id)).toMatch(/^[1-9][0-9]*$/);
      expect(String(prepared[0].id)).not.toBe(commentId);
      if (mintedId !== undefined) expect(prepared[0].id).toBe(mintedId);
      // The linkage the reconcile needs. Without it the caller holds an id and a
      // body and cannot say which record produced them.
      expect(prepared[0].annotationId).toBe(key);

      const reexported = await exportYDocToDocx(doc);
      // What the save path does once the bytes are on disk, and only then.
      expect(reconcileImportCommentIds(doc, prepared)).toBe(1);
      expectPromotedShape(doc, key, String(prepared[0].id));

      const reopened = await openInto(doc, reexported, "r.docx");
      expect(reopened.comments[0].commentId).not.toBe(commentId);
      expect(reopened.comments[0].commentId).toBe(String(prepared[0].id));
      // No ghost: one record, still the user's promotion.
      expect(reopened.injected).toBe(0);
      expect(map.size).toBe(1);
      expect((map.get(key) as Annotation).author).toBe("user");

      doc.destroy();
    });
  }

  it("is a no-op on the second save, because the first made the id reusable", async () => {
    // Convergence, which is what makes the repair a repair rather than a
    // treadmill: `reconcileImportCommentIds` writes a canonical decimal, so the
    // NEXT export reuses it and there is nothing left to reconcile. A row that
    // stopped at one save would be equally green if every save rewrote the id.
    const doc = new Y.Doc();
    const original = await buildDocxWithCommentIds(["c-9182"]);
    await openInto(doc, original, "r.docx");
    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    const key = Array.from(map.keys())[0];
    promoteInPlace(doc, key);

    const first = prepareExportComments(doc);
    await exportYDocToDocx(doc);
    expect(reconcileImportCommentIds(doc, first)).toBe(1);
    const revAfterFirst = (map.get(key) as Annotation).rev;

    const second = prepareExportComments(doc);
    expect(second[0].id).toBe(first[0].id);
    await exportYDocToDocx(doc);
    expect(reconcileImportCommentIds(doc, second)).toBe(0);
    // And no rev churn — an unconditional rewrite would bump it every save,
    // which is a durable write per save for no change.
    expect((map.get(key) as Annotation).rev).toBe(revAfterFirst);

    doc.destroy();
  });

  it("touches nothing that carries no import provenance", () => {
    // The writer reads the stored record rather than taking one, so the only
    // way it could damage a user comment is by MINTING provenance onto it. A
    // record with no `importSource` is left exactly as it was — including its
    // `rev`, so it does not even take a durable write.
    const doc = new Y.Doc();
    htmlToYDoc(doc, "<p>Hello World</p>");
    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    const plain: Annotation = {
      id: "user-1",
      type: "comment",
      author: "user",
      audience: "outbound",
      status: "pending",
      content: "A plain user comment",
      range: { from: off(0), to: off(5) },
      timestamp: 1700000000000,
      rev: 3,
    };
    withInternal(doc, () => map.set(plain.id, plain));

    expect(reconcileImportCommentIds(doc, [{ annotationId: "user-1", id: 42 }])).toBe(0);
    expect(map.get("user-1")).toStrictEqual(plain);
    // A record that is not there at all is also a no-op, not a fresh write.
    expect(reconcileImportCommentIds(doc, [{ annotationId: "gone", id: 42 }])).toBe(0);
    expect(map.size).toBe(1);

    doc.destroy();
  });

  it("leaves a stored reply on the promotion when a ghost does appear", () => {
    // The `!map.has(clash.annotationId)` term on the finding-4 repair, pinned
    // where it still matters. The reconcile above closes the SAVE-mediated
    // ghost, but not the one the drift index cannot key at all: an id at or past
    // `IMPORT_COMMENT_ID_MAX` is refused by `keysDriftIndex` on purpose (the
    // #1150 injectivity boundary, describe 4), so drifted offsets still inject a
    // ghost beside the promotion. In that population `effectiveKey` is the
    // GHOST's key, and an unconditional reparent would move the user's reply
    // text out of their promoted thread and into the ghost's duplicate Word
    // comment — a regression master does not have.
    const commentId = "c".repeat(32);
    const doc = new Y.Doc();
    htmlToYDoc(doc, "<p>Hello World</p>");

    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    const bodyText = "Imported body";
    expect(
      injectCommentsAsAnnotations(
        doc,
        [{ commentId, authorName: "Rita", bodyText, from: off(0), to: off(5) }],
        "r.docx",
      ),
    ).toBe(1);
    const promotionKey = Array.from(map.keys())[0];
    promoteInPlace(doc, promotionKey);
    expectPromotedShape(doc, promotionKey, commentId);

    // A Word reply arriving on the drifted comment, whose stored twin already
    // points at the promotion.
    const replyText = "Please clarify";
    const replyId = importReplyId(commentId, "r1", replyText);
    const repliesMap = doc.getMap(Y_MAP_ANNOTATION_REPLIES);
    withInternal(doc, () => {
      repliesMap.set(replyId, {
        id: replyId,
        annotationId: promotionKey,
        author: "import",
        text: replyText,
        timestamp: 1700000000000,
        rev: 1,
        private: true,
        importAuthor: "Rita",
      } satisfies AnnotationReply);
    });

    // Give the promotion a distinguishable body — editing a promoted comment is
    // exactly what promotion enables — so the two exported comments can be told
    // apart by more than their minted ids. It does not touch the dedup: the
    // ghost's key is derived from the drifted offsets and the imported body,
    // neither of which this changes.
    withInternal(doc, () => {
      const promoted = map.get(promotionKey) as Annotation;
      map.set(promotionKey, { ...promoted, content: "Promoted body" });
    });

    const drifted: DocxComment[] = [
      {
        commentId,
        authorName: "Rita",
        bodyText,
        from: off(6),
        to: off(11),
        replies: [{ commentId: "r1", authorName: "Rita", bodyText: replyText }],
      },
    ];
    expect(injectCommentsAsAnnotations(doc, drifted, "r.docx")).toBe(1); // the ghost
    expect(map.size).toBe(2);

    const after = repliesMap.get(replyId) as AnnotationReply;
    expect(after.annotationId).toBe(promotionKey);
    expect(after.rev).toBe(1);

    // And the reply text is emitted exactly once, under the PROMOTION's
    // comment — the record whose author label is the user's, not the ghost's
    // imported byline.
    const prepared = prepareExportComments(doc);
    expect(prepared).toHaveLength(2);
    const carrying = prepared.filter((c) => c.bodyParagraphs.some((l) => l.includes(replyText)));
    expect(carrying).toHaveLength(1);
    const promotionExport = prepared.find((c) => c.bodyParagraphs[0] === "Promoted body");
    expect(promotionExport).toBeDefined();
    expect(carrying[0].id).toBe(promotionExport?.id);
    // ...and not the ghost's, which is the record an unconditional reparent
    // would have moved it to.
    const ghostExport = prepared.find((c) => c.bodyParagraphs[0] === bodyText);
    expect(ghostExport).toBeDefined();
    expect(carrying[0].id).not.toBe(ghostExport?.id);

    doc.destroy();
  });
});

// ---------------------------------------------------------------------------
// 4. The length gate, behaviourally
// ---------------------------------------------------------------------------

describe("the drift index gates on length, at IMPORT_COMMENT_ID_MAX", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
    htmlToYDoc(doc, "<p>Hello World</p>");
  });

  const driftTwice = (commentId: string): { injected: number; size: number } => {
    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    injectCommentsAsAnnotations(
      doc,
      [{ commentId, authorName: "A", bodyText: "Body", from: off(0), to: off(5) }],
      "f.docx",
    );
    const injected = injectCommentsAsAnnotations(
      doc,
      [{ commentId, authorName: "A", bodyText: "Body", from: off(6), to: off(11) }],
      "f.docx",
    );
    return { injected, size: map.size };
  };

  it("indexes an id one unit SHORT of the cap, so drift re-anchors in place", () => {
    expect(driftTwice("a".repeat(31))).toEqual({ injected: 0, size: 1 });
  });

  it("refuses an id AT the cap, so drift duplicates [#1150 safety boundary]", () => {
    // `>=`, not `>`. A stored value of exactly the cap is ambiguous — a
    // 32-character raw id, or the truncation of a longer one — so indexing it
    // could collapse two distinct comments into one bucket, which is a silent
    // cross-comment content swap. Duplicate-on-drift is the accepted
    // degradation, and this row is where that #1150 boundary now lives:
    // `docx-comments.test.ts` used to pin it on the non-canonical id `"01"`,
    // which the length gate correctly indexes, so that spec was rewritten to
    // the new contract and the boundary moved here.
    expect(driftTwice("b".repeat(32))).toEqual({ injected: 1, size: 2 });
  });
});

// ---------------------------------------------------------------------------
// 5. The COLD open — the half the reconcile alone does not close
// ---------------------------------------------------------------------------

describe("a cold open still writes one Word comment per original", () => {
  // `reconcileImportCommentIds` repairs `importSource.commentId`; it does NOT
  // re-key the record, and it cannot, because the map key is a hash of the id
  // the record was imported under. Every describe above re-injects into the
  // SAME Y.Doc, which is the reload shape — annotations preserved, so the drift
  // index has something in it to find.
  //
  // The COLD shape is the other one, and it is the majority of opens: quit,
  // reopen the file. `documents/open.ts` runs `loadContentIntoDoc` (→ inject)
  // BEFORE `finalizeDocOpen` → `wireAnnotationStore` → `loadAndMerge`, so
  // injection runs against an EMPTY annotation map — the drift index is empty
  // and cannot fire. `tandem_open force: true` has the same shape for the same
  // reason (`documents/populate.ts` clears the map, then injects). The freshly
  // injected note lands under the id in the FILE while the promotion merges back
  // under the id it was imported with, and the document then holds two records
  // over one span. Both pass the export gates, so the next save wrote TWO Word
  // comments for one original (#1448) — measured, not inferred.
  //
  // What closes it is the ghost-pair collapse in `prepareExportComments`, which
  // needs no index and no ordering: after the reconcile both records name one
  // stored `w:id`, so one comment is written and it is the user's promotion.
  for (const commentId of ["c-9182", "0123", "-1", "1000000000", CONTROL_ID]) {
    it(`collapses the pair for w:id ${JSON.stringify(commentId)}`, async () => {
      const doc = new Y.Doc();
      const original = await buildDocxWithCommentIds([commentId]);
      expect((await openInto(doc, original, "r.docx")).injected).toBe(1);
      const map = doc.getMap(Y_MAP_ANNOTATIONS);
      const key = Array.from(map.keys())[0];
      promoteInPlace(doc, key);
      expectPromotedShape(doc, key, commentId);

      const prepared = prepareExportComments(doc);
      expect(prepared).toHaveLength(1);
      const bytes = await exportYDocToDocx(doc);
      // The save path, in its order: bytes first, then the reconcile.
      reconcileImportCommentIds(doc, prepared);
      const promoted = map.get(key) as Annotation;

      // The cold open: a FRESH doc, so the annotation map is empty while the
      // `.docx` comments are injected.
      const cold = new Y.Doc();
      const reopened = await openInto(cold, bytes, "r.docx");
      expect(reopened.comments).toHaveLength(1);
      const coldMap = cold.getMap(Y_MAP_ANNOTATIONS);
      // ...and only afterwards does `loadAndMerge` put the envelope back. It is
      // per-id, so the promotion returns under its own key whatever the
      // injection just did.
      withInternal(cold, () => coldMap.set(key, promoted));

      // GUARD: for every id export re-mints, the ghost really is there — the row
      // is not green because there was nothing to collapse. `1000000000` and the
      // control reuse their id, so injection hits the promotion's own key and no
      // pair forms at all; both outcomes are correct and the assertion below is
      // the one that matters either way.
      const reused = String(prepared[0].id) === commentId;
      expect(coldMap.size).toBe(reused ? 1 : 2);

      // The property, on both branches: one Word comment for one original, and
      // it is the user's promotion rather than the re-imported note.
      const coldPrepared = prepareExportComments(cold);
      expect(coldPrepared).toHaveLength(1);
      expect(coldPrepared[0].annotationId).toBe(key);

      doc.destroy();
      cold.destroy();
    });
  }
});

// ---------------------------------------------------------------------------
// 6. The SECOND save — the collapse must not be a one-shot
// ---------------------------------------------------------------------------

describe("a collapsed pair is still one Word comment on the second save", () => {
  // `reconcileImportCommentIds` heals BOTH halves of a collapsed pair, not just
  // the record that was written. Healing only the survivor makes the collapse
  // fire exactly once: the pair then names two different stored ids,
  // `keysDriftIndex` buckets them apart on the next open, and the export writes
  // TWO Word comments for one original — the #1448 symptom the collapse exists
  // to prevent, arriving one save later and with no log line to show for it.
  //
  // The pair is built the way the finding reaches it, and NOT via a re-export:
  // promote, quit WITHOUT saving, a colleague edits the .docx in Word (the
  // offsets drift and they add a reply), reopen cold. The file therefore still
  // carries the ORIGINAL `w:id`, so both records name a stored id export may
  // have to re-mint — which is the only shape in which the two can diverge.
  //
  // `0123`, `-1` and `c-9182` are the discriminating rows: `reusableWordId`
  // declines all three, so save 1 mints a different id and the stored ids move.
  // `1000000000` and the control are reused verbatim, so there is nothing to
  // reconcile — they pin that the row does not depend on a rewrite happening.
  for (const commentId of ["0123", "-1", "c-9182", "1000000000", CONTROL_ID]) {
    it(`writes one comment on both saves for w:id ${JSON.stringify(commentId)}`, async () => {
      const body = "Imported body";
      // The session that promoted, and never saved.
      const home = new Y.Doc();
      htmlToYDoc(home, "<p>Hello World</p>");
      const homeMap = home.getMap(Y_MAP_ANNOTATIONS);
      expect(
        injectCommentsAsAnnotations(
          home,
          [{ commentId, authorName: "Rita", bodyText: body, from: off(0), to: off(5) }],
          "r.docx",
        ),
      ).toBe(1);
      const key = Array.from(homeMap.keys())[0];
      promoteInPlace(home, key);
      expectPromotedShape(home, key, commentId);
      const promoted = homeMap.get(key) as Annotation;

      // The cold open: content first, annotation map EMPTY, so the drift index
      // has nothing in it and the ghost forms under the drifted offsets' key.
      const cold = new Y.Doc();
      htmlToYDoc(cold, "<p>Hello World</p>");
      const coldMap = cold.getMap(Y_MAP_ANNOTATIONS);
      const replyText = "Please clarify";
      expect(
        injectCommentsAsAnnotations(
          cold,
          [
            {
              commentId,
              authorName: "Rita",
              bodyText: body,
              from: off(6),
              to: off(11),
              replies: [{ commentId: "r1", authorName: "Rita", bodyText: replyText }],
            },
          ],
          "r.docx",
        ),
      ).toBe(1);
      const ghostKey = Array.from(coldMap.keys())[0];
      expect(ghostKey).not.toBe(key);
      // ...and only afterwards does `loadAndMerge` put the envelope back.
      withInternal(cold, () => coldMap.set(key, promoted));
      expect(coldMap.size).toBe(2);
      // The colleague's Word reply is on the GHOST — the half the collapse drops.
      const replies = Array.from(
        cold.getMap(Y_MAP_ANNOTATION_REPLIES).values() as Iterable<AnnotationReply>,
      );
      expect(replies).toHaveLength(1);
      expect(replies[0].annotationId).toBe(ghostKey);

      // SAVE 1 — one Word comment, the user's promotion, carrying the ghost's
      // reply rather than leaving it behind with the record that was dropped.
      const first = prepareExportComments(cold);
      expect(first).toHaveLength(1);
      expect(first[0].annotationId).toBe(key);
      expect(first[0].suppressedAnnotationIds).toEqual([ghostKey]);
      const firstBytes = await exportYDocToDocx(cold);
      const firstWritten = await extractDocxComments(firstBytes);
      expect(firstWritten).toHaveLength(1);
      expect(firstWritten[0].bodyText).toContain(replyText);
      // The save path's order: bytes first, then the reconcile.
      reconcileImportCommentIds(cold, first);

      // SAVE 2 — still one Word comment in the user's file, and still the
      // promotion. This is the consequence, asserted before the mechanism: heal
      // only the survivor and the count here is 2.
      const second = prepareExportComments(cold);
      expect(second).toHaveLength(1);
      expect(second[0].annotationId).toBe(key);
      expect(await extractDocxComments(await exportYDocToDocx(cold))).toHaveLength(1);

      // And the mechanism that makes it so: both halves name the id the FILE
      // carries, so `keysDriftIndex` still buckets them together.
      const storedIds = Array.from(coldMap.values() as Iterable<Annotation>).map(
        (ann) => ann.importSource?.commentId,
      );
      expect(storedIds).toHaveLength(2);
      expect(new Set(storedIds)).toEqual(new Set([String(first[0].id)]));

      home.destroy();
      cold.destroy();
    });
  }
});
