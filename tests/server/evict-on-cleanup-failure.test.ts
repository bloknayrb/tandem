/**
 * Unit 3 / #616 — Evict Y.Doc on populate-cleanup failure.
 *
 * When `populateDocFromContent` catches a populate failure, it runs a targeted
 * cleanup pass. If THAT pass also throws, the cached Y.Doc is in an
 * indeterminate state and `evictPartialDocState` is invoked to clear every
 * CRDT map + the XmlFragment in a single FILE_SYNC_ORIGIN transaction, and
 * to drop the per-doc file-sync context with phase "close" (releasing the
 * tombstone ledger keyed to the prior docHash).
 *
 * Filename note: the upstream plan calls for `.spec.ts`, but vitest's
 * `include` glob matches `.test.ts` only — using the latter so the assertions
 * actually run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

// Notifications are a shared singleton buffer; mock to silence.
vi.mock("../../src/server/notifications.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    pushNotification: vi.fn(),
  };
});

import type { DocStore } from "../../src/server/annotations/store.js";
import {
  getTombstones,
  recordTombstone,
  registerAnnotationObserver,
  resetForTesting as resetSyncForTesting,
  type SyncContext,
} from "../../src/server/annotations/sync.js";
import {
  attachObservers,
  detachObservers,
  resetForTesting as resetQueueForTesting,
  setFileSyncContext,
  subscribe,
  unsubscribe,
} from "../../src/server/events/queue.js";
import { __testEvictPartialDocState } from "../../src/server/mcp/file-opener.js";
import {
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_AWARENESS,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";
import { useTmpAnnotationsEnvWithFlag } from "../helpers/annotation-store-env.js";

useTmpAnnotationsEnvWithFlag("tandem-evict-test-");

const DOC_ID = "evict-test-doc";
const DOC_HASH = "evict-test-hash";

beforeEach(() => {
  resetQueueForTesting();
  resetSyncForTesting();
});

afterEach(() => {
  resetQueueForTesting();
  resetSyncForTesting();
});

/**
 * Build a Y.Doc in the "partial / poisoned" shape that
 * `evictPartialDocState` exists to handle: every CRDT map populated, the
 * XmlFragment populated. Mirrors what an interrupted populate could leave.
 */
function makePoisonedDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    doc.getMap(Y_MAP_ANNOTATIONS).set("ann-1", { id: "ann-1" });
    doc.getMap(Y_MAP_ANNOTATION_REPLIES).set("rep-1", { id: "rep-1" });
    doc.getMap(Y_MAP_AWARENESS).set("aw-1", { focus: "x" });
    doc.getMap(Y_MAP_USER_AWARENESS).set("u-1", { name: "x" });
    const xf = doc.getXmlFragment("default");
    const para = new Y.XmlElement("paragraph");
    para.insert(0, [new Y.XmlText("partial")]);
    xf.insert(0, [para]);
  });
  return doc;
}

describe("evictPartialDocState (#616)", () => {
  it("clears every CRDT map and the XmlFragment", () => {
    const doc = makePoisonedDoc();

    expect(doc.getMap(Y_MAP_ANNOTATIONS).size).toBe(1);
    expect(doc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(1);
    expect(doc.getMap(Y_MAP_AWARENESS).size).toBe(1);
    expect(doc.getMap(Y_MAP_USER_AWARENESS).size).toBe(1);
    expect(doc.getXmlFragment("default").length).toBe(1);

    __testEvictPartialDocState(doc, DOC_ID);

    expect(doc.getMap(Y_MAP_ANNOTATIONS).size).toBe(0);
    expect(doc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(0);
    expect(doc.getMap(Y_MAP_AWARENESS).size).toBe(0);
    expect(doc.getMap(Y_MAP_USER_AWARENESS).size).toBe(0);
    expect(doc.getXmlFragment("default").length).toBe(0);
  });

  it("channel observers see no events during the eviction transaction (FILE_SYNC_ORIGIN)", () => {
    const doc = makePoisonedDoc();
    attachObservers(DOC_ID, doc);

    const received: string[] = [];
    const cb = (ev: { type: string }) => received.push(ev.type);
    subscribe(cb);
    try {
      __testEvictPartialDocState(doc, DOC_ID);
    } finally {
      unsubscribe(cb);
      detachObservers(DOC_ID);
    }

    // Origin tag FILE_SYNC_ORIGIN — both annotation and reply observers skip.
    expect(received).toEqual([]);
  });

  it("drops the per-doc file-sync context with phase 'close' (tombstone ledger empty)", () => {
    const doc = makePoisonedDoc();

    // Minimal DocStore: only `queueWrite` is reachable from this test (and the
    // FILE_SYNC_ORIGIN filter should prevent even that). The other methods are
    // wired to throw if surprised so the test fails loud on unexpected use.
    const queueWrite = vi.fn();
    const store = {
      load: async () => {
        throw new Error("store.load should not be called");
      },
      queueWrite,
      flush: async () => undefined,
      clear: async () => undefined,
      isReadOnly: () => false,
      isDisabled: () => false,
    } satisfies DocStore;

    const ctx: SyncContext = {
      ydoc: doc,
      store,
      docHash: DOC_HASH,
      meta: { filePath: "/tmp/x" },
    };

    // Register the REAL observer. Its close-phase disposer is what drops
    // `tombstonesByDoc[docHash]`; we want to exercise that contract end-to-end,
    // not a comment-only stand-in.
    const cleanup = registerAnnotationObserver(ctx);

    // Seed the ledger AFTER registration so the observer is in place when
    // eviction fires.
    recordTombstone(DOC_HASH, "ann-1", 0);
    expect(getTombstones(DOC_HASH)).toHaveLength(1);

    setFileSyncContext(DOC_ID, ctx, cleanup);

    __testEvictPartialDocState(doc, DOC_ID);

    // Real assertion: the close-phase disposer ran and dropped the ledger.
    expect(getTombstones(DOC_HASH)).toHaveLength(0);

    // The FILE_SYNC_ORIGIN eviction transact must not have queued any
    // user-intent writes back to the store.
    expect(queueWrite).not.toHaveBeenCalled();

    // Second eviction is a no-op against the registry (entry deleted).
    expect(() => __testEvictPartialDocState(doc, DOC_ID)).not.toThrow();
  });

  it("is a no-op against the file-sync registry when docId has no context (open-path case)", () => {
    const doc = makePoisonedDoc();
    // No setFileSyncContext call. wireAnnotationStore runs AFTER populate, so
    // during the normal cleanup-failure path the registry is empty for this id.
    // Eviction must still clear the CRDT state and not throw.
    expect(() => __testEvictPartialDocState(doc, DOC_ID)).not.toThrow();
    expect(doc.getMap(Y_MAP_ANNOTATIONS).size).toBe(0);
  });

  it("a freshly-created Y.Doc against the same documentId is clean post-eviction", () => {
    const doc = makePoisonedDoc();
    __testEvictPartialDocState(doc, DOC_ID);

    // Same id, same doc instance (in-place clear is the contract — we never
    // destroy/recreate). All four CRDT maps + XmlFragment are empty: a
    // subsequent populate from disk lands on the same shape a fresh
    // getOrCreateDocument(id) would have produced.
    expect(doc.getMap(Y_MAP_ANNOTATIONS).size).toBe(0);
    expect(doc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(0);
    expect(doc.getMap(Y_MAP_AWARENESS).size).toBe(0);
    expect(doc.getMap(Y_MAP_USER_AWARENESS).size).toBe(0);
    expect(doc.getXmlFragment("default").length).toBe(0);
  });
});
