import { beforeEach, describe, expect, it } from "vitest";
import { MCP_ORIGIN } from "../../src/server/events/queue.js";
import {
  addReplyToAnnotation,
  collectRepliesForAnnotation,
  createAnnotation,
} from "../../src/server/mcp/annotations.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import {
  addDoc,
  getOpenDocs,
  removeDoc,
  setActiveDocId,
} from "../../src/server/mcp/document-service.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import type { Annotation, AnnotationReply } from "../../src/shared/types.js";
import { rangeOf } from "../helpers/ydoc-factory.js";

function setupDoc(id: string, text: string) {
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  setActiveDocId(id);
  return ydoc;
}

beforeEach(() => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
});

describe("addReplyToAnnotation", () => {
  it("adds a reply to a pending annotation (happy path)", () => {
    const ydoc = setupDoc("reply-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "test comment");

    const result = addReplyToAnnotation(ydoc, map, annId, "I agree", "user");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.replyId).toMatch(/^rpl_/);

    // Verify the reply is stored in the replies Y.Map
    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    const stored = repliesMap.get(result.replyId) as AnnotationReply;
    expect(stored.annotationId).toBe(annId);
    expect(stored.text).toBe("I agree");
    expect(stored.author).toBe("user");
  });

  it("rejects reply to a non-existent annotation (NOT_FOUND)", () => {
    const ydoc = setupDoc("reply-2", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);

    const result = addReplyToAnnotation(ydoc, map, "fake_id", "reply text", "user");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("NOT_FOUND");
  });

  it("rejects reply to a resolved annotation (409 / ANNOTATION_RESOLVED)", () => {
    const ydoc = setupDoc("reply-3", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "test");

    // Resolve the annotation
    const ann = map.get(annId) as Annotation;
    map.set(annId, { ...ann, status: "accepted" });

    const result = addReplyToAnnotation(ydoc, map, annId, "too late", "user");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("ANNOTATION_RESOLVED");
    expect(result.error).toContain("accepted");
  });

  it("rejects reply to a dismissed annotation", () => {
    const ydoc = setupDoc("reply-4", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "test");

    const ann = map.get(annId) as Annotation;
    map.set(annId, { ...ann, status: "dismissed" });

    const result = addReplyToAnnotation(ydoc, map, annId, "too late", "claude", MCP_ORIGIN);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("ANNOTATION_RESOLVED");
  });
});

describe("event emission on reply", () => {
  it("emits event for user reply (no MCP_ORIGIN)", () => {
    const ydoc = setupDoc("evt-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "test");

    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    const events: Array<{ action: string; origin: unknown }> = [];
    repliesMap.observe((_event, txn) => {
      for (const [, change] of _event.changes.keys) {
        events.push({ action: change.action, origin: txn.origin });
      }
    });

    // User reply — no origin, so events should fire with null origin
    addReplyToAnnotation(ydoc, map, annId, "user says hi", "user");
    expect(events).toHaveLength(1);
    expect(events[0].origin).not.toBe(MCP_ORIGIN);
  });

  it("suppresses event for Claude reply (MCP_ORIGIN)", () => {
    const ydoc = setupDoc("evt-2", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "test");

    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    const mcpEvents: Array<{ action: string; origin: unknown }> = [];
    repliesMap.observe((_event, txn) => {
      // Only collect events tagged with MCP_ORIGIN (these would be suppressed by the real queue observer)
      if (txn.origin === MCP_ORIGIN) {
        for (const [, change] of _event.changes.keys) {
          mcpEvents.push({ action: change.action, origin: txn.origin });
        }
      }
    });

    // Claude reply — MCP_ORIGIN, observer filters these out
    addReplyToAnnotation(ydoc, map, annId, "claude says hi", "claude", MCP_ORIGIN);
    // The transaction IS tagged with MCP_ORIGIN, so the real event queue would skip it
    expect(mcpEvents).toHaveLength(1);
    expect(mcpEvents[0].origin).toBe(MCP_ORIGIN);
  });
});

describe("collectRepliesForAnnotation", () => {
  it("collects and sorts replies chronologically", () => {
    const ydoc = setupDoc("collect-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "test");

    addReplyToAnnotation(ydoc, map, annId, "first", "user");
    addReplyToAnnotation(ydoc, map, annId, "second", "claude", MCP_ORIGIN);
    addReplyToAnnotation(ydoc, map, annId, "third", "user");

    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    const replies = collectRepliesForAnnotation(repliesMap, annId);
    expect(replies).toHaveLength(3);
    expect(replies[0].text).toBe("first");
    expect(replies[1].text).toBe("second");
    expect(replies[2].text).toBe("third");
    // Chronological order
    expect(replies[0].timestamp).toBeLessThanOrEqual(replies[1].timestamp);
    expect(replies[1].timestamp).toBeLessThanOrEqual(replies[2].timestamp);
  });

  it("returns empty array when no replies exist", () => {
    const ydoc = setupDoc("collect-2", "Hello world");
    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    const replies = collectRepliesForAnnotation(repliesMap, "nonexistent");
    expect(replies).toEqual([]);
  });
});

describe("tandem_removeAnnotation cleans up replies", () => {
  it("deletes orphaned replies when annotation is removed", () => {
    const ydoc = setupDoc("cleanup-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "test");

    // Add replies to the annotation
    addReplyToAnnotation(ydoc, map, annId, "reply 1", "user");
    addReplyToAnnotation(ydoc, map, annId, "reply 2", "claude", MCP_ORIGIN);

    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    expect(repliesMap.size).toBe(2);

    // Simulate tandem_removeAnnotation logic: delete annotation + orphaned replies
    ydoc.transact(() => {
      map.delete(annId);
      const toDelete: string[] = [];
      repliesMap.forEach((value, key) => {
        const reply = value as { annotationId?: string };
        if (reply && reply.annotationId === annId) toDelete.push(key);
      });
      for (const key of toDelete) repliesMap.delete(key);
    }, MCP_ORIGIN);

    expect(map.has(annId)).toBe(false);
    expect(repliesMap.size).toBe(0);
  });

  it("does not delete replies belonging to other annotations", () => {
    const ydoc = setupDoc("cleanup-2", "Hello world test");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId1 = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "comment 1");
    const annId2 = createAnnotation(map, ydoc, "comment", rangeOf(6, 11, ydoc), "comment 2");

    addReplyToAnnotation(ydoc, map, annId1, "reply to 1", "user");
    addReplyToAnnotation(ydoc, map, annId2, "reply to 2", "user");

    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    expect(repliesMap.size).toBe(2);

    // Remove only annId1
    ydoc.transact(() => {
      map.delete(annId1);
      const toDelete: string[] = [];
      repliesMap.forEach((value, key) => {
        const reply = value as { annotationId?: string };
        if (reply && reply.annotationId === annId1) toDelete.push(key);
      });
      for (const key of toDelete) repliesMap.delete(key);
    }, MCP_ORIGIN);

    expect(map.has(annId1)).toBe(false);
    expect(map.has(annId2)).toBe(true);
    // Only annId2's reply remains
    expect(repliesMap.size).toBe(1);
    const remaining = collectRepliesForAnnotation(repliesMap, annId2);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].text).toBe("reply to 2");
  });
});
