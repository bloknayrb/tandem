/**
 * Characterization tests for ADR-033 Unit 5 — document-registry ownership of
 * validation, broadcast and the Hocuspocus lifecycle.
 *
 * Every test here pins what the code does **today**, against unmodified
 * production source, so the ownership move can name exactly which behaviour
 * changed rather than asserting that nothing did. Two of them deliberately pin
 * behaviour the unit intends to *fix* (the `startup-file.ts` and
 * `file-opener.ts` asymmetries) — those are expected to be rewritten by the
 * same PR that changes them, and the rewrite is the record of the change.
 *
 * The rest pin behaviour the move must NOT change, and each one exists because
 * a plausible implementation of "the registry owns broadcast" breaks it:
 *
 *   - one broadcast call is `1 + N` transactions, all `internal`-origin. The
 *     registry has no Y.Doc writes at all today, so this is a new origin-tagging
 *     obligation for that module (Critical Rule 2); switching to `withBrowser`
 *     would start emitting channel events for server bookkeeping.
 *   - broadcasting between two primitives publishes an inconsistent snapshot.
 *   - the keep-alive predicate is registered at registry module-import time,
 *     and CTRL_ROOM's retention rides on it.
 *   - Y.Doc **unload** does not clear the file-sync context; only an explicit
 *     close does. Consolidating close-and-broadcast makes unload look like the
 *     natural mirror of swap, and moving `clearFileSyncContext` there would
 *     strand a tombstone ledger.
 *   - the generation token is registered as a live *function*, never a captured
 *     string, so installing the lifecycle before the id is minted still works.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { DocStore } from "../../src/server/annotations/store.js";
import type { SyncContext } from "../../src/server/annotations/sync.js";
import {
  clearFileSyncContext,
  getAllFileSyncContexts,
  reattachFileSyncObserver,
  resetForTesting as resetFileSyncRegistry,
  setFileSyncContext,
} from "../../src/server/events/file-sync-registry.js";
import { attachObservers, detachObservers } from "../../src/server/events/queue.js";
import {
  addDoc,
  broadcastOpenDocs,
  getActiveDocEpoch,
  getActiveDocId,
  getOpenDocs,
  type OpenDoc,
  removeDoc,
  setActiveDocId,
} from "../../src/server/mcp/document-service.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ACTIVE_DOCUMENT_EPOCH,
  Y_MAP_ACTIVE_DOCUMENT_ID,
  Y_MAP_DOCUMENT_META,
  Y_MAP_OPEN_DOCUMENTS,
} from "../../src/shared/constants.js";
import { INTERNAL_ORIGIN } from "../../src/shared/origins.js";

function makeOpenDoc(id: string, filePath = `/tmp/${id}.md`): OpenDoc {
  return { id, filePath, format: "md", readOnly: false, source: "file" };
}

/** Count transactions on a Y.Doc and record each one's origin. */
function watchTransactions(doc: Y.Doc): { count: () => number; origins: () => unknown[] } {
  const origins: unknown[] = [];
  doc.on("afterTransaction", (tr: Y.Transaction) => {
    origins.push(tr.origin);
  });
  return { count: () => origins.length, origins: () => origins };
}

/** Read the documentMeta snapshot a client would observe on a room. */
function readMeta(room: string) {
  const meta = getOrCreateDocument(room).getMap(Y_MAP_DOCUMENT_META);
  return {
    docIds: ((meta.get(Y_MAP_OPEN_DOCUMENTS) as { id: string }[] | undefined) ?? []).map(
      (d) => d.id,
    ),
    activeId: meta.get(Y_MAP_ACTIVE_DOCUMENT_ID) as string | null | undefined,
    epoch: meta.get(Y_MAP_ACTIVE_DOCUMENT_EPOCH) as number | undefined,
  };
}

beforeEach(() => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  resetFileSyncRegistry();
});

