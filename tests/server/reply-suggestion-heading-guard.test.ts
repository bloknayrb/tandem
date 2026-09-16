/**
 * #1626 — a reply may carry a `suggestedText`, which makes it the THIRD carrier
 * of Critical Rule 6's heading-INTERIOR term (`rejectHeadingInterior`, #1766).
 *
 * A stored suggestion is a text rewrite DEFERRED to Accept: the client's accept
 * replaces the parent's flat span verbatim, and `snapshotContradicts` cannot
 * object because the snapshot was captured over that exact span and still
 * matches. So without the screen, a reply proposing a replacement on a parent
 * that steps over a `"## "` prefix deletes the heading, silently.
 *
 * Two properties of this carrier are what the cases below exist for, because
 * both have a plausible wrong implementation that passes the obvious test:
 *
 *  1. **The screen must run only on the `replacement` arm.** Applying the
 *     interior term to every reply would refuse ordinary multi-section replies,
 *     which are legal — a comment spanning a section is exactly what
 *     `tandem_comment`'s plain arm permits.
 *  2. **The offsets screened are the parent's LIVE ones**, resolved through its
 *     CRDT anchor, not the offsets stored at creation. The two existing carriers
 *     have no such exposure: both validate offsets derived from the live
 *     document moments earlier, while a reply screens a parent anchored at some
 *     earlier time.
 *
 * `anchoredRange`'s fourth argument is deliberately `undefined` rather than the
 * parent's `textSnapshot`: the staleness gate compares by exact equality while
 * `captureSnapshot` caps at SNAPSHOT_CAP, so a snapshot would refuse every
 * parent longer than 200 characters on an untouched document. Case 3 is what
 * fails against that.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { createAnnotationLifecycle } from "../../src/server/annotations/lifecycle.js";
import { getOrCreateXmlText } from "../../src/server/mcp/document-model.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { SNAPSHOT_CAP } from "../../src/shared/snapshot.js";
import { clearOpenDocs, setupDoc } from "../helpers/doc-service.js";
import { assertReplyOk } from "../helpers/reply-results.js";
import { createAnnotation, noRelay, rangeOf } from "../helpers/ydoc-factory.js";

/**
 * The #1766 fixture. The heading block starts at flat offset 5 and its `"## "`
 * prefix occupies [5, 8); "Head" runs [8, 12) and "next" [13, 17).
 */
const FIXTURE = "para\n## Head\nnext";

const REPLACEMENT = { kind: "replacement", suggestedText: "REPLACED" } as const;

/** A Claude-authored pending comment over `[from, to)`, which Claude may reply to. */
function seedParent(ydoc: Y.Doc, from: number, to: number, extras?: Record<string, unknown>) {
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  return createAnnotation(map, ydoc, "comment", rangeOf(from, to, ydoc), "parent", extras);
}

function replyCount(ydoc: Y.Doc): number {
  return ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size;
}

beforeEach(() => {
  clearOpenDocs();
});

describe("#1626: a suggestion-bearing reply is screened for heading markup", () => {
  it("refuses one whose parent's span steps over a heading prefix", () => {
    // [4, 9) clears the prefix at both ENDPOINTS — 4 is the paragraph's last
    // offset and 9 is inside "Head" — so the endpoint-only rule says ok and the
    // accepted replacement would delete "## ".
    const ydoc = setupDoc("rsh-interior", FIXTURE);
    const parent = seedParent(ydoc, 4, 9);

    const result = createAnnotationLifecycle(ydoc).reply(parent, "how about", REPLACEMENT, noRelay);

    expect(result).toStrictEqual({ kind: "invalid-suggestion-range" });
    // Refused means refused: nothing was written.
    expect(replyCount(ydoc)).toBe(0);
  });

  it("accepts the SAME reply without a suggestion — the interior term is not unconditional", () => {
    // The control that keeps the screen on the `replacement` arm. An
    // implementation that screens every reply turns this red, and would refuse
    // every ordinary reply on a multi-section comment.
    const ydoc = setupDoc("rsh-plain", FIXTURE);
    const parent = seedParent(ydoc, 4, 9);

    const result = createAnnotationLifecycle(ydoc).reply(
      parent,
      "a plain reply",
      { kind: "none" },
      noRelay,
    );

    assertReplyOk(result);
    expect(replyCount(ydoc)).toBe(1);
  });

  it("accepts a suggestion on a parent longer than SNAPSHOT_CAP, on an untouched document", () => {
    // **The discriminating case for the fourth argument.** `captureSnapshot`
    // caps a stored snapshot at 200 characters, and the staleness gate compares
    // by exact equality — so passing `parent.textSnapshot` refuses this with
    // RANGE_MOVED and `resolvedTo = from + 200`, a range shrunk to the prefix,
    // on a document nobody edited.
    const long = "z".repeat(SNAPSHOT_CAP + 80);
    const ydoc = setupDoc("rsh-long", long);
    const parent = seedParent(ydoc, 0, long.length, {
      textSnapshot: long.slice(0, SNAPSHOT_CAP),
      textSnapshotTruncated: true,
    });

    const result = createAnnotationLifecycle(ydoc).reply(parent, "refined", REPLACEMENT, noRelay);

    assertReplyOk(result);
    const stored = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).get(result.replyId) as {
      suggestedText?: string;
    };
    expect(stored.suggestedText).toBe("REPLACED");
  });

  it("screens the parent's LIVE span, not the offsets it was stored with", () => {
    // **The case that distinguishes `refreshRange(...)` from `ann.range`.**
    //
    // The parent is anchored over "Head" — [8, 12), inside the heading's TEXT
    // and past its prefix, which is legal. A later edit inserts four characters
    // at the START of the document, so:
    //
    //   live  → [12, 16), still exactly "Head": no heading markup, accept;
    //   stored → [8, 12) reinterpreted against the NEW text, which now spans
    //            the newline plus "## ": the prefix sits inside it, refuse.
    //
    // At accept time the client resolves through `relRange`, so the live span is
    // the one that gets rewritten. An implementation screening `ann.range`
    // refuses a legitimate proposal here and turns this red.
    //
    // (The mirror direction — an edit that moves a parent ONTO a prefix while
    // its stored offsets stay clear — is not constructible: a range only gains a
    // prefix when a heading block is inserted INSIDE its span, and the stored
    // offsets, being the same length starting at the same place, then cover part
    // of that prefix too. Both implementations refuse there, so it discriminates
    // nothing; this direction is the one that does.)
    const ydoc = setupDoc("rsh-live", FIXTURE);
    const parent = seedParent(ydoc, 8, 12);

    const paragraph = ydoc.getXmlFragment("default").get(0) as Y.XmlElement;
    withInternal(ydoc, () => getOrCreateXmlText(paragraph).insert(0, "xxxx"));

    const result = createAnnotationLifecycle(ydoc).reply(parent, "refined", REPLACEMENT, noRelay);

    assertReplyOk(result);
    expect(replyCount(ydoc)).toBe(1);
  });
});
