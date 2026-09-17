/**
 * #1295 L3 — an over-long reply used to be accepted into the live Y.Doc, shown
 * in the UI, and then silently dropped on the next load, because the DURABLE
 * schema caps replies at REPLY_TEXT_MAX and `normalizeReply` safeParses per
 * record. Only a stderr line marked the loss.
 */
import { describe, expect, it } from "vitest";
import {
  addUserReply,
  createAnnotationLifecycle,
  describeReplyWriteRefusal,
} from "../../src/server/annotations/lifecycle.js";
import { REPLY_TEXT_MAX } from "../../src/server/annotations/schema.js";
import { Y_MAP_ANNOTATION_REPLIES } from "../../src/shared/constants.js";
import { getAnnotationsMap, makeMarkdownDoc, noRelay } from "../helpers/ydoc-factory.js";

/** Replies live in their OWN Y.Map, not nested on the annotation record. */
function replyCount(ydoc: ReturnType<typeof makeMarkdownDoc>): number {
  return ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size;
}

function seedComment(ydoc: ReturnType<typeof makeMarkdownDoc>) {
  const map = getAnnotationsMap(ydoc);
  map.set("a1", {
    id: "a1",
    type: "comment",
    author: "claude",
    content: "c",
    status: "pending",
    range: { from: 0, to: 1 },
    timestamp: Date.now(),
  });
  return map;
}

describe("the reply seam — write-time length bound", () => {
  it("rejects a reply over REPLY_TEXT_MAX with a structured error", () => {
    const ydoc = makeMarkdownDoc("# H\n\nbody\n");
    seedComment(ydoc);

    const result = addUserReply(ydoc, "a1", "x".repeat(REPLY_TEXT_MAX + 1), noRelay);

    // `too-long` specifically, carrying the bound it enforced. The old
    // `INVALID_ARGUMENT` was shared with the highlight-parent and note refusals,
    // so this spec passed on a reply rejected for the wrong reason entirely —
    // and `if (!result.ok)` meant a PASSING write asserted nothing at all.
    expect(result).toStrictEqual({ kind: "too-long", max: REPLY_TEXT_MAX });
    // The point is that nothing was written: silent data loss became a refusal.
    expect(replyCount(ydoc)).toBe(0);
    ydoc.destroy();
  });

  it("accepts a reply exactly at the limit", () => {
    // Positive control on the same sample, and an off-by-one pin: the write
    // bound and the durable schema bound must be the SAME number, or a reply
    // accepted here would still be dropped at load — the very bug being fixed.
    const ydoc = makeMarkdownDoc("# H\n\nbody\n");
    seedComment(ydoc);

    const result = addUserReply(ydoc, "a1", "x".repeat(REPLY_TEXT_MAX), noRelay);

    expect(result.kind).toBe("ok");
    expect(replyCount(ydoc)).toBe(1);
    ydoc.destroy();
  });

  it("carries the bound into the wire message, not just the result", () => {
    // The refusal and the SENTENCE the caller sees are two separate things, and
    // only the first was pinned. `describeReplyWriteRefusal` is what every
    // Claude-facing consumer routes through (the seam test pins that they all
    // do), so an arm that dropped `result.max` would produce a limit message
    // naming no limit — a refusal the user cannot act on — with the structured
    // assertions above still green.
    //
    // Reached directly because no caller can produce it: `tandem_annotationReply`
    // caps `text` in its Zod schema, so Claude's path is refused a layer earlier
    // and the user's path (`addUserReply`, above) returns the raw result without
    // describing it. That is why this arm was the file's only uncovered one.
    expect(describeReplyWriteRefusal({ kind: "too-long", max: REPLY_TEXT_MAX })).toStrictEqual({
      code: "INVALID_ARGUMENT",
      message: `Reply text exceeds the ${REPLY_TEXT_MAX}-character limit`,
    });
  });
});

/**
 * #1626 — the same bound, PER FIELD, on a reply's `suggestedText`.
 *
 * The entry is `createAnnotationLifecycle(ydoc).reply(...)` rather than
 * `addUserReply`, which the cases above drive: a suggestion is a Claude
 * capability and the user's entry deliberately cannot carry one (#1000's
 * asymmetry). The bound is the same number as the durable schema's for the same
 * reason the `text` bound is — a value accepted at write and rejected at load is
 * exactly the silent loss #1295 L3 fixed.
 */
describe("the reply seam — write-time length bound on suggestedText (#1626)", () => {
  /**
   * A parent anchored over the BODY, not over `seedComment`'s `[0, 1)`.
   *
   * That range sits inside the `"# "` heading prefix, so a suggestion-bearing
   * reply on it is refused by the #1626 heading screen — which runs ahead of the
   * length check and would make every case below pass for the wrong reason. The
   * flat text of this fixture is `"# H\nbody"`, so `[4, 8)` is `"body"`.
   */
  function seedBodyComment(ydoc: ReturnType<typeof makeMarkdownDoc>) {
    const map = getAnnotationsMap(ydoc);
    map.set("a1", {
      id: "a1",
      type: "comment",
      author: "claude",
      content: "c",
      status: "pending",
      range: { from: 4, to: 8 },
      timestamp: Date.now(),
    });
    return map;
  }

  it("accepts text and suggestedText BOTH exactly at the limit", () => {
    // Per-field parity with the durable schema, which caps each field
    // independently. An implementation that summed them would refuse this.
    const ydoc = makeMarkdownDoc("# H\n\nbody\n");
    seedBodyComment(ydoc);

    const result = createAnnotationLifecycle(ydoc).reply(
      "a1",
      "x".repeat(REPLY_TEXT_MAX),
      { kind: "replacement", suggestedText: "y".repeat(REPLY_TEXT_MAX) },
      noRelay,
    );

    expect(result.kind).toBe("ok");
    expect(replyCount(ydoc)).toBe(1);
    ydoc.destroy();
  });

  it("refuses a suggestedText one over the limit, writing nothing", () => {
    const ydoc = makeMarkdownDoc("# H\n\nbody\n");
    seedBodyComment(ydoc);

    const result = createAnnotationLifecycle(ydoc).reply(
      "a1",
      "short",
      { kind: "replacement", suggestedText: "y".repeat(REPLY_TEXT_MAX + 1) },
      noRelay,
    );

    // The existing `too-long` arm, reused: a separate `suggestion-too-long`
    // would widen the closed `ReplyRefusalCode` set for no wire difference.
    expect(result).toStrictEqual({ kind: "too-long", max: REPLY_TEXT_MAX });
    expect(replyCount(ydoc)).toBe(0);
    ydoc.destroy();
  });

  it("still refuses an over-long text on the same entry, unchanged", () => {
    const ydoc = makeMarkdownDoc("# H\n\nbody\n");
    seedBodyComment(ydoc);

    const result = createAnnotationLifecycle(ydoc).reply(
      "a1",
      "x".repeat(REPLY_TEXT_MAX + 1),
      { kind: "none" },
      noRelay,
    );

    expect(result).toStrictEqual({ kind: "too-long", max: REPLY_TEXT_MAX });
    expect(replyCount(ydoc)).toBe(0);
    ydoc.destroy();
  });
});