describe("broadcast fan-out shape", () => {
  it("writes one transaction per room — CTRL_ROOM plus every open doc", () => {
    addDoc("fan-a", makeOpenDoc("fan-a"));
    addDoc("fan-b", makeOpenDoc("fan-b"));
    setActiveDocId("fan-a");

    // Positive control: the fan-out below is only meaningful if there is more
    // than one room to fan out to. A registry that lost its entries would make
    // every per-room assertion vacuously true.
    expect(getOpenDocs().size, "the fan-out control: two docs must be open").toBe(2);

    const ctrl = watchTransactions(getOrCreateDocument(CTRL_ROOM));
    const a = watchTransactions(getOrCreateDocument("fan-a"));
    const b = watchTransactions(getOrCreateDocument("fan-b"));

    broadcastOpenDocs();

    expect(ctrl.count(), "CTRL_ROOM gets exactly one transaction per broadcast").toBe(1);
    expect(a.count(), "each open doc room gets exactly one transaction per broadcast").toBe(1);
    expect(b.count()).toBe(1);
    expect(
      ctrl.count() + a.count() + b.count(),
      "a broadcast is 1 + N transactions, N = open doc count",
    ).toBe(1 + getOpenDocs().size);
  });

  it("tags every broadcast write with the internal origin, never a browser one", () => {
    addDoc("origin-a", makeOpenDoc("origin-a"));
    setActiveDocId("origin-a");

    const ctrl = watchTransactions(getOrCreateDocument(CTRL_ROOM));
    const room = watchTransactions(getOrCreateDocument("origin-a"));

    broadcastOpenDocs();

    // Critical Rule 2: only `browser` writes generate channel events. The open
    // documents list is server bookkeeping mirrored to clients — emitting it on
    // the channel would push a payload at the AI for every tab operation.
    for (const origin of [...ctrl.origins(), ...room.origins()]) {
      expect(origin, "documentMeta broadcast must carry the internal origin").toBe(INTERNAL_ORIGIN);
    }
    expect(ctrl.origins().length + room.origins().length, "control: writes actually happened").toBe(
      2,
    );
  });

  it("seeds every room in one call from a single epoch read, so rooms never skew", () => {
    addDoc("skew-a", makeOpenDoc("skew-a"));
    addDoc("skew-b", makeOpenDoc("skew-b"));
    setActiveDocId("skew-a");

    broadcastOpenDocs();

    const ctrl = readMeta(CTRL_ROOM);
    expect(readMeta("skew-a").epoch, "per-doc rooms carry CTRL_ROOM's epoch").toBe(ctrl.epoch);
    expect(readMeta("skew-b").epoch).toBe(ctrl.epoch);
    expect(typeof ctrl.epoch, "control: an epoch was actually published").toBe("number");
  });
});

describe("composite-versus-primitive broadcast", () => {
  it("publishes an inconsistent snapshot if a broadcast lands between two primitives", () => {
    addDoc("seq-old", makeOpenDoc("seq-old"));
    setActiveDocId("seq-old");
    broadcastOpenDocs();
    expect(readMeta(CTRL_ROOM).activeId, "control: the old doc starts active").toBe("seq-old");

    // This is the hazard the unit exists to make unrepresentable: `addDoc` then
    // broadcast then `setActiveDocId` publishes the new document listed under
    // the OLD active id. `file-opener.ts` does addDoc -> setActiveDocId ->
    // wireAnnotationStore -> ONE broadcast precisely to avoid this.
    addDoc("seq-new", makeOpenDoc("seq-new"));
    broadcastOpenDocs();

    const intermediate = readMeta(CTRL_ROOM);
    expect(intermediate.docIds, "the new doc is already published…").toContain("seq-new");
    expect(intermediate.activeId, "…while the active id still points at the old one").toBe(
      "seq-old",
    );

    setActiveDocId("seq-new");
    broadcastOpenDocs();
    expect(readMeta(CTRL_ROOM).activeId).toBe("seq-new");
  });

  it("advances the published epoch once per setActiveDocId, including a same-id reselect", () => {
    addDoc("ep-a", makeOpenDoc("ep-a"));
    setActiveDocId("ep-a");
    broadcastOpenDocs();
    const first = readMeta(CTRL_ROOM).epoch as number;

    // A redundant broadcast republishes the same epoch — clients use the epoch,
    // not the write itself, to tell a genuine focus event from a re-broadcast.
    broadcastOpenDocs();
    expect(readMeta(CTRL_ROOM).epoch, "a broadcast alone must not advance the epoch").toBe(first);

    // Re-selecting the already-active doc IS a focus event and does advance it.
    setActiveDocId("ep-a");
    broadcastOpenDocs();
    expect(readMeta(CTRL_ROOM).epoch).toBe(first + 1);
  });
});

