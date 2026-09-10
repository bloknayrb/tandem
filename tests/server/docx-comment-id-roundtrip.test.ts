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

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadDocx } from "../../src/server/file-io/docx.js";
import { prepareExportComments } from "../../src/server/file-io/docx-comment-export.js";
import {
  type DocxComment,
  extractDocxComments,
  importReplyId,
  injectCommentsAsAnnotations,
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
  for (const commentId of ["1000000000", "-1", CONTROL_ID]) {
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
// 3. The residual, pinned rather than described
// ---------------------------------------------------------------------------

describe("ids reusableWordId declines still re-mint on export (documented residual)", () => {
  // These rows assert what this PR does NOT close, so the boundary is a pin
  // rather than a sentence. Three populations, and they are not one thing:
  //
  //   - NON-NUMERIC (`c-9182`, `nc:x`): `ST_DecimalNumber` has no
  //     representation for them, so ID REUSE is permanently impossible. The
  //     GHOST is a separate and closable question — rewriting the stored
  //     `importSource.commentId` to the id actually written at export would
  //     close it with no reuse — so it is not written off. Its tracked home is
  //     #1693, which this PR leaves OPEN for exactly that reason. Their
  //     NO-SAVE half is closed here, by the first describe above.
  //   - OUTSIDE INT32 (`3000000000`) and NON-CANONICAL FORM (`0123`): closable,
  //     tracked in the residual-ids follow-up filed with this PR.
  //   - AT OR PAST the cap: the fourth describe's far side.
  const residual: Array<{ commentId: string; mintedId?: number }> = [
    { commentId: "c-9182" },
    { commentId: "nc:x" },
    { commentId: "3000000000" },
    // With one promoted record and no reuse, `nextId` starts at 1 and
    // `allocate` walks up from there, so 1 is the only value that can be
    // minted. This exact assertion is the ONLY thing that kills a
    // `reusableWordId` missing its `String(n) === raw` term: without it
    // `"0123"` reuses as `123`, which matches the shape check below, differs
    // from the stored value, and still misses a drift index keyed on `"0123"` —
    // so every other assertion in this row stays green.
    { commentId: "0123", mintedId: 1 },
  ];

  for (const { commentId, mintedId } of residual) {
    it(`mints a fresh w:id for ${JSON.stringify(commentId)} and re-injects`, async () => {
      const doc = new Y.Doc();
      const original = await buildDocxWithCommentIds([commentId]);
      expect((await openInto(doc, original, "r.docx")).injected).toBe(1);

      const map = doc.getMap(Y_MAP_ANNOTATIONS);
      const key = Array.from(map.keys())[0];
      promoteInPlace(doc, key);
      expectPromotedShape(doc, key, commentId);

      const prepared = prepareExportComments(doc);
      expect(prepared).toHaveLength(1);
      // "differs from stored" on its own admits an implementation that feeds
      // `Number(raw)` through unguarded and writes `w:id="NaN"`, so the shape
      // assertion runs too.
      expect(String(prepared[0].id)).toMatch(/^[1-9][0-9]*$/);
      expect(String(prepared[0].id)).not.toBe(commentId);
      if (mintedId !== undefined) expect(prepared[0].id).toBe(mintedId);

      const reexported = await exportYDocToDocx(doc);
      const reopened = await openInto(doc, reexported, "r.docx");
      expect(reopened.comments[0].commentId).not.toBe(commentId);
      expect(reopened.injected).toBe(1);
      expect(map.size).toBe(2);

      doc.destroy();
    });
  }

  it("leaves a stored reply on the promotion when the ghost appears", async () => {
    // The `!map.has(clash.annotationId)` term on the finding-4 repair, pinned
    // where it actually matters. In this population the drift lookup misses and
    // a ghost note is injected, so `effectiveKey` is the GHOST's key. An
    // unconditional reparent would move the user's reply text out of their
    // promoted thread and into the ghost's duplicate Word comment — a
    // regression master does not have.
    const commentId = "0123";
    const doc = new Y.Doc();
    const original = await buildDocxWithCommentIds([commentId]);
    await openInto(doc, original, "r.docx");

    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    const promotionKey = Array.from(map.keys())[0];
    promoteInPlace(doc, promotionKey);
    expectPromotedShape(doc, promotionKey, commentId);

    const reexported = await exportYDocToDocx(doc);
    const html = await loadDocx(reexported);
    htmlToYDoc(doc, html);
    const comments = await extractDocxComments(reexported);
    const freshId = comments[0].commentId;
    expect(freshId).not.toBe(commentId);

    // A Word reply arriving on the re-imported (freshly-numbered) comment,
    // whose stored twin already points at the promotion.
    const replyText = "Please clarify";
    const replyId = importReplyId(freshId, "r1", replyText);
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

    // Give the promotion a distinguishable body before the re-import — editing
    // a promoted comment is exactly what promotion enables — so the two
    // exported comments can be told apart by more than their minted ids. It
    // does not touch the dedup: the ghost's key is derived from the FRESH
    // `w:id` and the re-imported body, neither of which this changes.
    withInternal(doc, () => {
      const promoted = map.get(promotionKey) as Annotation;
      map.set(promotionKey, { ...promoted, content: "Promoted body" });
    });

    comments[0].replies = [{ commentId: "r1", authorName: "Rita", bodyText: replyText }];
    expect(injectCommentsAsAnnotations(doc, comments, "r.docx")).toBe(1); // the ghost
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
    const ghostExport = prepared.find((c) => c.bodyParagraphs[0] === "Body of comment 1");
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
