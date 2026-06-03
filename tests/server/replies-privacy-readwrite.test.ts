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
import {
  addReplyToAnnotation,
  channelVisibleReplies,
  collectRepliesForAnnotation,
  createAnnotation,
} from "../../src/server/mcp/annotations.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { MCP_ORIGIN } from "../../src/shared/origins.js";
import type { Annotation, AnnotationReply } from "../../src/shared/types.js";
import { clearOpenDocs, setupDoc } from "../helpers/doc-service.js";
import { rangeOf } from "../helpers/ydoc-factory.js";

beforeEach(() => {
  clearOpenDocs();
});

describe("ADR-027 + #1000 reply privacy (write path)", () => {
  it("(a) accepts reply on a comment parent and does NOT mark it private", () => {
    const ydoc = setupDoc("rw-comment", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "comment-content");

    const result = addReplyToAnnotation(ydoc, map, annId, "ack", "user");
    expect(result.ok).toBe(true);

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

    const result = addReplyToAnnotation(ydoc, map, annId, "my private thought", "user");
    expect(result.ok).toBe(true);

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

    // The MCP tool path passes author "claude"; user replies (author "user")
    // are accepted by case (b) above.
    const result = addReplyToAnnotation(ydoc, map, annId, "claude probe", "claude");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("INVALID_ARGUMENT");
    expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(0);
  });

  it("(c) rejects reply on a highlight parent with INVALID_ARGUMENT", () => {
    const ydoc = setupDoc("rw-highlight", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "highlight", rangeOf(0, 5, ydoc), "");

    const result = addReplyToAnnotation(ydoc, map, annId, "should fail", "user");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("INVALID_ARGUMENT");

    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    expect(repliesMap.size).toBe(0);
  });

  it("(d) rejects reply when parent annotation is missing (NOT_FOUND)", () => {
    const ydoc = setupDoc("rw-orphan", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "comment");

    // Delete the parent first.
    ydoc.transact(() => map.delete(annId), MCP_ORIGIN);

    const result = addReplyToAnnotation(ydoc, map, annId, "too late", "user");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("NOT_FOUND");
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
    addReplyToAnnotation(ydoc, map, annId, "thought", "user");
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
    addReplyToAnnotation(ydoc, map, annId, "my private deliberation", "user");
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
    addReplyToAnnotation(ydoc, map, annId, "now visible to Claude", "user");

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