describe("the two known asymmetries (pinned before the registry owns broadcast)", () => {
  it("setActiveDocId with no broadcast leaves the published active id stale", () => {
    // `startup-file.ts` sets the active doc after `openFileByPath` has already
    // broadcast, with no broadcast of its own. Module state and published state
    // disagree until some unrelated broadcast happens to fire.
    addDoc("stale-a", makeOpenDoc("stale-a"));
    addDoc("stale-b", makeOpenDoc("stale-b"));
    setActiveDocId("stale-a");
    broadcastOpenDocs();

    setActiveDocId("stale-b");

    expect(getActiveDocId(), "module state moved").toBe("stale-b");
    expect(readMeta(CTRL_ROOM).activeId, "published state did not").toBe("stale-a");
    expect(readMeta(CTRL_ROOM).epoch, "and neither did the published epoch").toBeLessThan(
      getActiveDocEpoch(),
    );
  });

  it("a broadcast with no preceding mutation republishes identical state", () => {
    // `file-opener.ts`'s reload path broadcasts without touching the registry —
    // the content changed, the tab list did not. Pinned so the ownership move
    // can say whether this caller kept its broadcast or lost it.
    addDoc("noop-a", makeOpenDoc("noop-a"));
    setActiveDocId("noop-a");
    broadcastOpenDocs();
    const before = readMeta(CTRL_ROOM);

    const ctrl = watchTransactions(getOrCreateDocument(CTRL_ROOM));
    broadcastOpenDocs();

    expect(ctrl.count(), "the write still happens — it is not deduplicated").toBe(1);
    expect(readMeta(CTRL_ROOM)).toEqual(before);
  });
});

describe("registry module-load registrations", () => {
  it("registers the keep-alive predicate at import time, retaining CTRL_ROOM", async () => {
    vi.resetModules();
    let predicate: ((name: string) => boolean) | null = null;
    vi.doMock("../../src/server/yjs/provider.js", async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        setShouldKeepDocument: (fn: (name: string) => boolean) => {
          predicate = fn;
        },
      };
    });

    const registry = await import("../../src/server/documents/registry.js");

    expect(
      predicate,
      "importing the registry must register the predicate, with no explicit call",
    ).not.toBeNull();
    const keep = predicate as unknown as (name: string) => boolean;

    // CTRL_ROOM holds persistent chat history and is never an OpenDoc — ADR-033
    // rejected modelling it as one, so its retention rides on this predicate
    // alone. An untracked room is the negative control.
    expect(keep(CTRL_ROOM), "CTRL_ROOM is retained even with nothing open").toBe(true);
    expect(keep("never-opened"), "an untracked room is evictable").toBe(false);

    registry.addDoc("keep-me", makeOpenDoc("keep-me"));
    expect(keep("keep-me"), "a tracked doc is retained").toBe(true);
    registry.removeDoc("keep-me");
    expect(keep("keep-me"), "and stops being retained the moment it is untracked").toBe(false);

    vi.doUnmock("../../src/server/yjs/provider.js");
    vi.resetModules();
  });

  it("registers the generation token as a live function, not a captured string", async () => {
    vi.resetModules();
    let source: (() => string | null) | null = null;
    vi.doMock("../../src/server/yjs/provider.js", async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        setGenerationTokenSource: (fn: () => string | null) => {
          source = fn;
        },
      };
    });

    const svc = await import("../../src/server/mcp/document-service.js");
    expect(source, "control: nothing is registered before the first mint").toBeNull();

    svc.writeGenerationId();
    expect(source, "writeGenerationId arms the gate").not.toBeNull();
    const read = source as unknown as () => string | null;
    const first = read();
    expect(typeof first).toBe("string");

    // The load-bearing property: the provider holds a getter, so a later mint is
    // visible through the SAME registered reference. A shape that captured the
    // string — or captured `null` because the lifecycle installed before the
    // first mint — would freeze, and `provider.ts` treats a null expected token
    // as fail-closed: every connection for the whole run rejected, with the same
    // log line as a legitimate stale-tab rejection.
    svc.writeGenerationId();
    expect(read(), "a second mint is visible through the original reference").not.toBe(first);
    expect(source, "and the reference itself was not re-registered by value").toBe(read);

    vi.doUnmock("../../src/server/yjs/provider.js");
    vi.resetModules();
  });
});

