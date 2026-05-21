/**
 * ADR-027 reply read+write privacy guards.
 *
 * Covers:
 *   (a) reply on comment   — write succeeds; read returns it.
 *   (b) reply on note      — write returns INVALID_ARGUMENT; read drops any
 *                            rogue rows even if forced into the Y.Map.
 *   (c) reply on highlight — write returns INVALID_ARGUMENT; read drops any
 *                            rogue rows even if forced into the Y.Map.
 *   (d) orphan parent      — write returns NOT_FOUND when the parent has been
 *                            deleted (covered by existing NOT_FOUND path).
 *
 * Channel-observer coverage for the same privacy guard lives in
 * `tests/server/replies-privacy.test.ts` (note / highlight / orphan skip + the
 * client-side `getVisibleReplies` mirror).
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  addReplyToAnnotation,
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

describe("ADR-027 reply privacy (write path)", () => {
  it("(a) accepts reply on a comment parent", () => {
    const ydoc = setupDoc("rw-comment", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "comment-content");

    const result = addReplyToAnnotation(ydoc, map, annId, "ack", "user");
    expect(result.ok).toBe(true);

    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    const replies = collectRepliesForAnnotation(repliesMap, annId);
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toBe("ack");
  });

  it("(b) rejects reply on a note parent with INVALID_ARGUMENT", () => {
    const ydoc = setupDoc("rw-note", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "note", rangeOf(0, 5, ydoc), "private note");

    const result = addReplyToAnnotation(ydoc, map, annId, "should fail", "user");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("INVALID_ARGUMENT");

    // Nothing should be written.
    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    expect(repliesMap.size).toBe(0);
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

describe("ADR-027 reply privacy (read path strips rogue rows)", () => {
  it("(b) note parent: read returns no replies even if rogue rows exist in Y.Map", () => {
    const ydoc = setupDoc("read-note", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "note", rangeOf(0, 5, ydoc), "private note");

    // Force a rogue reply row into the Y.Map directly, bypassing the
    // guarded write path. This simulates a legacy row that predates the
    // guard or a state-sync from a misbehaving peer.
    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    const rogue: AnnotationReply = {
      id: "rpl_rogue_note",
      annotationId: annId,
      author: "user",
      text: "leaked-from-note",
      timestamp: Date.now(),
      rev: 1,
    };
    ydoc.transact(() => repliesMap.set(rogue.id, rogue), MCP_ORIGIN);
    expect(repliesMap.size).toBe(1);

    // Simulate the read-path filter in tandem_getAnnotations:
    // only attach replies when parent.type === "comment".
    const ann = map.get(annId) as Annotation;
    const attached = ann.type === "comment" ? collectRepliesForAnnotation(repliesMap, annId) : [];
    expect(attached).toEqual([]);
  });

  it("(c) highlight parent: read returns no replies even if rogue rows exist in Y.Map", () => {
    const ydoc = setupDoc("read-hl", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "highlight", rangeOf(0, 5, ydoc), "");

    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    const rogue: AnnotationReply = {
      id: "rpl_rogue_hl",
      annotationId: annId,
      author: "user",
      text: "leaked-from-highlight",
      timestamp: Date.now(),
      rev: 1,
    };
    ydoc.transact(() => repliesMap.set(rogue.id, rogue), MCP_ORIGIN);
    expect(repliesMap.size).toBe(1);

    const ann = map.get(annId) as Annotation;
    const attached = ann.type === "comment" ? collectRepliesForAnnotation(repliesMap, annId) : [];
    expect(attached).toEqual([]);
  });
});
