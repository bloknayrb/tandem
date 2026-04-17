import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  attachCtrlObservers,
  attachObservers,
  detachObservers,
  FILE_SYNC_ORIGIN,
  getBufferedSelection,
  MCP_ORIGIN,
  reattachObservers,
  replaySince,
  resetForTesting,
  subscribe,
  unsubscribe,
  wasEmittedViaChannel,
} from "../../src/server/events/queue.js";
import type { TandemEvent } from "../../src/server/events/types.js";
import {
  CHANNEL_EVENT_BUFFER_SIZE,
  SELECTION_DWELL_DEFAULT_MS,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_CHAT,
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

  it("FILE_SYNC_ORIGIN-tagged annotation writes do not emit events", () => {
    const { events, cleanup } = collectEvents();
    const map = doc.getMap(Y_MAP_ANNOTATIONS);

    // Simulates the annotation file-writer replaying persisted JSON into the Y.Map.
    // These writes MUST NOT fan out as channel events, otherwise every disk reload
    // would spam annotation:created/accepted/dismissed SSE events to subscribers.
    doc.transact(() => {
      map.set("ann_file_sync_new", {
        id: "ann_file_sync_new",
        type: "comment",
        author: "user",
        content: "reloaded from disk",
        status: "pending",
        textSnapshot: "hello",
        range: { from: 0, to: 5 },
      });
    }, FILE_SYNC_ORIGIN);

    // Also simulate a status-change replay (claude annotation being updated)
    doc.transact(() => {
      map.set("ann_file_sync_accept", {
        id: "ann_file_sync_accept",
        type: "comment",
        author: "claude",
        content: "prior suggestion",
        status: "accepted",
        textSnapshot: "hello",
        range: { from: 0, to: 5 },
      });
    }, FILE_SYNC_ORIGIN);

    expect(events).toHaveLength(0);
    cleanup();
  });

  it("FILE_SYNC_ORIGIN-tagged reply writes do not emit events", () => {
    const { events, cleanup } = collectEvents();
    const annMap = doc.getMap(Y_MAP_ANNOTATIONS);
    const repliesMap = doc.getMap(Y_MAP_ANNOTATION_REPLIES);

    // Seed a parent annotation via MCP so its write is not observable as an event
    doc.transact(() => {
      annMap.set("ann_parent", {
        id: "ann_parent",
        type: "comment",
        author: "claude",
        content: "parent",
        status: "pending",
        textSnapshot: "hello",
        range: { from: 0, to: 5 },
      });
    }, MCP_ORIGIN);

    // File-sync replay of a user reply — must NOT emit annotation:reply
    doc.transact(() => {
      repliesMap.set("reply_file_sync", {
        id: "reply_file_sync",
        annotationId: "ann_parent",
        author: "user",
        text: "reloaded reply",
        timestamp: Date.now(),
      });
    }, FILE_SYNC_ORIGIN);

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
        type: "comment",
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
      type: "comment",
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
        type: "comment",
        author: "claude",
        content: "try this",
        status: "pending",
        textSnapshot: "original",
        range: { from: 0, to: 5 },
      });
    }, MCP_ORIGIN);

    map.set("ann_d", {
      id: "ann_d",
      type: "comment",
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
    const { events, cleanup } = collectEvents();
    const doc = new Y.Doc();
    attachObservers("cap-doc", doc);
    const map = doc.getMap(Y_MAP_ANNOTATIONS);

    const total = CHANNEL_EVENT_BUFFER_SIZE + 50;
    for (let i = 0; i < total; i++) {
      map.set(`ann_cap_${i}`, {
        id: `ann_cap_${i}`,
        type: "comment",
        author: "user",
        content: `cap ${i}`,
        status: "pending",
        textSnapshot: `text ${i}`,
        range: { from: 0, to: 5 },
      });
    }

    // All events were delivered to the subscriber
    expect(events).toHaveLength(total);

    // But replaySince (which reads from the capped buffer) should be at most CHANNEL_EVENT_BUFFER_SIZE
    const replayed = replaySince("nonexistent");
    expect(replayed.length).toBeLessThanOrEqual(CHANNEL_EVENT_BUFFER_SIZE);

    detachObservers("cap-doc");
    doc.destroy();
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
      type: "comment",
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

// --- Selection buffering (#188) ---

describe("selection buffering", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    vi.useFakeTimers();
    doc = new Y.Doc();
    attachObservers("sel-doc", doc);
  });

  afterEach(() => {
    detachObservers("sel-doc");
    doc.destroy();
    vi.useRealTimers();
  });

  it("does not buffer cursor-only selections (from === to)", () => {
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);
    awareness.set("selection", { from: 42, to: 42, timestamp: Date.now() });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS * 2);

    expect(getBufferedSelection("sel-doc")).toBeUndefined();
  });

  it("buffers real text selections after dwell (no event emitted)", () => {
    const { events, cleanup } = collectEvents();
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

    awareness.set("selection", {
      from: 10,
      to: 50,
      selectedText: "some selected text",
      timestamp: Date.now(),
    });

    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS);

    // No selection:changed event emitted
    expect(events).toHaveLength(0);
    // But selection is buffered
    expect(getBufferedSelection("sel-doc")).toEqual({
      from: 10,
      to: 50,
      selectedText: "some selected text",
    });
    cleanup();
  });

  it("buffers with empty selectedText when field is missing", () => {
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);
    awareness.set("selection", { from: 10, to: 50, timestamp: Date.now() });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS);

    expect(getBufferedSelection("sel-doc")).toEqual({
      from: 10,
      to: 50,
      selectedText: "",
    });
  });

  it("does not buffer for MCP-origin selection writes", () => {
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

    doc.transact(() => {
      awareness.set("selection", {
        from: 10,
        to: 50,
        selectedText: "test",
        timestamp: Date.now(),
      });
    }, MCP_ORIGIN);

    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS * 2);
    expect(getBufferedSelection("sel-doc")).toBeUndefined();
  });

  it("clears buffer when selection is cleared (from === to)", () => {
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);

    // Buffer a selection
    awareness.set("selection", { from: 5, to: 20, selectedText: "hello" });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS);
    expect(getBufferedSelection("sel-doc")).toBeDefined();

    // Clear selection
    awareness.set("selection", { from: 3, to: 3 });
    expect(getBufferedSelection("sel-doc")).toBeUndefined();
  });
});