describe("Y.Doc swap versus unload", () => {
  function fakeContext(ydoc: Y.Doc, docHash: string): SyncContext {
    return {
      ydoc,
      store: {} as DocStore,
      docHash,
      meta: { filePath: `/tmp/${docHash}.md`, format: "md" } as SyncContext["meta"],
    };
  }

  it("leaves the file-sync context registered after an unload, unlike a close", () => {
    const ydoc = new Y.Doc();
    const cleanups: string[] = [];
    setFileSyncContext("unload-doc", fakeContext(ydoc, "hash-unload"), (phase) => {
      cleanups.push(phase ?? "undefined");
    });
    expect(getAllFileSyncContexts(), "control: the context is registered").toHaveLength(1);

    // Attach the queue observers too, so the `detachObservers` call below has
    // real work to do. Without this, "the context survived the unload" would
    // also be satisfied by an unload that did nothing at all.
    attachObservers("unload-doc", ydoc);

    // This is the whole of what `onDocUnloaded` does — `detachObservers` and
    // nothing else. It never calls `clearFileSyncContext`. That is invisible in
    // production because the keep-alive predicate means a tracked doc never
    // unloads, but it means the unload hook is NOT the mirror of the swap hook,
    // and moving `clearFileSyncContext` into it would strand the tombstone
    // ledger for any doc whose browser tab stays connected.
    detachObservers("unload-doc");

    expect(
      getAllFileSyncContexts(),
      "an unload does not drop the context — only an explicit close does",
    ).toHaveLength(1);
    expect(cleanups, "and it runs no cleanup").toEqual([]);

    const dropped = clearFileSyncContext("unload-doc");
    expect(dropped?.docHash, "an explicit close returns the handle for flushing").toBe(
      "hash-unload",
    );
    expect(cleanups, 'close cleanup runs with the "close" phase, dropping the ledger').toEqual([
      "close",
    ]);
    expect(getAllFileSyncContexts()).toHaveLength(0);
  });

  // NOTE: `reattachFileSyncObserver` is imported statically at the top of this
  // file, not with a dynamic `await import(...)`. The module-load tests above
  // call `vi.resetModules()`, so a dynamic import here resolves to a FRESH
  // module instance with its own empty context map — the rebind would then
  // silently operate on nothing while the statically-imported reader still saw
  // the original entry, and the test would read as a real behavioural finding.
  it("keeps the ledger across a swap by rebinding rather than clearing", () => {
    const first = new Y.Doc();
    const cleanups: string[] = [];
    setFileSyncContext("swap-doc", fakeContext(first, "hash-swap"), (phase) => {
      cleanups.push(phase ?? "undefined");
    });

    const second = new Y.Doc();
    reattachFileSyncObserver("swap-doc", second);

    expect(getAllFileSyncContexts(), "the context survives the swap").toHaveLength(1);
    expect(getAllFileSyncContexts()[0].ydoc, "rebound onto the new Y.Doc instance").toBe(second);
    expect(
      getAllFileSyncContexts()[0].docHash,
      "under the same docHash, so tombstones survive",
    ).toBe("hash-swap");
    expect(cleanups, 'the swap tears the old observer down with the "swap" phase').toEqual([
      "swap",
    ]);
  });
});
