/**
 * ADR-027 + #1000 reply read+write privacy guards.
 *
 * Since #1000, notes carry PRIVATE reply threads (user-authored + imported Word
 * threads) that must never reach Claude. Privacy is a durable property of the
 * reply (`private: true`), not of the parent's current type — so a note→comment
 * promotion cannot back-publish a previously-private reply.
 *
 * Covers:
 *   (a) reply on comment   — write succeeds; surfaces to Claude.
 *   (b) reply on note      — write succeeds and is stamped `private`; the
 *                            Claude read path (`channelVisibleReplies`) drops it.
 *   (c) reply on highlight — write returns INVALID_ARGUMENT (no body to thread).
 *   (d) orphan parent      — write returns NOT_FOUND.
 *   (e) PROMOTION LEAK      — a note's private replies stay hidden from Claude
 *                            even after the parent becomes a comment (#1000
 *                            BLOCKER regression).
 *
 * Channel-observer coverage for the same privacy guard lives in
 * `tests/server/replies-privacy.test.ts` (note / highlight / orphan skip + the
 * client-side `getVisibleReplies` mirror).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { addUserReply, createAnnotationLifecycle } from "../../src/server/annotations/lifecycle.js";
import {
  channelVisibleReplies,
  collectRepliesForAnnotation,
  createAnnotation,
} from "../../src/server/mcp/annotations.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { MCP_ORIGIN } from "../../src/shared/origins.js";
import type { Annotation, AnnotationReply } from "../../src/shared/types.js";
import { clearOpenDocs, setupDoc } from "../helpers/doc-service.js";
import { noRelay, rangeOf } from "../helpers/ydoc-factory.js";

beforeEach(() => {
  clearOpenDocs();
});

describe("ADR-027 + #1000 reply privacy (write path)", () => {
  it("(a) accepts reply on a comment parent and does NOT mark it private", () => {
    const ydoc = setupDoc("rw-comment", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "comment-content");

    const result = addUserReply(ydoc, annId, "ack", noRelay);
    expect(result.kind).toBe("ok");

    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    const replies = collectRepliesForAnnotation(repliesMap, annId);
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toBe("ack");
    expect(replies[0].private).toBeUndefined();
  });

  it("(b) accepts reply on a note parent and stamps it private", () => {
    const ydoc = setupDoc("rw-note", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "note", rangeOf(0, 5, ydoc), "private note");

    const result = addUserReply(ydoc, annId, "my private thought", noRelay);
    expect(result.kind).toBe("ok");

    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    const replies = collectRepliesForAnnotation(repliesMap, annId);
    expect(replies).toHaveLength(1);
    expect(replies[0].private).toBe(true);

    // ...but the Claude-facing read path returns nothing for a note parent.
    const note = map.get(annId) as Annotation;
    expect(
      channelVisibleReplies(note, (id) => collectRepliesForAnnotation(repliesMap, id)),
    ).toEqual([]);
  });

  it("(b2) rejects a CLAUDE reply on a note parent (ADR-027: Claude never touches notes)", () => {
    const ydoc = setupDoc("rw-note-claude", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "note", rangeOf(0, 5, ydoc), "private note");

    // Unit 8f: the two paths are now different FUNCTIONS rather than the same
    // one branching on an author string — `lifecycle.reply` carries the ADR-027
    // guard, `addUserReply` does not and must not, since replying to one's own
    // note is exactly what ADR-027 permits (case (b) above).
    const result = createAnnotationLifecycle(ydoc).reply(annId, "claude probe", noRelay);
    // `invalid-note`, an arm ONLY the ADR-027 guard produces. Under the old
    // `INVALID_ARGUMENT` this spec also passed when the reply was refused for
    // being over-length or for having a highlight parent — neither of which is
    // the privacy rule this spec is named for.
    expect(result).toStrictEqual({ kind: "invalid-note" });
    expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(0);
  });

  // #1619's write-side twin, closed by Unit 8f.
  //
  // `channelVisibleReplies` gates Claude's READ on `type` and `private` and
  // never looks at `audience`, while the channel projection checks both. So a
  // stored `{type: "comment", audience: "private"}` — reachable by a legacy
  // envelope or a stale-tab CRDT merge, and NOT healed by `sanitizeAnnotation`,
  // whose audience guard covers note/highlight/flag but deliberately not
  // comment — let Claude write into a thread the user had kept back. Worse, the
  // parent's type is `comment`, so the reply was stamped with no `private` flag
  // and became permanently shared.
  it("(b3) refuses a CLAUDE reply on a private-audience COMMENT parent", () => {
    const ydoc = setupDoc("rw-private-comment", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "held back");
    // Written past `createAnnotation` on purpose: no supported path produces
    // this record, which is exactly why it is worth pinning — it arrives by
    // legacy envelope or CRDT merge, not by an API call.
    map.set(annId, { ...(map.get(annId) as Annotation), audience: "private" });

    const result = createAnnotationLifecycle(ydoc).reply(annId, "claude probe", noRelay);
    expect(result).toStrictEqual({ kind: "invalid-note" });
    expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(0);
  });

  it("(b3b) refuses a stored legacy `flag`, which is a note only AFTER sanitize", () => {
    // The ordering claim in `replyForClaude`'s docblock, which nothing pinned.
    // Every other reply fixture seeds a record whose raw type already equals its
    // sanitized type, so `sanitizeAnnotation(raw, onLossy)` could be replaced
    // with a raw cast and 84 specs stayed green — measured, not supposed. Under
    // that mutation a stored `flag` (which normalizes to a private note) falls
    // through and Claude writes into it. `adr027-note-write-guards.test.ts`
    // carries `f1`/`f2` for the remove and resolve families for this reason.
    const ydoc = setupDoc("rw-flag", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "legacy");
    // Written past `createAnnotation`: `flag` is not in `AnnotationType` any
    // more, which is the whole point — it only arrives from storage.
    map.set(annId, { ...(map.get(annId) as Annotation), type: "flag" });

    const result = createAnnotationLifecycle(ydoc).reply(annId, "claude probe", noRelay);
    expect(result).toStrictEqual({ kind: "invalid-note" });
    expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(0);
  });

  it("(b4) control: the SAME parent at audience outbound accepts Claude's reply", () => {
    // Without this row, (b3) passes on a fixture that is unreplyable for some
    // other reason entirely — a wrong status, a malformed range, a guard that
    // refuses every comment. The only difference between the two rows is the
    // one field the guard reads.
    const ydoc = setupDoc("rw-outbound-comment", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "shared");
    map.set(annId, { ...(map.get(annId) as Annotation), audience: "outbound" });

    const result = createAnnotationLifecycle(ydoc).reply(annId, "claude probe", noRelay);
    expect(result.kind).toBe("ok");
    expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(1);
  });

  it("(b5) the USER may still reply on that private-audience comment", () => {
    // The guard belongs to Claude's entry alone. A version of it applied to
    // `addUserReply` would lock the user out of their own withheld thread —
    // which reads as "more private" and is the opposite of ADR-027, where
    // privacy means Claude cannot see it, never that the user cannot write it.
    const ydoc = setupDoc("rw-private-user", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "held back");
    map.set(annId, { ...(map.get(annId) as Annotation), audience: "private" });

    expect(addUserReply(ydoc, annId, "my own thread", noRelay).kind).toBe("ok");
    expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(1);
  });

  it("(b6) a highlight parent refuses Claude with not-repliable, NOT invalid-note", () => {
    // Guard scope. The obvious spelling of the ADR-027 test is
    // `ann.type !== "comment"`, which also swallows a highlight and answers
    // `invalid-note` — a refusal naming a rule that had nothing to do with it,
    // masking the arm that carries the real parent type. Both map to
    // INVALID_ARGUMENT on the wire, so nothing but an arm-level assertion can
    // see the difference; this row is why the guard is written as it is.
    const ydoc = setupDoc("rw-highlight-claude", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "highlight", rangeOf(0, 5, ydoc), "");

    const result = createAnnotationLifecycle(ydoc).reply(annId, "claude probe", noRelay);
    expect(result).toStrictEqual({ kind: "not-repliable", annotationType: "highlight" });
  });

  it("(c) rejects reply on a highlight parent with INVALID_ARGUMENT", () => {
    const ydoc = setupDoc("rw-highlight", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "highlight", rangeOf(0, 5, ydoc), "");

    const result = addUserReply(ydoc, annId, "should fail", noRelay);
    expect(result).toStrictEqual({ kind: "not-repliable", annotationType: "highlight" });

    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    expect(repliesMap.size).toBe(0);
  });

  it("(d) rejects reply when parent annotation is missing (NOT_FOUND)", () => {
    const ydoc = setupDoc("rw-orphan", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "comment");

    // Delete the parent first.
    ydoc.transact(() => map.delete(annId), MCP_ORIGIN);

    const result = addUserReply(ydoc, annId, "too late", noRelay);
    expect(result).toStrictEqual({ kind: "not-found", id: annId });
  });
});

describe("ADR-027 + #1000 reply privacy (Claude read path: channelVisibleReplies)", () => {
  it("comment parent: returns non-private replies, strips private ones", () => {
    const ydoc = setupDoc("read-comment", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "c");
    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);

    const visible: AnnotationReply = {
      id: "rpl_visible",
      annotationId: annId,
      author: "user",
      text: "surfaces",
      timestamp: 1,
      rev: 1,
    };
    const hidden: AnnotationReply = {
      id: "rpl_hidden",
      annotationId: annId,
      author: "user",
      text: "do-not-leak",
      timestamp: 2,
      rev: 1,
      private: true,
    };
    ydoc.transact(() => {
      repliesMap.set(visible.id, visible);
      repliesMap.set(hidden.id, hidden);
    }, MCP_ORIGIN);

    const ann = map.get(annId) as Annotation;
    const out = channelVisibleReplies(ann, (id) => collectRepliesForAnnotation(repliesMap, id));
    expect(out.map((r) => r.id)).toEqual(["rpl_visible"]);
  });

  it("note parent: returns nothing even with replies present", () => {
    const ydoc = setupDoc("read-note", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "note", rangeOf(0, 5, ydoc), "private note");
    addUserReply(ydoc, annId, "thought", noRelay);
    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);

    const ann = map.get(annId) as Annotation;
    expect(channelVisibleReplies(ann, (id) => collectRepliesForAnnotation(repliesMap, id))).toEqual(
      [],
    );
  });

  it("(e) PROMOTION LEAK: a note's private replies stay hidden after note→comment promotion", () => {
    const ydoc = setupDoc("read-promote", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "note", rangeOf(0, 5, ydoc), "private note");
    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);

    // A user reply authored while it was a note (→ private), plus an imported
    // Word reply (→ private).
    addUserReply(ydoc, annId, "my private deliberation", noRelay);
    const importReply: AnnotationReply = {
      id: "rpl_import",
      annotationId: annId,
      author: "import",
      text: "Reviewer's private thread",
      timestamp: 3,
      rev: 1,
      private: true,
      importAuthor: "Jane Reviewer",
    };
    ydoc.transact(() => repliesMap.set(importReply.id, importReply), MCP_ORIGIN);

    // Simulate promoteNoteToComment flipping the parent type (it does NOT touch
    // the replies map).
    const note = map.get(annId) as Annotation;
    ydoc.transact(() => map.set(annId, { ...note, type: "comment" } as Annotation), MCP_ORIGIN);

    // A NEW reply added after promotion (parent is now a comment) is NOT private.
    addUserReply(ydoc, annId, "now visible to Claude", noRelay);

    const promoted = map.get(annId) as Annotation;
    expect(promoted.type).toBe("comment");

    const out = channelVisibleReplies(promoted, (id) =>
      collectRepliesForAnnotation(repliesMap, id),
    );
    // Only the post-promotion reply surfaces; the pre-promotion private + import
    // replies remain hidden from Claude.
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("now visible to Claude");
    expect(out.some((r) => r.author === "import")).toBe(false);
  });
});
