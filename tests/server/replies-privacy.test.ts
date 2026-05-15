/**
 * ADR-027 privacy guard regression test for the reply channel observer.
 *
 * The observer in `src/server/events/observers/replies.ts` must only push
 * `annotation:reply` channel events when the parent annotation is a
 * `comment`. Replies on `note` (user-private) or `highlight` (user-only UI
 * markup) must be silent — otherwise replying on either type would leak the
 * parent's `textSnapshot` plus the reply text to Claude via SSE.
 *
 * Plus a smoke test for the client-side `getVisibleReplies` helper that
 * mirrors the same filter.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getVisibleReplies } from "../../src/client/annotations/replies.js";
import { makeRepliesObserver } from "../../src/server/events/observers/replies.js";
import type { TandemEvent } from "../../src/server/events/types.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import type { Annotation, AnnotationReply, AnnotationType } from "../../src/shared/types.js";

function seedParentAnnotation(doc: Y.Doc, type: AnnotationType): string {
  const annId = `ann_${type}_${Math.random().toString(36).slice(2, 8)}`;
  const annotation: Annotation = {
    id: annId,
    author: "user",
    type,
    range: { from: toFlatOffset(0), to: toFlatOffset(5) },
    content: type === "highlight" ? "" : "parent annotation body",
    status: "pending",
    timestamp: Date.now(),
    textSnapshot: "PRIVATE PARENT TEXT — must not leak",
  };
  doc.getMap(Y_MAP_ANNOTATIONS).set(annId, annotation);
  return annId;
}

function addUserReply(doc: Y.Doc, annotationId: string, text: string): string {
  const id = `rpl_${Math.random().toString(36).slice(2, 10)}`;
  const reply: AnnotationReply = {
    id,
    annotationId,
    author: "user",
    text,
    timestamp: Date.now(),
  };
  // No origin tag — mirrors a browser-originated write so the observer is
  // not short-circuited by the MCP_ORIGIN / FILE_SYNC_ORIGIN filter.
  doc.getMap(Y_MAP_ANNOTATION_REPLIES).set(id, reply);
  return id;
}

function setup(parentType: AnnotationType): {
  doc: Y.Doc;
  events: TandemEvent[];
  dispose: () => void;
  parentId: string;
} {
  const doc = new Y.Doc();
  const events: TandemEvent[] = [];
  const parentId = seedParentAnnotation(doc, parentType);
  const dispose = makeRepliesObserver({
    docName: `doc_${parentType}`,
    doc,
    pushEvent: (e) => events.push(e),
  });
  return { doc, events, dispose, parentId };
}

describe("replies observer — ADR-027 privacy guard", () => {
  it("fires annotation:reply for a reply on a comment", () => {
    const { doc, events, dispose, parentId } = setup("comment");
    addUserReply(doc, parentId, "reply body");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("annotation:reply");
    expect(events[0].payload).toMatchObject({
      annotationId: parentId,
      replyText: "reply body",
      replyAuthor: "user",
      textSnippet: "PRIVATE PARENT TEXT — must not leak",
    });
    dispose();
  });

  it("does NOT fire for a reply on a note (user-private per ADR-027)", () => {
    const { doc, events, dispose, parentId } = setup("note");
    addUserReply(doc, parentId, "should never reach Claude");
    expect(events).toHaveLength(0);
    dispose();
  });

  it("does NOT fire for a reply on a highlight", () => {
    const { doc, events, dispose, parentId } = setup("highlight");
    addUserReply(doc, parentId, "highlights are user-only UI markup");
    expect(events).toHaveLength(0);
    dispose();
  });

  it("does NOT fire when the parent annotation is missing (deleted before observe)", () => {
    const doc = new Y.Doc();
    const events: TandemEvent[] = [];
    const dispose = makeRepliesObserver({
      docName: "doc_orphan",
      doc,
      pushEvent: (e) => events.push(e),
    });
    // Reply references an annotation that never existed — no leak path.
    addUserReply(doc, "ann_missing", "orphan reply");
    expect(events).toHaveLength(0);
    dispose();
  });
});

describe("getVisibleReplies — client mirror of the privacy guard", () => {
  const baseReply: AnnotationReply = {
    id: "rpl_1",
    annotationId: "ann_1",
    author: "user",
    text: "hello",
    timestamp: 0,
  };
  const baseAnn: Annotation = {
    id: "ann_1",
    author: "user",
    type: "comment",
    range: { from: toFlatOffset(0), to: toFlatOffset(1) },
    content: "x",
    status: "pending",
    timestamp: 0,
  };

  it("returns replies for comments", () => {
    expect(getVisibleReplies(baseAnn, [baseReply])).toEqual([baseReply]);
  });

  it("returns [] for notes", () => {
    expect(getVisibleReplies({ ...baseAnn, type: "note" }, [baseReply])).toEqual([]);
  });

  it("returns [] for highlights", () => {
    expect(getVisibleReplies({ ...baseAnn, type: "highlight" }, [baseReply])).toEqual([]);
  });

  it("handles undefined reply list", () => {
    expect(getVisibleReplies(baseAnn, undefined)).toEqual([]);
  });
});
