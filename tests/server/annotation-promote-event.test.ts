/**
 * AR5 channel-emit test: the note→comment promotion must surface to the channel
 * (Claude) exactly once, and NOTHING else (un-promoted notes, imports, or
 * author-not-flipped writes) may leak.
 *
 * The channel gate (`src/server/events/observers/annotations.ts:54`) keys on
 *   action === "update" && ann.author === "user" && ann.type === "comment" && oldRaw?.type === "note"
 * — on `author` + `type` + the note predecessor, NOT on `audience` (that gates
 * the separate MCP-read surface). These tests pin that predicate in both
 * directions.
 *
 * We perform the promote via the REAL exported `sendNoteToClaude` /
 * `promoteNotesToComments` so the test exercises the actual transform (incl.
 * the import→user author flip) and can't drift from a hand-written shape.
 * Promote writes use `withBrowser` internally; seeds use `withInternal` /
 * `MCP_ORIGIN` (channel-skipped) to mirror production. This is intentionally
 * stronger than the legacy bare-`map.set()` browser-emit pattern in
 * `event-queue.test.ts` — do not "consistency-fix" it back.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  promoteNotesToComments,
  sendNoteToClaude,
} from "../../src/client/panels/annotation-actions.js";
import {
  attachObservers,
  detachObservers,
  resetForTesting,
} from "../../src/server/events/queue.js";
import { withBrowser, withInternal } from "../../src/shared/origins.js";
import { collectEvents } from "../helpers/event-collector.js";
import { getAnnotationsMap, makeImportNote } from "../helpers/ydoc-factory.js";

const importNote = (id: string) => makeImportNote({ id, textSnapshot: "hello" });

describe("AR5 channel emit — note→comment promotion", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
    attachObservers("promote-doc", doc);
  });

  afterEach(() => {
    detachObservers("promote-doc");
    doc.destroy();
    resetForTesting();
  });

  it("emits exactly one annotation:created when an imported note is promoted", () => {
    const map = getAnnotationsMap(doc);
    // Seed via the production import origin — must NOT emit.
    const { events, cleanup } = collectEvents();
    withInternal(doc, () => map.set("imp1", importNote("imp1")));
    expect(events).toHaveLength(0);

    // Promote via the real helper (flips import→user, note→comment, withBrowser).
    sendNoteToClaude(doc, "imp1");

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("annotation:created");
    expect(events[0].payload.annotationId).toBe("imp1");
    expect(events[0].payload.annotationType).toBe("comment");
    cleanup();
  });

  it("fans out one event per note in a batch promote", () => {
    const map = getAnnotationsMap(doc);
    withInternal(doc, () => {
      map.set("imp1", importNote("imp1"));
      map.set("imp2", importNote("imp2"));
    });
    const { events, cleanup } = collectEvents();

    const count = promoteNotesToComments(doc, ["imp1", "imp2"]);
    expect(count).toBe(2);
    const created = events.filter((e) => e.type === "annotation:created");
    expect(created).toHaveLength(2);
    expect(new Set(created.map((e) => e.payload.annotationId))).toEqual(new Set(["imp1", "imp2"]));
    cleanup();
  });
});

describe("AR5 channel privacy — what must NOT emit", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
    attachObservers("priv-doc", doc);
  });

  afterEach(() => {
    detachObservers("priv-doc");
    doc.destroy();
    resetForTesting();
  });

  it("does not emit when a user note is added (browser origin)", () => {
    const { events, cleanup } = collectEvents();
    const map = getAnnotationsMap(doc);
    withBrowser(doc, () =>
      map.set("n1", { ...importNote("n1"), author: "user", importSource: undefined }),
    );
    expect(events).toHaveLength(0);
    cleanup();
  });

  it("does not emit when an import note is added under browser origin (import-author leak guard)", () => {
    const { events, cleanup } = collectEvents();
    const map = getAnnotationsMap(doc);
    withBrowser(doc, () => map.set("imp1", importNote("imp1")));
    expect(events).toHaveLength(0);
    cleanup();
  });

  it("does not emit when an import note is added via the production import origin", () => {
    const { events, cleanup } = collectEvents();
    const map = getAnnotationsMap(doc);
    withInternal(doc, () => map.set("imp1", importNote("imp1")));
    expect(events).toHaveLength(0);
    cleanup();
  });

  it("does not emit when a note→comment update fails to flip author to user", () => {
    // Regression guard: if the promote ever stopped flipping author:"import"→"user",
    // the channel gate's `author === "user"` requirement means it would silently
    // STOP surfacing. Prove that an author-not-flipped update emits nothing.
    const map = getAnnotationsMap(doc);
    withInternal(doc, () => map.set("imp1", importNote("imp1")));
    const { events, cleanup } = collectEvents();
    withBrowser(doc, () =>
      map.set("imp1", {
        ...importNote("imp1"),
        type: "comment",
        author: "import",
        audience: "outbound",
      }),
    );
    expect(events).toHaveLength(0);
    cleanup();
  });

  it("does not emit on a comment→comment update with no editedAt advance (edit-suppression)", () => {
    const map = getAnnotationsMap(doc);
    const comment = {
      id: "c1",
      type: "comment" as const,
      author: "user" as const,
      audience: "outbound" as const,
      range: { from: 0, to: 5 },
      content: "a comment",
      status: "pending" as const,
      textSnapshot: "hello",
      timestamp: 1000,
      editedAt: 2000,
      rev: 2,
    };
    withInternal(doc, () => map.set("c1", comment));
    const { events, cleanup } = collectEvents();
    // oldRaw.type === "comment" (not "note") → promote branch can't fire;
    // editedAt unchanged → edit branch suppressed.
    withBrowser(doc, () => map.set("c1", { ...comment, content: "touched without editedAt bump" }));
    expect(events).toHaveLength(0);
    cleanup();
  });
});
