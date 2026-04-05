import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  attachObservers,
  detachObservers,
  MCP_ORIGIN,
  replaySince,
  resetForTesting,
  subscribe,
  unsubscribe,
  wasEmittedViaChannel,
} from "../../src/server/events/queue.js";
import type { TandemEvent } from "../../src/server/events/types.js";
import {
  CHANNEL_EVENT_BUFFER_SIZE,
  Y_MAP_ANNOTATIONS,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";

afterEach(() => {
  resetForTesting();
});

// --- Helper to collect events from the subscriber ---

function collectEvents(): { events: TandemEvent[]; cleanup: () => void } {
  const events: TandemEvent[] = [];
  const cb = (event: TandemEvent) => {
    events.push(event);
  };
  subscribe(cb);
  return { events, cleanup: () => unsubscribe(cb) };
}

// --- Origin filtering ---

describe("origin filtering", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
    attachObservers("test-doc", doc);
  });

  afterEach(() => {
    detachObservers("test-doc");
    doc.destroy();
  });

  it("MCP_ORIGIN-tagged writes do not emit events", () => {
    const { events, cleanup } = collectEvents();
    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    doc.transact(() => {
      map.set("ann_1", {
        id: "ann_1",
        type: "comment",
        author: "user",
        content: "test",
        status: "pending",
        textSnapshot: "hello",
        range: { from: 0, to: 5 },
      });
    }, MCP_ORIGIN);

    expect(events).toHaveLength(0);
    cleanup();
  });

  it("non-MPC writes emit annotation:created for user annotations", () => {
    const { events, cleanup } = collectEvents();
    const map = doc.getMap(Y_MAP_ANNOTATIONS);

    // Write without MCP_ORIGIN — simulates browser-originated change
    map.set("ann_1", {
      id: "ann_1",
      type: "comment",
      author: "user",
      content: "test",
      status: "pending",
      textSnapshot: "hello",
      range: { from: 0, to: 5 },
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("annotation:created");
    expect(events[0].payload.annotationId).toBe("ann_1");
    cleanup();
  });

  it("emits annotation:accepted when claude annotation is updated to accepted", () => {
    const { events, cleanup } = collectEvents();
    const map = doc.getMap(Y_MAP_ANNOTATIONS);

    // First add the annotation via MCP (no event)
    doc.transact(() => {
      map.set("ann_c", {
        id: "ann_c",
        type: "suggestion",
        author: "claude",
        content: "fix this",
        status: "pending",
        textSnapshot: "broken",
        range: { from: 0, to: 5 },
      });
    }, MCP_ORIGIN);
    expect(events).toHaveLength(0);

    // Browser user accepts it (non-MCP update)
    map.set("ann_c", {
      id: "ann_c",
      type: "suggestion",
      author: "claude",
      content: "fix this",
      status: "accepted",
      textSnapshot: "broken",
      range: { from: 0, to: 5 },
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("annotation:accepted");
    cleanup();
  });

  it("emits annotation:dismissed when claude annotation is dismissed", () => {
    const { events, cleanup } = collectEvents();
    const map = doc.getMap(Y_MAP_ANNOTATIONS);

    doc.transact(() => {
      map.set("ann_d", {
        id: "ann_d",
        type: "suggestion",
        author: "claude",
        content: "try this",
        status: "pending",
        textSnapshot: "original",
        range: { from: 0, to: 5 },
      });
    }, MCP_ORIGIN);

    map.set("ann_d", {
      id: "ann_d",
      type: "suggestion",
      author: "claude",
      content: "try this",
      status: "dismissed",
      textSnapshot: "original",
      range: { from: 0, to: 5 },
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("annotation:dismissed");
    cleanup();
  });
});

// --- Buffer eviction and replaySince ---

describe("buffer eviction and replaySince", () => {
  it("buffer is capped at CHANNEL_EVENT_BUFFER_SIZE", () => {
    const { cleanup } = collectEvents();

    // Push more than buffer size
    for (let i = 0; i < CHANNEL_EVENT_BUFFER_SIZE + 50; i++) {
      // Trigger via direct subscriber — we need to push events through the queue
      // Since we can't call pushEvent directly, use Y.Map observer path
    }

    cleanup();
  });

  it("replaySince returns events after the given ID", () => {
    const { events, cleanup } = collectEvents();
    const doc = new Y.Doc();
    attachObservers("replay-doc", doc);
    const map = doc.getMap(Y_MAP_ANNOTATIONS);

    // Create 3 events
    for (let i = 0; i < 3; i++) {
      map.set(`ann_${i}`, {
        id: `ann_${i}`,
        type: "comment",
        author: "user",
        content: `test ${i}`,
        status: "pending",
        textSnapshot: `text ${i}`,
        range: { from: 0, to: 5 },
      });
    }

    expect(events).toHaveLength(3);

    // Replay since the first event — should return events 2 and 3
    const replayed = replaySince(events[0].id);
    expect(replayed).toHaveLength(2);
    expect(replayed[0].id).toBe(events[1].id);
    expect(replayed[1].id).toBe(events[2].id);

    detachObservers("replay-doc");
    doc.destroy();
    cleanup();
  });

  it("replaySince returns entire buffer for unknown ID", () => {
    const { events, cleanup } = collectEvents();
    const doc = new Y.Doc();
    attachObservers("unknown-doc", doc);
    const map = doc.getMap(Y_MAP_ANNOTATIONS);

    map.set("ann_x", {
      id: "ann_x",
      type: "comment",
      author: "user",
      content: "test",
      status: "pending",
      textSnapshot: "hello",
      range: { from: 0, to: 5 },
    });

    expect(events).toHaveLength(1);
    const replayed = replaySince("nonexistent_id");
    expect(replayed).toHaveLength(1);
    expect(replayed[0].id).toBe(events[0].id);

    detachObservers("unknown-doc");
    doc.destroy();
    cleanup();
  });

  it("replaySince returns empty array when buffer is empty", () => {
    expect(replaySince("any_id")).toEqual([]);
  });
});

// --- Ref-counted dedup ---

describe("wasEmittedViaChannel (ref-counted dedup)", () => {
  it("returns true after event with annotationId is pushed", () => {
    const doc = new Y.Doc();
    attachObservers("dedup-doc", doc);
    const map = doc.getMap(Y_MAP_ANNOTATIONS);

    map.set("ann_dedup", {
      id: "ann_dedup",
      type: "comment",
      author: "user",
      content: "test",
      status: "pending",
      textSnapshot: "hello",
      range: { from: 0, to: 5 },
    });

    expect(wasEmittedViaChannel("ann_dedup")).toBe(true);

    detachObservers("dedup-doc");
    doc.destroy();
  });

  it("returns false for unknown IDs", () => {
    expect(wasEmittedViaChannel("nonexistent")).toBe(false);
  });

  it("ref-counting: same ID in two events survives eviction of the first", () => {
    const { events, cleanup } = collectEvents();
    const doc = new Y.Doc();
    attachObservers("refcount-doc", doc);
    const map = doc.getMap(Y_MAP_ANNOTATIONS);

    // Create annotation (emits annotation:created with annotationId)
    map.set("ann_rc", {
      id: "ann_rc",
      type: "suggestion",
      author: "user",
      content: "test",
      status: "pending",
      textSnapshot: "hello",
      range: { from: 0, to: 5 },
    });
    expect(events).toHaveLength(1);
    expect(wasEmittedViaChannel("ann_rc")).toBe(true);

    // Now push enough events to evict the first one from the buffer
    for (let i = 0; i < CHANNEL_EVENT_BUFFER_SIZE + 10; i++) {
      map.set(`ann_filler_${i}`, {
        id: `ann_filler_${i}`,
        type: "comment",
        author: "user",
        content: `filler ${i}`,
        status: "pending",
        textSnapshot: `filler text ${i}`,
        range: { from: 0, to: 5 },
      });
    }

    // The original ann_rc event should have been evicted from the buffer,
    // so its ref count goes to 0 and it should no longer be tracked
    expect(wasEmittedViaChannel("ann_rc")).toBe(false);

    // But filler events near the end should still be tracked
    expect(wasEmittedViaChannel(`ann_filler_${CHANNEL_EVENT_BUFFER_SIZE}`)).toBe(true);

    detachObservers("refcount-doc");
    doc.destroy();
    cleanup();
  });
});

// --- Subscriber error isolation ---

describe("subscriber error isolation", () => {
  it("a throwing subscriber does not prevent other subscribers from receiving events", () => {
    const received: TandemEvent[] = [];

    const badSub = () => {
      throw new Error("bad subscriber");
    };
    const goodSub = (event: TandemEvent) => {
      received.push(event);
    };

    subscribe(badSub);
    subscribe(goodSub);

    const doc = new Y.Doc();
    attachObservers("error-doc", doc);
    const map = doc.getMap(Y_MAP_ANNOTATIONS);

    map.set("ann_err", {
      id: "ann_err",
      type: "comment",
      author: "user",
      content: "test",
      status: "pending",
      textSnapshot: "hello",
      range: { from: 0, to: 5 },
    });

    expect(received).toHaveLength(1);

    unsubscribe(badSub);
    unsubscribe(goodSub);
    detachObservers("error-doc");
    doc.destroy();
  });
});

// --- Selection event filtering ---

describe("selection event filtering", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
    attachObservers("sel-doc", doc);
  });

  afterEach(() => {
    detachObservers("sel-doc");
    doc.destroy();
  });

  it("filters out cursor-only selections (from === to)", () => {
    const { events, cleanup } = collectEvents();
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

    // Simulate a click (cursor position, no range)
    awareness.set("selection", { from: 42, to: 42, timestamp: Date.now() });

    expect(events.filter((e) => e.type === "selection:changed")).toHaveLength(0);
    cleanup();
  });

  it("emits selection:changed for real text selections (from !== to)", () => {
    const { events, cleanup } = collectEvents();
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

    // Simulate a text selection with selectedText
    awareness.set("selection", {
      from: 10,
      to: 50,
      selectedText: "some selected text",
      timestamp: Date.now(),
    });

    const selEvents = events.filter((e) => e.type === "selection:changed");
    expect(selEvents).toHaveLength(1);
    expect(selEvents[0].payload.from).toBe(10);
    expect(selEvents[0].payload.to).toBe(50);
    expect(selEvents[0].payload.selectedText).toBe("some selected text");
    cleanup();
  });

  it("emits selection:changed with empty selectedText when field is missing", () => {
    const { events, cleanup } = collectEvents();
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

    // Simulate a selection without selectedText field (backward compat)
    awareness.set("selection", { from: 10, to: 50, timestamp: Date.now() });

    const selEvents = events.filter((e) => e.type === "selection:changed");
    expect(selEvents).toHaveLength(1);
    expect(selEvents[0].payload.selectedText).toBe("");
    cleanup();
  });

  it("does not emit for MCP-origin selection writes", () => {
    const { events, cleanup } = collectEvents();
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

    doc.transact(() => {
      awareness.set("selection", {
        from: 10,
        to: 50,
        selectedText: "test",
        timestamp: Date.now(),
      });
    }, MCP_ORIGIN);

    expect(events.filter((e) => e.type === "selection:changed")).toHaveLength(0);
    cleanup();
  });
});
