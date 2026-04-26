import { beforeEach, describe, expect, it } from "vitest";
import { docHash } from "../../src/server/annotations/doc-hash.js";
import { getTombstones, resetForTesting } from "../../src/server/annotations/sync.js";
import {
  addReplyToAnnotation,
  createAnnotation,
  removeAnnotationById,
} from "../../src/server/mcp/annotations.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { clearOpenDocs, setupDoc } from "../helpers/doc-service.js";
import { rangeOf } from "../helpers/ydoc-factory.js";

beforeEach(() => {
  clearOpenDocs();
  resetForTesting();
});

describe("removeAnnotationById", () => {
  it("deletes annotation from map and records tombstone", () => {
    const ydoc = setupDoc("rm-fn-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5), "test note");

    const filePath = "/tmp/rm-fn-1.md";
    const result = removeAnnotationById(ydoc, map, filePath, id);

    expect(result.ok).toBe(true);
    expect(map.has(id)).toBe(false);

    const tombstones = getTombstones(docHash(filePath));
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].id).toBe(id);
  });

  it("cleans up orphaned replies", () => {
    const ydoc = setupDoc("rm-fn-2", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5), "noted");

    addReplyToAnnotation(ydoc, map, id, "reply 1", "user");
    addReplyToAnnotation(ydoc, map, id, "reply 2", "claude");

    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    expect(repliesMap.size).toBe(2);

    removeAnnotationById(ydoc, map, "/tmp/rm-fn-2.md", id);

    expect(repliesMap.size).toBe(0);
  });

  it("returns NOT_FOUND for non-existent annotation", () => {
    const ydoc = setupDoc("rm-fn-3", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);

    const result = removeAnnotationById(ydoc, map, "/tmp/rm-fn-3.md", "fake_id");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NOT_FOUND");
    }
  });

  it("does not delete replies belonging to other annotations", () => {
    const ydoc = setupDoc("rm-fn-4", "Hello world test");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id1 = createAnnotation(map, ydoc, "comment", rangeOf(0, 5), "first");
    const id2 = createAnnotation(map, ydoc, "comment", rangeOf(6, 11), "second");

    addReplyToAnnotation(ydoc, map, id1, "reply to first", "user");
    addReplyToAnnotation(ydoc, map, id2, "reply to second", "user");

    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    expect(repliesMap.size).toBe(2);

    removeAnnotationById(ydoc, map, "/tmp/rm-fn-4.md", id1);

    expect(repliesMap.size).toBe(1);
    let remainingAnnotationId: string | undefined;
    repliesMap.forEach((v) => {
      remainingAnnotationId = (v as { annotationId: string }).annotationId;
    });
    expect(remainingAnnotationId).toBe(id2);
  });
});
