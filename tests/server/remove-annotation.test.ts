import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docHash } from "../../src/server/annotations/doc-hash.js";
import {
  addUserReply,
  createAnnotationLifecycle,
  removeAnnotationRecord,
} from "../../src/server/annotations/lifecycle.js";
import {
  createStore,
  resetForTesting as resetStoreForTesting,
} from "../../src/server/annotations/store.js";
import {
  getTombstones,
  registerAnnotationObserver,
  resetForTesting,
} from "../../src/server/annotations/sync.js";
import { createAnnotation } from "../../src/server/mcp/annotations.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { useTmpAnnotationsEnvWithFlag } from "../helpers/annotation-store-env.js";
import { clearOpenDocs, setupDoc } from "../helpers/doc-service.js";
import { unanchored } from "../helpers/positions.js";

useTmpAnnotationsEnvWithFlag("tandem-remove-annotation-test-");

const observerCleanups: Array<() => void> = [];

/** Mirror the production wiring: register the sync observer so the tombstone
 * ledger is updated automatically on Y.Map deletes (see #695). */
function bindObserver(ydoc: ReturnType<typeof setupDoc>, filePath: string) {
  const hash = docHash(filePath);
  const store = createStore(hash, { filePath });
  const cleanup = registerAnnotationObserver({
    ydoc,
    store,
    docHash: hash,
    meta: { filePath },
  });
  observerCleanups.push(cleanup);
}

beforeEach(() => {
  clearOpenDocs();
  resetForTesting();
  resetStoreForTesting();
});

afterEach(() => {
  while (observerCleanups.length) observerCleanups.pop()?.();
});

describe("removeAnnotationRecord", () => {
  it("deletes annotation from map and records tombstone", () => {
    const ydoc = setupDoc("rm-fn-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const filePath = "/tmp/rm-fn-1.md";
    bindObserver(ydoc, filePath);
    const id = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "test note");

    // No wrapper argument: the BROWSER default. That is the case worth pinning
    // for the tombstone, because Unit 8e moved the browser's Archive off `mcp`
    // and the ledger's indifference to origin is what makes that safe —
    // `sync.ts` records from the Y.Map delete event, before its `DURABLE_SKIP`
    // check. #700 moved it there in the first place because browser-origin
    // deletes and stale-tab CRDT merges bypassed the old explicit call, which
    // is also what retired this function's `filePath` parameter.
    const result = removeAnnotationRecord(ydoc, id);

    expect(result).toStrictEqual({ kind: "ok", id });
    expect(map.has(id)).toBe(false);

    const tombstones = getTombstones(docHash(filePath));
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].id).toBe(id);
  });

  it("cleans up orphaned replies", () => {
    const ydoc = setupDoc("rm-fn-2", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "noted");

    addUserReply(ydoc, id, "reply 1", () => {});
    createAnnotationLifecycle(ydoc).reply(id, "reply 2", () => {});

    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    expect(repliesMap.size).toBe(2);

    removeAnnotationRecord(ydoc, id);

    expect(repliesMap.size).toBe(0);
  });

  it("returns NOT_FOUND for non-existent annotation", () => {
    const ydoc = setupDoc("rm-fn-3", "Hello world");

    const result = removeAnnotationRecord(ydoc, "fake_id");

    expect(result).toStrictEqual({ kind: "not-found", id: "fake_id" });
  });

  it("does not delete replies belonging to other annotations", () => {
    const ydoc = setupDoc("rm-fn-4", "Hello world test");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id1 = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "first");
    const id2 = createAnnotation(map, ydoc, "comment", unanchored(6, 11), "second");

    addUserReply(ydoc, id1, "reply to first", () => {});
    addUserReply(ydoc, id2, "reply to second", () => {});

    const repliesMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    expect(repliesMap.size).toBe(2);

    removeAnnotationRecord(ydoc, id1);

    expect(repliesMap.size).toBe(1);
    let remainingAnnotationId: string | undefined;
    repliesMap.forEach((v) => {
      remainingAnnotationId = (v as { annotationId: string }).annotationId;
    });
    expect(remainingAnnotationId).toBe(id2);
  });
});
