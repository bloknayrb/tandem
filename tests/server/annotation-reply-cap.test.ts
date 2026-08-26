/**
 * #1295 L3 — an over-long reply used to be accepted into the live Y.Doc, shown
 * in the UI, and then silently dropped on the next load, because the DURABLE
 * schema caps replies at REPLY_TEXT_MAX and `normalizeReply` safeParses per
 * record. Only a stderr line marked the loss.
 */
import { describe, expect, it } from "vitest";
import { REPLY_TEXT_MAX } from "../../src/server/annotations/schema.js";
import { addReplyToAnnotation } from "../../src/server/mcp/annotations.js";
import { Y_MAP_ANNOTATION_REPLIES } from "../../src/shared/constants.js";
import { getAnnotationsMap, makeMarkdownDoc } from "../helpers/ydoc-factory.js";

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

describe("addReplyToAnnotation — write-time length bound", () => {
  it("rejects a reply over REPLY_TEXT_MAX with a structured error", () => {
    const ydoc = makeMarkdownDoc("# H\n\nbody\n");
    const map = seedComment(ydoc);

    const result = addReplyToAnnotation(ydoc, map, "a1", "x".repeat(REPLY_TEXT_MAX + 1), "user");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_ARGUMENT");
    // The point is that nothing was written: silent data loss became a refusal.
    expect(replyCount(ydoc)).toBe(0);
    ydoc.destroy();
  });

  it("accepts a reply exactly at the limit", () => {
    // Positive control on the same sample, and an off-by-one pin: the write
    // bound and the durable schema bound must be the SAME number, or a reply
    // accepted here would still be dropped at load — the very bug being fixed.
    const ydoc = makeMarkdownDoc("# H\n\nbody\n");
    const map = seedComment(ydoc);

    const result = addReplyToAnnotation(ydoc, map, "a1", "x".repeat(REPLY_TEXT_MAX), "user");

    expect(result.ok).toBe(true);
    expect(replyCount(ydoc)).toBe(1);
    ydoc.destroy();
  });
});
