import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { captureReplyBaseline } from "../../src/client/hooks/reply-baseline";
import { createThreadAnswerDetector } from "../../src/client/notifications/thread-answer-detector";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants";
import type { AnnotationReply } from "../../src/shared/types";

function answer(id: string, timestamp: number): AnnotationReply {
  return { id, annotationId: "card", author: "claude", text: id, timestamp };
}

describe("captureReplyBaseline (#2360)", () => {
  it("ignores state:false, captures the first true only, and never recaptures on reconnect", () => {
    const ydoc = new Y.Doc();
    ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set("old", answer("old", 1));
    const empty = new Map();
    expect(captureReplyBaseline(ydoc, empty, false, 100)).toBeNull();
    const first = captureReplyBaseline(ydoc, empty, true, 100);
    expect(first?.get(ydoc)).toEqual({ ids: ["old"], capturedAt: 100 });
    // A reconnect re-emits `synced` on the same doc: no recapture, so what
    // arrived meanwhile is still a delta the detector announces.
    ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set("new", answer("new", 150));
    expect(captureReplyBaseline(ydoc, first ?? empty, true, 200)).toBeNull();
  });

  it("an answer inserted after the capture but before the first observe is announced", () => {
    const ydoc = new Y.Doc();
    ydoc.getMap(Y_MAP_ANNOTATIONS).set("card", {
      id: "card",
      author: "user",
      type: "comment",
      audience: "outbound",
    });
    const replies = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    replies.set("history", answer("history", 50));
    const baselines = captureReplyBaseline(ydoc, new Map(), true, 100);
    // The race the synchronous capture exists for: a reply lands before the
    // detector's effect has run once.
    replies.set("live", answer("live", 120));
    const detector = createThreadAnswerDetector();
    const fresh = detector.observe({
      doc: ydoc,
      documentId: "d",
      baseline: baselines?.get(ydoc) ?? null,
      replies: Array.from(replies.values()) as AnnotationReply[],
      parents: new Map([["card", { author: "user", type: "comment", audience: "outbound" }]]),
    });
    expect(fresh.map((a) => a.replyId)).toEqual(["live"]);
  });
});
