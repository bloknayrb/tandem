import { beforeEach, describe, expect, it } from "vitest";
import { addUserReply, createAnnotationLifecycle } from "../../src/server/annotations/lifecycle.js";
import { collectRepliesForAnnotation } from "../../src/server/mcp/annotations.js";
import { hideFromAI } from "../../src/server/mode.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";
import {
  BROWSER_ORIGIN,
  MCP_ORIGIN,
  shouldSkipChannel,
  withInternal,
} from "../../src/shared/origins.js";
import type { Annotation, AnnotationReply } from "../../src/shared/types.js";
import { createAnnotation } from "../helpers/annotation-minter.js";
import { clearOpenDocs, setupDoc } from "../helpers/doc-service.js";
import { assertReplyOk } from "../helpers/reply-results.js";
import { noRelay, rangeOf } from "../helpers/ydoc-factory.js";

function setMode(mode: string | undefined) {
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => {
    const aw = ctrl.getMap(Y_MAP_USER_AWARENESS);
    if (mode === undefined) aw.delete(Y_MAP_MODE);
    else aw.set(Y_MAP_MODE, mode);
  });
}

beforeEach(() => {
  clearOpenDocs();
  setMode(undefined);
});

describe("the reply seam — addUserReply and lifecycle.reply", () => {
  it("adds a reply to a pending annotation (happy path)", () => {
    const ydoc = setupDoc("reply-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "test comment");

    const result = addUserReply(ydoc, annId, "I agree", noRelay);
    assertReplyOk(result);
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

    const result = addUserReply(ydoc, "fake_id", "reply text", noRelay);
    // The ARM, and it carries the id back — `NOT_FOUND` alone did not say WHICH
    // annotation was missing, so a refusal naming the wrong one still passed.
    expect(result).toStrictEqual({ kind: "not-found", id: "fake_id" });
  });

  it("rejects reply to a resolved annotation (409 / ANNOTATION_RESOLVED)", () => {
    const ydoc = setupDoc("reply-3", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "test");

    // Resolve the annotation
    const ann = map.get(annId) as Annotation;
    map.set(annId, { ...ann, status: "accepted" });

    const result = addUserReply(ydoc, annId, "too late", noRelay);
    expect(result).toStrictEqual({ kind: "not-pending", currentStatus: "accepted" });
  });

  it("rejects reply to a dismissed annotation", () => {
    const ydoc = setupDoc("reply-4", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "test");

    const ann = map.get(annId) as Annotation;
    map.set(annId, { ...ann, status: "dismissed" });

    const result = createAnnotationLifecycle(ydoc).reply(annId, "too late", noRelay);
    // `dismissed`, not just "some non-pending status" — the accepted case above
    // asserts `accepted`, so together they pin that the arm reports the real
    // status rather than a constant.
    expect(result).toStrictEqual({ kind: "not-pending", currentStatus: "dismissed" });
  });
});

describe("event emission on reply", () => {
  it("tags a user reply BROWSER_ORIGIN, the one origin that is not skipped", () => {
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

    // **Positive, and that is the whole point.** This spec asserted
    // `not.toBe(MCP_ORIGIN)` until Unit 8f, and its comment claimed "no origin,
    // so events should fire with null origin" — stale since the `withBrowser`
    // default landed. A negative assertion passes for EVERY other tag, and four
    // of the five are in `CHANNEL_SKIP`: swap the default to `withInternal` and
    // every user reply silently stops reaching Claude with this file green. It
    // passes for a raw untagged `doc.transact` too, the write Critical Rule 2
    // exists to prevent.
    //
    // `browser` is the only origin outside `CHANNEL_SKIP`, so naming it is the
    // difference between pinning the contract and pinning that something
    // happened.
    addUserReply(ydoc, annId, "user says hi", noRelay);
    expect(events).toHaveLength(1);
    expect(events[0].origin).toBe(BROWSER_ORIGIN);
    expect(shouldSkipChannel(BROWSER_ORIGIN), "browser must stay projectable").toBe(false);
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
    createAnnotationLifecycle(ydoc).reply(annId, "claude says hi", noRelay);
    // The transaction IS tagged with MCP_ORIGIN, so the real event queue would skip it
    expect(mcpEvents).toHaveLength(1);
    expect(mcpEvents[0].origin).toBe(MCP_ORIGIN);
  });
});

describe("WS-A2 Solo-hold marker on replies (AM-F1)", () => {
  it("stamps heldInSolo on a user reply to a COMMENT while in Solo", () => {
    const ydoc = setupDoc("held-reply-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "parent comment");
    setMode("solo");

    const result = addUserReply(ydoc, annId, "held reply", noRelay);
    assertReplyOk(result);

    const stored = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).get(result.replyId) as AnnotationReply & {
      heldInSolo?: boolean;
    };
    expect(stored.heldInSolo).toBe(true);
  });

  it("does NOT stamp heldInSolo on a user reply to a NOTE (private, never sent to Claude)", () => {
    const ydoc = setupDoc("held-reply-2", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "note", rangeOf(0, 5, ydoc), "parent note");
    setMode("solo");

    const result = addUserReply(ydoc, annId, "note reply", noRelay);
    assertReplyOk(result);

    const stored = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).get(result.replyId) as AnnotationReply & {
      heldInSolo?: boolean;
      private?: boolean;
    };
    // A note reply is private forever, so it is never "held from the AI".
    expect(stored.heldInSolo).toBeUndefined();
    expect(stored.private).toBe(true);
  });

  it("does NOT stamp heldInSolo on a comment reply in Tandem mode", () => {
    const ydoc = setupDoc("held-reply-3", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "parent comment");
    setMode("tandem");

    const result = addUserReply(ydoc, annId, "live reply", noRelay);
    assertReplyOk(result);

    const stored = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).get(result.replyId) as AnnotationReply & {
      heldInSolo?: boolean;
    };
    expect(stored.heldInSolo).toBeUndefined();
  });

  it("does NOT stamp heldInSolo on CLAUDE's reply in Solo (the author conjunct)", () => {
    // The other three rows all drive `addUserReply`, so `author === "user"` is
    // unkilled by them: drop that conjunct and every one stays green. What it
    // costs is specific — Claude's own reply gets marked Solo-held, and
    // `hideFromAI` then withholds Claude's message from Claude on the next pull.
    const ydoc = setupDoc("held-reply-claude", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "parent comment");
    setMode("solo");

    const result = createAnnotationLifecycle(ydoc).reply(annId, "claude reply", noRelay);
    assertReplyOk(result);

    const stored = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).get(result.replyId) as AnnotationReply & {
      heldInSolo?: boolean;
    };
    expect(stored.heldInSolo).toBeUndefined();
    // The control that makes the row mean something: the SAME mode and the SAME
    // parent type do stamp a user's reply, so this is the author conjunct and
    // not Solo mode failing to register.
    const userReply = addUserReply(ydoc, annId, "user reply", noRelay);
    assertReplyOk(userReply);
    expect(
      (ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).get(userReply.replyId) as { heldInSolo?: boolean })
        .heldInSolo,
    ).toBe(true);
  });

  // Completes the #1213 fail-closed invariant on the STAMPING side: a server
  // restart can drop the CTRL_ROOM mode key BEFORE the reconnecting client
  // rebroadcasts real mode state, so a reply created in that exact window reads
  // `readModeState() === "indeterminate"`, not `"solo"`. The stamp must still
  // fire — mode.ts#hideFromAI only withholds an indeterminate-mode record when
  // it carries `heldInSolo === true`, so a reply created here without the
  // marker would surface on the very next pull despite the server having no
  // idea whether the user was actually in Solo at the time.
  it("stamps heldInSolo on a user reply to a COMMENT while mode is indeterminate (restart), and hideFromAI withholds it", () => {
    const ydoc = setupDoc("held-reply-4", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "parent comment");
    setMode(undefined); // absent CTRL_ROOM mode key === indeterminate

    const result = addUserReply(ydoc, annId, "mid-restart reply", noRelay);
    assertReplyOk(result);

    const stored = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).get(result.replyId) as AnnotationReply & {
      heldInSolo?: boolean;
    };
    expect(stored.heldInSolo).toBe(true);
    expect(hideFromAI(stored, "indeterminate")).toBe(true);
  });
});

describe("collectRepliesForAnnotation", () => {
  it("collects and sorts replies chronologically", () => {
    const ydoc = setupDoc("collect-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "test");

    addUserReply(ydoc, annId, "first", noRelay);
    createAnnotationLifecycle(ydoc).reply(annId, "second", noRelay);
    addUserReply(ydoc, annId, "third", noRelay);

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
    addUserReply(ydoc, annId, "reply 1", noRelay);
    createAnnotationLifecycle(ydoc).reply(annId, "reply 2", noRelay);

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

    addUserReply(ydoc, annId1, "reply to 1", noRelay);
    addUserReply(ydoc, annId2, "reply to 2", noRelay);

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
