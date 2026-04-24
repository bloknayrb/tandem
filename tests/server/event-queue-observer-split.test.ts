/**
 * Regression tests for the event-queue observer split (Phase 3, #398).
 *
 * Four test groups:
 *   1. ctrl-meta observer — document lifecycle events (document:opened, document:closed,
 *      document:switched) including the lastActiveDocId dedup guard.
 *   2. ctrl-meta observer — MCP_ORIGIN filter (transactions tagged MCP_ORIGIN are ignored).
 *   3. Selection buffer cross-doc isolation — buffering on doc-a does not leak into
 *      a chat:message sent for doc-b; doc-a's buffer survives.
 *   4. setFileSyncContext duplicate registration — re-registering the same docName
 *      disposes the prior observer with phase "close" and activates the new one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  attachCtrlObservers,
  attachObservers,
  detachObservers,
  getBufferedSelection,
  MCP_ORIGIN,
  resetForTesting,
  setFileSyncContext,
  subscribe,
  unsubscribe,
} from "../../src/server/events/queue.js";
import type { TandemEvent } from "../../src/server/events/types.js";
import {
  SELECTION_DWELL_DEFAULT_MS,
  Y_MAP_CHAT,
  Y_MAP_DOCUMENT_META,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";

// ---------------------------------------------------------------------------
// Module-level vi.mock — must be declared at file scope (hoisted by Vitest).
//
// These mocks affect ALL tests in this file.  That's safe here: the only
// code that calls getOrCreateDocument() with the ctrlDoc pattern is
// attachCtrlObservers(), and getOpenDocs() is only used by makeCtrlMetaObserver.
// attachObservers() / reattachObservers() receive a Y.Doc parameter directly.
// ---------------------------------------------------------------------------

let _ctrlTestDoc: Y.Doc = new Y.Doc();

vi.mock("../../src/server/yjs/provider.js", () => ({
  getOrCreateDocument: () => _ctrlTestDoc,
}));

vi.mock("../../src/server/mcp/document-service.js", () => ({
  getOpenDocs: () => new Map(),
}));

// Default: validateRange returns ok so buffered selection offsets pass through.
let _validateRangeResult: { ok: boolean } = { ok: true };
vi.mock("../../src/server/positions.js", () => ({
  validateRange: () => _validateRangeResult,
}));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function collectEvents(): { events: TandemEvent[]; cleanup: () => void } {
  const events: TandemEvent[] = [];
  const cb = (event: TandemEvent) => events.push(event);
  subscribe(cb);
  return { events, cleanup: () => unsubscribe(cb) };
}

afterEach(() => {
  resetForTesting();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Test group 1 — ctrl-meta observer: document lifecycle events
// ---------------------------------------------------------------------------

describe("ctrl-meta observer — document lifecycle events", () => {
  beforeEach(() => {
    _ctrlTestDoc = new Y.Doc();
    attachCtrlObservers();
  });

  afterEach(() => {
    _ctrlTestDoc.destroy();
  });

  it("emits document:opened when a doc appears in openDocuments", () => {
    const { events, cleanup } = collectEvents();

    const metaMap = _ctrlTestDoc.getMap(Y_MAP_DOCUMENT_META);
    metaMap.set("openDocuments", [{ id: "doc-abc", fileName: "notes.md" }]);

    const opened = events.filter((e) => e.type === "document:opened");
    expect(opened).toHaveLength(1);
    expect(opened[0].documentId).toBe("doc-abc");
    expect(opened[0].payload.fileName).toBe("notes.md");

    cleanup();
  });

  it("emits document:closed when a doc is removed from openDocuments", () => {
    const { events, cleanup } = collectEvents();

    const metaMap = _ctrlTestDoc.getMap(Y_MAP_DOCUMENT_META);

    // Open two docs first
    metaMap.set("openDocuments", [
      { id: "doc-1", fileName: "one.md" },
      { id: "doc-2", fileName: "two.md" },
    ]);

    // Remove doc-1
    metaMap.set("openDocuments", [{ id: "doc-2", fileName: "two.md" }]);

    const closed = events.filter((e) => e.type === "document:closed");
    expect(closed).toHaveLength(1);
    expect(closed[0].documentId).toBe("doc-1");

    cleanup();
  });

  it("emits document:switched when activeDocumentId changes", () => {
    const { events, cleanup } = collectEvents();

    const metaMap = _ctrlTestDoc.getMap(Y_MAP_DOCUMENT_META);
    metaMap.set("activeDocumentId", "doc-xyz");

    const switched = events.filter((e) => e.type === "document:switched");
    expect(switched).toHaveLength(1);
    expect(switched[0].documentId).toBe("doc-xyz");

    cleanup();
  });

  it("does NOT emit document:switched again when activeDocumentId is set to the same value (lastActiveDocId dedup guard)", () => {
    const { events, cleanup } = collectEvents();

    const metaMap = _ctrlTestDoc.getMap(Y_MAP_DOCUMENT_META);

    // First set — should emit
    metaMap.set("activeDocumentId", "doc-same");
    expect(events.filter((e) => e.type === "document:switched")).toHaveLength(1);

    // Second set to the same value — guard must suppress the duplicate
    metaMap.set("activeDocumentId", "doc-same");
    expect(events.filter((e) => e.type === "document:switched")).toHaveLength(1);

    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Test group 2 — ctrl-meta observer: MCP_ORIGIN filter
// ---------------------------------------------------------------------------

describe("ctrl-meta observer — MCP_ORIGIN filter", () => {
  beforeEach(() => {
    _ctrlTestDoc = new Y.Doc();
    attachCtrlObservers();
  });

  afterEach(() => {
    _ctrlTestDoc.destroy();
  });

  it("does NOT emit document:switched for transactions tagged with MCP_ORIGIN", () => {
    const { events, cleanup } = collectEvents();

    const metaMap = _ctrlTestDoc.getMap(Y_MAP_DOCUMENT_META);

    _ctrlTestDoc.transact(() => {
      metaMap.set("activeDocumentId", "doc-mcp-filtered");
    }, MCP_ORIGIN);

    expect(events.filter((e) => e.type === "document:switched")).toHaveLength(0);

    cleanup();
  });

  it("does NOT emit document:opened or document:closed for MCP_ORIGIN openDocuments changes", () => {
    const { events, cleanup } = collectEvents();

    const metaMap = _ctrlTestDoc.getMap(Y_MAP_DOCUMENT_META);

    // Open
    _ctrlTestDoc.transact(() => {
      metaMap.set("openDocuments", [{ id: "doc-mcp-open", fileName: "mcp.md" }]);
    }, MCP_ORIGIN);

    // Close
    _ctrlTestDoc.transact(() => {
      metaMap.set("openDocuments", []);
    }, MCP_ORIGIN);

    expect(events.filter((e) => e.type === "document:opened")).toHaveLength(0);
    expect(events.filter((e) => e.type === "document:closed")).toHaveLength(0);

    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Test group 3 — Selection buffer cross-doc isolation
// ---------------------------------------------------------------------------

describe("selection buffer cross-doc isolation", () => {
  let docA: Y.Doc;
  let docB: Y.Doc;

  beforeEach(() => {
    vi.useFakeTimers();
    _ctrlTestDoc = new Y.Doc();
    _validateRangeResult = { ok: true };

    docA = new Y.Doc();
    docB = new Y.Doc();
    attachObservers("doc-a", docA);
    attachObservers("doc-b", docB);
    attachCtrlObservers();
  });

  afterEach(() => {
    detachObservers("doc-a");
    detachObservers("doc-b");
    docA.destroy();
    docB.destroy();
    _ctrlTestDoc.destroy();
  });

  it("chat:message sent for doc-b has no selection field when selection was buffered on doc-a", () => {
    const { events, cleanup } = collectEvents();

    // Buffer a selection on doc-a
    const awarenessA = docA.getMap(Y_MAP_USER_AWARENESS);
    awarenessA.set("selection", { from: 5, to: 20, selectedText: "from doc-a" });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS);

    // Verify the selection was buffered for doc-a
    expect(getBufferedSelection("doc-a")).toBeDefined();

    // Send a chat message referencing doc-b — must NOT pick up doc-a's selection
    const chatMap = _ctrlTestDoc.getMap(Y_MAP_CHAT);
    chatMap.set("msg-cross-doc", {
      id: "msg-cross-doc",
      author: "user",
      text: "Question about doc-b",
      timestamp: Date.now(),
      documentId: "doc-b",
      read: false,
    });

    const chatEvents = events.filter((e) => e.type === "chat:message");
    expect(chatEvents).toHaveLength(1);
    expect(chatEvents[0].payload.selection).toBeUndefined();

    cleanup();
  });

  it("doc-a buffer is still non-null after a cross-doc chat:message on doc-b (proves isolation, not accidental consumption)", () => {
    // Buffer a selection on doc-a
    const awarenessA = docA.getMap(Y_MAP_USER_AWARENESS);
    awarenessA.set("selection", { from: 5, to: 20, selectedText: "from doc-a" });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS);

    // Confirm buffered before chat
    expect(getBufferedSelection("doc-a")).not.toBeNull();

    // Chat for doc-b
    const chatMap = _ctrlTestDoc.getMap(Y_MAP_CHAT);
    chatMap.set("msg-isolation-check", {
      id: "msg-isolation-check",
      author: "user",
      text: "Unrelated question",
      timestamp: Date.now(),
      documentId: "doc-b",
      read: false,
    });

    // doc-a's buffer must be untouched — cross-doc send must not consume it
    expect(getBufferedSelection("doc-a")).toEqual({
      from: 5,
      to: 20,
      selectedText: "from doc-a",
    });
  });
});

// ---------------------------------------------------------------------------
// Test group 4 — setFileSyncContext duplicate registration
// ---------------------------------------------------------------------------

describe("setFileSyncContext — duplicate registration disposes prior observer", () => {
  afterEach(() => {
    _ctrlTestDoc.destroy();
  });

  it("calls the prior observer cleanup with phase 'close' when the same docName is re-registered", async () => {
    const { registerAnnotationObserver } = await import("../../src/server/annotations/sync.js");
    const { clearFileSyncContext } = await import("../../src/server/events/queue.js");

    const docName = "dup-reg-doc";
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    const priorCleanupSpy = vi.fn();

    const stubStore = {
      load: async () => ({
        schemaVersion: 1 as const,
        docHash: "stub-dup",
        meta: { filePath: "/virtual/dup.md", lastUpdated: 0 },
        annotations: [],
        tombstones: [],
        replies: [],
      }),
      queueWrite: vi.fn(),
      flush: async () => {},
      clear: async () => {},
      isReadOnly: () => false,
      isDisabled: () => false,
    };

    // Register first context with a spy as the cleanup function
    setFileSyncContext(
      docName,
      { ydoc: doc1, store: stubStore, docHash: "stub-dup", meta: { filePath: "/virtual/dup.md" } },
      priorCleanupSpy,
    );

    // Register a second context for the same docName — must dispose prior with "close"
    const secondCleanup = registerAnnotationObserver({
      ydoc: doc2,
      store: stubStore,
      docHash: "stub-dup",
      meta: { filePath: "/virtual/dup.md" },
    });
    setFileSyncContext(
      docName,
      { ydoc: doc2, store: stubStore, docHash: "stub-dup", meta: { filePath: "/virtual/dup.md" } },
      secondCleanup,
    );

    // The prior cleanup spy must have been called once with phase "close"
    expect(priorCleanupSpy).toHaveBeenCalledOnce();
    expect(priorCleanupSpy).toHaveBeenCalledWith("close");

    clearFileSyncContext(docName);
    doc1.destroy();
    doc2.destroy();
  });

  it("new observer is active and old observer does not fire after duplicate registration", async () => {
    const { registerAnnotationObserver } = await import("../../src/server/annotations/sync.js");
    const { clearFileSyncContext } = await import("../../src/server/events/queue.js");

    const docName = "dup-reg-active-doc";
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    const oldQueueWriteSpy = vi.fn();
    const newQueueWriteSpy = vi.fn();

    const oldStore = {
      load: async () => ({
        schemaVersion: 1 as const,
        docHash: "hash-old",
        meta: { filePath: "/virtual/old.md", lastUpdated: 0 },
        annotations: [],
        tombstones: [],
        replies: [],
      }),
      queueWrite: oldQueueWriteSpy,
      flush: async () => {},
      clear: async () => {},
      isReadOnly: () => false,
      isDisabled: () => false,
    };

    const newStore = {
      load: async () => ({
        schemaVersion: 1 as const,
        docHash: "hash-new",
        meta: { filePath: "/virtual/new.md", lastUpdated: 0 },
        annotations: [],
        tombstones: [],
        replies: [],
      }),
      queueWrite: newQueueWriteSpy,
      flush: async () => {},
      clear: async () => {},
      isReadOnly: () => false,
      isDisabled: () => false,
    };

    // Register old observer for doc1
    const oldCleanup = registerAnnotationObserver({
      ydoc: doc1,
      store: oldStore,
      docHash: "hash-old",
      meta: { filePath: "/virtual/old.md" },
    });
    setFileSyncContext(
      docName,
      { ydoc: doc1, store: oldStore, docHash: "hash-old", meta: { filePath: "/virtual/old.md" } },
      oldCleanup,
    );

    // Register new observer for doc2 — disposes the old one
    const newCleanup = registerAnnotationObserver({
      ydoc: doc2,
      store: newStore,
      docHash: "hash-new",
      meta: { filePath: "/virtual/new.md" },
    });
    setFileSyncContext(
      docName,
      { ydoc: doc2, store: newStore, docHash: "hash-new", meta: { filePath: "/virtual/new.md" } },
      newCleanup,
    );

    // Writing to the new doc must trigger the new store
    doc2.transact(() => {
      doc2.getMap("annotations").set("ann-new", { id: "ann-new", rev: 1 });
    }, MCP_ORIGIN);
    expect(newQueueWriteSpy).toHaveBeenCalledTimes(1);

    // Writing to the old doc must NOT trigger the old store (observer disposed)
    doc1.transact(() => {
      doc1.getMap("annotations").set("ann-ghost", { id: "ann-ghost", rev: 1 });
    }, MCP_ORIGIN);
    expect(oldQueueWriteSpy).not.toHaveBeenCalled();

    clearFileSyncContext(docName);
    doc1.destroy();
    doc2.destroy();
  });
});