// --- reattachObservers (doc swap on Hocuspocus onLoadDocument) ---

describe("reattachObservers", () => {
  it("stops emitting events from the old doc and starts emitting from the new one", () => {
    const { events, cleanup } = collectEvents();

    const oldDoc = new Y.Doc();
    attachObservers("swap-doc", oldDoc);

    // Write to old doc — should emit
    const oldMap = oldDoc.getMap(Y_MAP_ANNOTATIONS);
    oldMap.set("ann_old", {
      id: "ann_old",
      type: "comment",
      author: "user",
      content: "from old doc",
      status: "pending",
      textSnapshot: "old text",
      range: { from: 0, to: 5 },
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("annotation:created");

    // Simulate Hocuspocus doc swap: reattach to a new doc
    const newDoc = new Y.Doc();
    reattachObservers("swap-doc", newDoc);

    // Write to old doc — should NOT emit (observers detached)
    oldMap.set("ann_old_2", {
      id: "ann_old_2",
      type: "comment",
      author: "user",
      content: "stale write",
      status: "pending",
      textSnapshot: "stale",
      range: { from: 0, to: 5 },
    });
    expect(events).toHaveLength(1); // Still 1 — old doc write was ignored

    // Write to new doc — should emit
    const newMap = newDoc.getMap(Y_MAP_ANNOTATIONS);
    newMap.set("ann_new", {
      id: "ann_new",
      type: "comment",
      author: "user",
      content: "from new doc",
      status: "pending",
      textSnapshot: "new text",
      range: { from: 0, to: 5 },
    });
    expect(events).toHaveLength(2);
    expect(events[1].payload.annotationId).toBe("ann_new");

    detachObservers("swap-doc");
    oldDoc.destroy();
    newDoc.destroy();
    cleanup();
  });

  it("preserves the documentId in events emitted from the new doc", () => {
    const { events, cleanup } = collectEvents();

    const doc1 = new Y.Doc();
    attachObservers("my-room", doc1);

    const doc2 = new Y.Doc();
    reattachObservers("my-room", doc2);

    const map = doc2.getMap(Y_MAP_ANNOTATIONS);
    map.set("ann_room", {
      id: "ann_room",
      type: "comment",
      author: "user",
      content: "room test",
      status: "pending",
      textSnapshot: "room",
      range: { from: 0, to: 5 },
    });

    expect(events).toHaveLength(1);
    expect(events[0].documentId).toBe("my-room");

    detachObservers("my-room");
    doc1.destroy();
    doc2.destroy();
    cleanup();
  });

  it("still filters MCP_ORIGIN writes after swap", () => {
    const { events, cleanup } = collectEvents();
    const doc1 = new Y.Doc();
    attachObservers("origin-swap-doc", doc1);

    const doc2 = new Y.Doc();
    reattachObservers("origin-swap-doc", doc2);

    // MCP-origin write to new doc should be filtered
    const map = doc2.getMap(Y_MAP_ANNOTATIONS);
    doc2.transact(() => {
      map.set("ann_mcp", {
        id: "ann_mcp",
        type: "comment",
        author: "claude",
        content: "echo",
        status: "pending",
        textSnapshot: "echo text",
        range: { from: 0, to: 5 },
      });
    }, MCP_ORIGIN);

    expect(events).toHaveLength(0);

    detachObservers("origin-swap-doc");
    doc1.destroy();
    doc2.destroy();
    cleanup();
  });

  it("is idempotent — reattaching to the same doc twice does not duplicate events", () => {
    const { events, cleanup } = collectEvents();

    const doc = new Y.Doc();
    attachObservers("idempotent-doc", doc);
    reattachObservers("idempotent-doc", doc);
    reattachObservers("idempotent-doc", doc);

    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    map.set("ann_idem", {
      id: "ann_idem",
      type: "comment",
      author: "user",
      content: "once only",
      status: "pending",
      textSnapshot: "idem",
      range: { from: 0, to: 5 },
    });

    expect(events).toHaveLength(1);

    detachObservers("idempotent-doc");
    doc.destroy();
    cleanup();
  });
});

// --- detachObservers edge cases ---

describe("detachObservers edge cases", () => {
  it("detachObservers on a never-attached doc does not throw", () => {
    expect(() => detachObservers("never-attached-doc")).not.toThrow();
  });
});

// --- File-sync context registry (durable annotations) ---
//
// reattachObservers re-registers the annotation file-writer observer against
// the new Y.Doc after a Hocuspocus doc swap. If this branch regresses,
// disk persistence silently stops on every first-browser-connect — the
// plan's #1 silent-failure mode. Guard it with a test that proves a
// post-swap Y.Map write reaches the store via the re-registered observer.

describe("reattachObservers — file-sync context rebind", () => {
  it("rebinds the annotation observer to the new Y.Doc on swap", async () => {
    const { setFileSyncContext, clearFileSyncContext } = await import(
      "../../src/server/events/queue.js"
    );
    const { MCP_ORIGIN: mcpOrigin } = await import("../../src/server/events/queue.js");

    const docName = "reattach-filesync-doc";
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    // Minimal DocStore stub — we only care about queueWrite being called.
    const queueWriteSpy = vi.fn();
    const store = {
      load: async () => ({
        schemaVersion: 1 as const,
        docHash: "stub",
        meta: { filePath: "/virtual/doc.md", lastUpdated: 0 },
        annotations: [],
        tombstones: [],
        replies: [],
      }),
      queueWrite: queueWriteSpy,
      flush: async () => {},
      clear: async () => {},
      isReadOnly: () => false,
      isDisabled: () => false,
    };

    // Imitate what file-opener.ts:wireAnnotationStore does — register a
    // real observer via the sync module and stash the context.
    const { registerAnnotationObserver } = await import("../../src/server/annotations/sync.js");
    const cleanup = registerAnnotationObserver({
      ydoc: doc1,
      store,
      docHash: "stub",
      meta: { filePath: "/virtual/doc.md" },
    });
    setFileSyncContext(
      docName,
      { ydoc: doc1, store, docHash: "stub", meta: { filePath: "/virtual/doc.md" } },
      cleanup,
    );

    // Simulate a Hocuspocus onLoadDocument swap.
    reattachObservers(docName, doc2);

    // Writing to the NEW doc must fire the re-registered observer → store.queueWrite.
    doc2.transact(() => {
      doc2.getMap(Y_MAP_ANNOTATIONS).set("ann_1", { id: "ann_1", rev: 1 });
    }, mcpOrigin);

    expect(queueWriteSpy).toHaveBeenCalledTimes(1);

    // And the OLD doc must no longer trigger writes — the old observer
    // should have been disposed before the rebind.
    queueWriteSpy.mockClear();
    doc1.transact(() => {
      doc1.getMap(Y_MAP_ANNOTATIONS).set("ann_ghost", { id: "ann_ghost", rev: 1 });
    }, mcpOrigin);
    expect(queueWriteSpy).not.toHaveBeenCalled();

    clearFileSyncContext(docName);
    doc1.destroy();
    doc2.destroy();
  });

  it("reattachObservers on a doc with no file-sync context is a no-op", () => {
    const doc = new Y.Doc();
    expect(() => reattachObservers("never-wired-doc", doc)).not.toThrow();
    doc.destroy();
  });

  // #333: A pending debounced write can still be queued against the store when
  // a Y.Doc swap happens. If the observer cleanup deletes the per-doc
  // tombstone ledger on swap, the pending snapshot thunk — invoked at flush
  // time — would persist `tombstones: []` and silently drop a real deletion.
  // The cleanup must skip tombstone wipe on `"swap"` and only drop the ledger
  // on `"close"`.
  it("preserves tombstones across a Y.Doc swap (#333)", async () => {
    const { setFileSyncContext, clearFileSyncContext } = await import(
      "../../src/server/events/queue.js"
    );
    const { recordTombstone, registerAnnotationObserver, getTombstones } = await import(
      "../../src/server/annotations/sync.js"
    );

    const docName = "tombstone-swap-doc";
    const docHash = "tombstone-hash";
    const filePath = "/virtual/tombstone.md";
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    // Capture the snapshot thunk so we can invoke it at "flush" time, mirroring
    // what the real debounced store does at debounce-fire.
    let pendingThunk: (() => unknown) | null = null;
    const store = {
      load: async () => ({
        schemaVersion: 1 as const,
        docHash,
        meta: { filePath, lastUpdated: 0 },
        annotations: [],
        tombstones: [],
        replies: [],
      }),
      queueWrite: (thunk: () => unknown) => {
        pendingThunk = thunk;
      },
      flush: async () => {},
      clear: async () => {},
      isReadOnly: () => false,
      isDisabled: () => false,
    };

    const cleanup = registerAnnotationObserver({
      ydoc: doc1,
      store,
      docHash,
      meta: { filePath },
    });
    setFileSyncContext(docName, { ydoc: doc1, store, docHash, meta: { filePath } }, cleanup);

    // Record a tombstone, then trigger a user-intent mutation so the observer
    // queues a snapshot thunk against the store.
    recordTombstone(docHash, "ann_deleted", 0);
    doc1.transact(() => {
      doc1.getMap(Y_MAP_ANNOTATIONS).set("ann_trigger", { id: "ann_trigger", rev: 1 });
    }, MCP_ORIGIN);

    expect(pendingThunk).not.toBeNull();

    // Simulate the Hocuspocus onLoadDocument swap. The prior cleanup runs with
    // phase=swap; the pending thunk is still sitting in the store.
    reattachObservers(docName, doc2);

    // Flush: invoke the still-pending snapshot thunk that was queued against
    // the OLD doc. It must see the tombstone — both on the serialized
    // snapshot (what lands on disk) AND in the in-memory ledger.
    const snapshot = pendingThunk as unknown as () => { tombstones: Array<{ id: string }> };
    const persisted = snapshot();

    expect(persisted.tombstones.map((t) => t.id)).toEqual(["ann_deleted"]);
    expect(getTombstones(docHash).map((t) => t.id)).toEqual(["ann_deleted"]);

    clearFileSyncContext(docName);
    doc1.destroy();
    doc2.destroy();
  });
});

// --- attachCtrlObservers (CTRL_ROOM chat observer) ---
// attachCtrlObservers calls getOrCreateDocument(CTRL_ROOM) internally.
// We mock the provider module at the top level (vi.mock is hoisted) and use
// a module-scoped variable that beforeEach can reassign before each test.

let _ctrlTestDoc: Y.Doc = new Y.Doc();

// NOTE: vi.mock() is hoisted to file scope by Vitest. These mocks affect ALL tests
// in this file. This is currently safe because only attachCtrlObservers() calls
// getOrCreateDocument() -- attachObservers/reattachObservers take a Y.Doc parameter
// directly and are unaffected. If that changes, move CTRL_ROOM tests to a separate file.
vi.mock("../../src/server/yjs/provider.js", () => ({
  getOrCreateDocument: () => _ctrlTestDoc,
}));

vi.mock("../../src/server/mcp/document-service.js", () => ({
  getOpenDocs: () => new Map(),
}));

// Mock validateRange so we can control whether buffered selection offsets are kept or dropped.
// Default: return { ok: true } so offsets pass through.
let _validateRangeResult: { ok: boolean } = { ok: true };
vi.mock("../../src/server/positions.js", () => ({
  validateRange: () => _validateRangeResult,
}));

describe("attachCtrlObservers (CTRL_ROOM)", () => {
  beforeEach(() => {
    _ctrlTestDoc = new Y.Doc();
  });

  afterEach(() => {
    _ctrlTestDoc.destroy();
  });

  it("emits chat:message for user-authored chat messages", () => {
    const { events, cleanup } = collectEvents();

    attachCtrlObservers();

    const chatMap = _ctrlTestDoc.getMap(Y_MAP_CHAT);
    chatMap.set("msg_1", {
      id: "msg_1",
      author: "user",
      text: "Hello from the user",
      timestamp: Date.now(),
      documentId: "some-doc",
      read: false,
    });

    const chatEvents = events.filter((e) => e.type === "chat:message");
    expect(chatEvents).toHaveLength(1);
    expect(chatEvents[0].payload.text).toBe("Hello from the user");
    expect(chatEvents[0].payload.messageId).toBe("msg_1");

    cleanup();
  });

  it("ignores MCP-origin chat writes", () => {
    const { events, cleanup } = collectEvents();

    attachCtrlObservers();

    const chatMap = _ctrlTestDoc.getMap(Y_MAP_CHAT);
    _ctrlTestDoc.transact(() => {
      chatMap.set("msg_mcp", {
        id: "msg_mcp",
        author: "claude",
        text: "Claude reply",
        timestamp: Date.now(),
        documentId: "some-doc",
        read: false,
      });
    }, MCP_ORIGIN);

    expect(events.filter((e) => e.type === "chat:message")).toHaveLength(0);

    cleanup();
  });

  it("ignores non-user-authored chat messages", () => {
    const { events, cleanup } = collectEvents();

    attachCtrlObservers();

    const chatMap = _ctrlTestDoc.getMap(Y_MAP_CHAT);
    chatMap.set("msg_claude", {
      id: "msg_claude",
      author: "claude",
      text: "Claude speaking",
      timestamp: Date.now(),
      documentId: "some-doc",
      read: false,
    });

    expect(events.filter((e) => e.type === "chat:message")).toHaveLength(0);

    cleanup();
  });
});

// --- Chat attaches buffered selection (#188 integration) ---

describe("chat attaches buffered selection", () => {
  let selDoc: Y.Doc;

  beforeEach(() => {
    vi.useFakeTimers();
    _ctrlTestDoc = new Y.Doc();
    selDoc = new Y.Doc();
    _validateRangeResult = { ok: true };
    attachObservers("sel-chat-doc", selDoc);
    attachCtrlObservers();
  });

  afterEach(() => {
    detachObservers("sel-chat-doc");
    selDoc.destroy();
    _ctrlTestDoc.destroy();
    vi.useRealTimers();
  });

  it("attaches buffered selection with offsets to chat:message when range is valid", () => {
    const { events, cleanup } = collectEvents();

    // Buffer a selection on the document
    const awareness = selDoc.getMap(Y_MAP_USER_AWARENESS);
    awareness.set("selection", { from: 10, to: 50, selectedText: "selected text" });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS);

    // Verify selection is buffered
    expect(getBufferedSelection("sel-chat-doc")).toBeDefined();

    // Send a chat message referencing the same document
    const chatMap = _ctrlTestDoc.getMap(Y_MAP_CHAT);
    chatMap.set("msg_sel_1", {
      id: "msg_sel_1",
      author: "user",
      text: "What about this passage?",
      timestamp: Date.now(),
      documentId: "sel-chat-doc",
      read: false,
    });

    const chatEvents = events.filter((e) => e.type === "chat:message");
    expect(chatEvents).toHaveLength(1);
    expect(chatEvents[0].payload.selection).toEqual({
      from: 10,
      to: 50,
      selectedText: "selected text",
    });

    cleanup();
  });

  it("consumes the buffer: second chat message has no selection", () => {
    const { events, cleanup } = collectEvents();

    // Buffer a selection
    const awareness = selDoc.getMap(Y_MAP_USER_AWARENESS);
    awareness.set("selection", { from: 10, to: 50, selectedText: "selected text" });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS);

    const chatMap = _ctrlTestDoc.getMap(Y_MAP_CHAT);

    // First chat consumes the buffer
    chatMap.set("msg_consume_1", {
      id: "msg_consume_1",
      author: "user",
      text: "First message",
      timestamp: Date.now(),
      documentId: "sel-chat-doc",
      read: false,
    });

    // Second chat — buffer is gone
    chatMap.set("msg_consume_2", {
      id: "msg_consume_2",
      author: "user",
      text: "Second message",
      timestamp: Date.now(),
      documentId: "sel-chat-doc",
      read: false,
    });

    const chatEvents = events.filter((e) => e.type === "chat:message");
    expect(chatEvents).toHaveLength(2);
    expect(chatEvents[0].payload.selection).toBeDefined();
    expect(chatEvents[1].payload.selection).toBeUndefined();

    // Buffer is empty
    expect(getBufferedSelection("sel-chat-doc")).toBeUndefined();

    cleanup();
  });

  it("chat message with no buffered selection has no selection field", () => {
    const { events, cleanup } = collectEvents();

    // No selection buffered — send chat directly
    const chatMap = _ctrlTestDoc.getMap(Y_MAP_CHAT);
    chatMap.set("msg_no_sel", {
      id: "msg_no_sel",
      author: "user",
      text: "Just a question",
      timestamp: Date.now(),
      documentId: "sel-chat-doc",
      read: false,
    });

    const chatEvents = events.filter((e) => e.type === "chat:message");
    expect(chatEvents).toHaveLength(1);
    expect(chatEvents[0].payload.selection).toBeUndefined();

    cleanup();
  });

  it("falls back to text-only selection when validateRange fails", () => {
    const { events, cleanup } = collectEvents();
    _validateRangeResult = { ok: false };

    // Buffer a selection
    const awareness = selDoc.getMap(Y_MAP_USER_AWARENESS);
    awareness.set("selection", { from: 10, to: 50, selectedText: "stale text" });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS);

    const chatMap = _ctrlTestDoc.getMap(Y_MAP_CHAT);
    chatMap.set("msg_stale", {
      id: "msg_stale",
      author: "user",
      text: "What about this?",
      timestamp: Date.now(),
      documentId: "sel-chat-doc",
      read: false,
    });

    const chatEvents = events.filter((e) => e.type === "chat:message");
    expect(chatEvents).toHaveLength(1);
    // Should have text but no offsets
    expect(chatEvents[0].payload.selection).toEqual({ selectedText: "stale text" });

    cleanup();
  });
});
