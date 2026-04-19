/**
 * Tests for the annotation sync module: observer registration, tombstones,
 * and the initial load+merge pass.
 *
 * Uses real Y.Doc instances (no Hocuspocus) and a real `DocStore` backed by a
 * per-test tempdir via `TANDEM_APP_DATA_DIR`.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

// Notifications are a shared singleton buffer; mock to silence.
vi.mock("../../../src/server/notifications.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    pushNotification: vi.fn(),
  };
});

import {
  type AnnotationDocV1,
  type AnnotationRecordV1,
  type AnnotationReplyRecordV1,
  migrateToV1,
  parseAnnotationDoc,
  SCHEMA_VERSION,
} from "../../../src/server/annotations/schema.js";
import type { DocStore } from "../../../src/server/annotations/store.js";
import {
  createStore,
  resetForTesting as resetStoreForTesting,
} from "../../../src/server/annotations/store.js";
import {
  getTombstones,
  loadAndMerge,
  recordTombstone,
  registerAnnotationObserver,
  resetForTesting,
  type SyncContext,
} from "../../../src/server/annotations/sync.js";
import { FILE_SYNC_ORIGIN, MCP_ORIGIN } from "../../../src/server/events/queue.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../../src/shared/constants.js";

const HASH_A = "a".repeat(64);
const FILE_A = "/virtual/doc-a.md";

function annRecord(overrides: Partial<AnnotationRecordV1> = {}): AnnotationRecordV1 {
  return {
    id: "ann_1",
    author: "claude",
    type: "comment",
    range: { from: 0, to: 5 },
    content: "hello",
    status: "pending",
    timestamp: 1_700_000_000_000,
    rev: 0,
    ...overrides,
  };
}

function replyRecord(overrides: Partial<AnnotationReplyRecordV1> = {}): AnnotationReplyRecordV1 {
  return {
    id: "rep_1",
    annotationId: "ann_1",
    author: "user",
    text: "ack",
    timestamp: 1_700_000_000_000,
    rev: 0,
    ...overrides,
  };
}

function makeFile(
  docHash: string,
  filePath: string,
  overrides: Partial<AnnotationDocV1> = {},
): AnnotationDocV1 {
  const { doc } = migrateToV1({});
  doc.docHash = docHash;
  doc.meta = { filePath, lastUpdated: Date.now() };
  return { ...doc, ...overrides };
}

function syncCtx(ydoc: Y.Doc, store: DocStore, overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    ydoc,
    store,
    docHash: HASH_A,
    meta: { filePath: FILE_A },
    ...overrides,
  };
}

let tmpRoot: string;
let prevAppDataDir: string | undefined;
let prevFeatureFlag: string | undefined;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-sync-test-"));
  prevAppDataDir = process.env.TANDEM_APP_DATA_DIR;
  prevFeatureFlag = process.env.TANDEM_ANNOTATION_STORE;
  process.env.TANDEM_APP_DATA_DIR = tmpRoot;
  delete process.env.TANDEM_ANNOTATION_STORE;
  resetForTesting();
  resetStoreForTesting();
});

afterEach(async () => {
  resetForTesting();
  resetStoreForTesting();
  if (prevAppDataDir === undefined) delete process.env.TANDEM_APP_DATA_DIR;
  else process.env.TANDEM_APP_DATA_DIR = prevAppDataDir;
  if (prevFeatureFlag === undefined) delete process.env.TANDEM_ANNOTATION_STORE;
  else process.env.TANDEM_ANNOTATION_STORE = prevFeatureFlag;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Observer behaviour
// ---------------------------------------------------------------------------

describe("registerAnnotationObserver", () => {
  it("#1 writes on MCP_ORIGIN mutation", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    ydoc.transact(() => annMap.set("ann_1", annRecord({ id: "ann_1" })), MCP_ORIGIN);

    await store.flush();

    const raw = await fs.readFile(path.join(tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.schemaVersion).toBe(SCHEMA_VERSION);
    expect(onDisk.annotations).toHaveLength(1);
    expect(onDisk.annotations[0].id).toBe("ann_1");

    cleanup();
  });

  it("#2 writes on browser-origin (null origin) mutation", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    // No origin tag ⇒ browser-origin
    annMap.set("ann_1", annRecord({ id: "ann_1" }));

    await store.flush();

    const raw = await fs.readFile(path.join(tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.annotations).toHaveLength(1);
    cleanup();
  });

  it("#3 skips FILE_SYNC_ORIGIN mutations (no write queued)", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const queueSpy = vi.spyOn(store, "queueWrite");
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    ydoc.transact(() => annMap.set("ann_1", annRecord({ id: "ann_1" })), FILE_SYNC_ORIGIN);

    await store.flush();

    expect(queueSpy).not.toHaveBeenCalled();
    // No file created.
    await expect(
      fs.access(path.join(tmpRoot, "annotations", `${HASH_A}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    cleanup();
  });

  it("#4 does NOT bump rev (preserves the caller-set rev)", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    ydoc.transact(() => annMap.set("ann_1", annRecord({ id: "ann_1", rev: 3 })), MCP_ORIGIN);

    await store.flush();

    const raw = await fs.readFile(path.join(tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.annotations[0].rev).toBe(3);
    cleanup();
  });

  it("#5 serializes a missing rev as rev:0 (pre-plan migration)", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    // Intentionally write a raw object without `rev` — simulating a
    // session-restored pre-plan annotation.
    const legacy = { ...annRecord({ id: "ann_1" }) } as Partial<AnnotationRecordV1>;
    delete legacy.rev;
    ydoc.transact(() => annMap.set("ann_1", legacy), MCP_ORIGIN);

    await store.flush();

    const raw = await fs.readFile(path.join(tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.annotations).toHaveLength(1);
    expect(onDisk.annotations[0].rev).toBe(0);
    cleanup();
  });

  it("lazy snapshot: 5 rapid mutations produce 1 serialization (snapshot thunk runs once)", async () => {
    // Verifies the thunk-based queueWrite path: the observer hands a thunk,
    // not a pre-computed doc. Only the final debounce-fire triggers a
    // snapshot, so N mutations within the debounce window produce ONE
    // serialization regardless of N.
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const queueSpy = vi.spyOn(store, "queueWrite");
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    ydoc.transact(() => {
      for (let i = 0; i < 5; i++) {
        annMap.set(`ann_${i}`, annRecord({ id: `ann_${i}` }));
      }
    }, MCP_ORIGIN);

    // One transaction, one observer fire, one queueWrite call.
    expect(queueSpy).toHaveBeenCalledTimes(1);

    // Thunks passed are functions, not pre-materialized docs.
    const thunk = queueSpy.mock.calls[0]?.[0];
    expect(typeof thunk).toBe("function");

    // Counting how many times the thunk is invoked is what actually proves
    // laziness: run flush, then verify we get exactly one snapshot.
    let invokeCount = 0;
    queueSpy.mockClear();
    // Queue several more mutations — still one queued-write call, one thunk
    // invocation when flushed.
    for (let i = 5; i < 10; i++) {
      ydoc.transact(() => annMap.set(`ann_${i}`, annRecord({ id: `ann_${i}` })), MCP_ORIGIN);
    }
    const lastThunk = queueSpy.mock.calls.at(-1)?.[0] as (() => unknown) | undefined;
    expect(typeof lastThunk).toBe("function");
    if (lastThunk) {
      // Calling the thunk manually is safe; it's just a snapshot read.
      lastThunk();
      invokeCount += 1;
    }
    expect(invokeCount).toBe(1);

    await store.flush();
    cleanup();
  });

  it("cleanup unobserves both Y.Maps (further mutations don't write)", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));
    cleanup();

    const queueSpy = vi.spyOn(store, "queueWrite");
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    ydoc.transact(() => annMap.set("ann_1", annRecord({ id: "ann_1" })), MCP_ORIGIN);

    await store.flush();
    expect(queueSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Legacy-type sanitize-on-write
// ---------------------------------------------------------------------------

describe("legacy-type sanitize on write", () => {
  it("rewrites a non-canonical type to 'comment' so the envelope stays loadable", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    // The legacy-type branch emits `console.error`; silence for this assertion.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    // A pre-canonicalization record — `AnnotationTypeSchema` no longer accepts
    // "suggestion", so without sanitize-on-write this envelope would Zod-reject
    // on the next load and end up quarantined to `.json.future`.
    const legacy = {
      ...annRecord({ id: "ann_legacy" }),
      type: "suggestion",
      suggestedText: "canonical form",
      content: "a rationale string, not JSON",
    };
    ydoc.transact(() => annMap.set("ann_legacy", legacy), MCP_ORIGIN);

    await store.flush();

    const raw = await fs.readFile(path.join(tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.annotations).toHaveLength(1);
    expect(onDisk.annotations[0].type).toBe("comment");

    // The critical invariant: the envelope we just wrote must round-trip
    // cleanly through the v1 parser. If this assertion ever regresses, the
    // durable store will self-quarantine on the next open.
    const parsed = parseAnnotationDoc(raw);
    expect(parsed.ok).toBe(true);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    cleanup();
    errorSpy.mockRestore();
  });

  it("dedupes the upgrade warning to once per docHash per session", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    ydoc.transact(() => {
      annMap.set("a1", { ...annRecord({ id: "a1" }), type: "suggestion" });
      annMap.set("a2", { ...annRecord({ id: "a2" }), type: "question" });
    }, MCP_ORIGIN);
    await store.flush();

    // Two legacy records, one docHash → exactly one warning.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    cleanup();
    errorSpy.mockRestore();
  });

  it("close-phase cleanup lets the next open log once again", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const cleanup1 = registerAnnotationObserver(syncCtx(ydoc, store));
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    ydoc.transact(
      () => annMap.set("a1", { ...annRecord({ id: "a1" }), type: "suggestion" }),
      MCP_ORIGIN,
    );
    await store.flush();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    cleanup1("close");

    // Fresh observer for the same docHash — dedupe state should have been
    // cleared so a further legacy record emits a new warning.
    const cleanup2 = registerAnnotationObserver(syncCtx(ydoc, store));
    ydoc.transact(
      () => annMap.set("a2", { ...annRecord({ id: "a2" }), type: "question" }),
      MCP_ORIGIN,
    );
    await store.flush();
    expect(errorSpy).toHaveBeenCalledTimes(2);

    cleanup2("close");
    errorSpy.mockRestore();
  });

  it("swap-phase cleanup preserves dedupe so a Y.Doc swap doesn't spam", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const cleanup1 = registerAnnotationObserver(syncCtx(ydoc, store));
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    ydoc.transact(
      () => annMap.set("a1", { ...annRecord({ id: "a1" }), type: "suggestion" }),
      MCP_ORIGIN,
    );
    await store.flush();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    cleanup1("swap");

    const cleanup2 = registerAnnotationObserver(syncCtx(ydoc, store));
    ydoc.transact(
      () => annMap.set("a2", { ...annRecord({ id: "a2" }), type: "question" }),
      MCP_ORIGIN,
    );
    await store.flush();
    // Same docHash, swap semantics → no additional warning.
    expect(errorSpy).toHaveBeenCalledTimes(1);

    cleanup2("close");
    errorSpy.mockRestore();
  });

  it("loadAndMerge logs legacy-type upgrade when Y.Map has a non-canonical type that beats the file", async () => {
    // Seed the Y.Map with a legacy-typed annotation at rev:2 (as session-restore
    // would leave it). The Y.Map wins the merge — no file-side overwrite — so
    // normalizeAnnotation runs against this Y.Map value at the file-vs-ymap
    // comparison site (sync.ts ~line 438).
    const ydoc = new Y.Doc();
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    annMap.set("ann_legacy_merge", {
      ...annRecord({ id: "ann_legacy_merge", rev: 2 }),
      type: "suggestion",
    });

    // Pre-write a file with a CANONICAL-typed record at rev:1 so the file
    // parses cleanly (type:"suggestion" in the file body would Zod-reject as
    // corrupt and route through the quarantine path, bypassing the merge loop).
    // Y.Map rev:2 > file rev:1, so Y.Map wins and the legacy-typed Y.Map entry
    // is the input to normalizeAnnotation at line ~438.
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeFile(HASH_A, FILE_A, {
        annotations: [annRecord({ id: "ann_legacy_merge", rev: 1 })],
      }),
    );
    await store0.flush();
    resetStoreForTesting();

    const store = createStore(HASH_A, { filePath: FILE_A });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    // Without the docHash fix, normalizeAnnotation is called without docHash
    // and the guard `if (!isCanonical && docHash && ...)` short-circuits → 0.
    // With the fix, docHash is passed and the log fires → 1.
    expect(errorSpy).toHaveBeenCalledTimes(1);

    cleanup();
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// loadAndMerge
// ---------------------------------------------------------------------------

describe("loadAndMerge", () => {
  it("#6 fresh file + fresh Y.Map → no write, observer registered", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const queueSpy = vi.spyOn(store, "queueWrite");

    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    // No annotations in either side → nothing to write.
    expect(queueSpy).not.toHaveBeenCalled();

    // Observer should still be wired — subsequent MCP mutation triggers a write.
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    ydoc.transact(() => annMap.set("ann_1", annRecord({ id: "ann_1" })), MCP_ORIGIN);
    expect(queueSpy).toHaveBeenCalled();

    cleanup();
  });

  it("#7 empty file + Y.Map has annotations → writes one snapshot (first-upgrade)", async () => {
    // Seed the Y.Doc *before* loadAndMerge, as the session-restore step would.
    const ydoc = new Y.Doc();
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const legacy = { ...annRecord({ id: "ann_legacy" }) } as Partial<AnnotationRecordV1>;
    delete legacy.rev; // Pre-plan: no rev on the in-memory annotation.
    annMap.set("ann_legacy", legacy);

    const store = createStore(HASH_A, { filePath: FILE_A });
    const queueSpy = vi.spyOn(store, "queueWrite");

    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    // Exactly one queued write for the first-upgrade snapshot.
    expect(queueSpy).toHaveBeenCalledTimes(1);
    await store.flush();

    const raw = await fs.readFile(path.join(tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.annotations).toHaveLength(1);
    expect(onDisk.annotations[0].id).toBe("ann_legacy");
    expect(onDisk.annotations[0].rev).toBe(0);

    cleanup();
  });

  it("#8 file has annotations + Y.Map empty → Y.Map populated from file", async () => {
    // Pre-write a file with one annotation.
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeFile(HASH_A, FILE_A, { annotations: [annRecord({ id: "ann_disk", rev: 5 })] }),
    );
    await store0.flush();
    resetStoreForTesting();

    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const loaded = annMap.get("ann_disk") as AnnotationRecordV1 | undefined;
    expect(loaded).toBeDefined();
    expect(loaded?.rev).toBe(5);
    cleanup();
  });

  it("#9 merge: file rev > Y.Map rev → file wins", async () => {
    // File has rev 5.
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeFile(HASH_A, FILE_A, {
        annotations: [annRecord({ id: "ann_1", rev: 5, content: "from-disk" })],
      }),
    );
    await store0.flush();
    resetStoreForTesting();

    // Y.Map has rev 2 (stale).
    const ydoc = new Y.Doc();
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    annMap.set("ann_1", annRecord({ id: "ann_1", rev: 2, content: "from-ymap" }));

    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    const winner = annMap.get("ann_1") as AnnotationRecordV1;
    expect(winner.rev).toBe(5);
    expect(winner.content).toBe("from-disk");
    cleanup();
  });

  it("#10 merge: Y.Map rev > file rev → Y.Map wins (unchanged)", async () => {
    // File has rev 1.
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeFile(HASH_A, FILE_A, {
        annotations: [annRecord({ id: "ann_1", rev: 1, content: "from-disk" })],
      }),
    );
    await store0.flush();
    resetStoreForTesting();

    // Y.Map has rev 4 (newer).
    const ydoc = new Y.Doc();
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    annMap.set("ann_1", annRecord({ id: "ann_1", rev: 4, content: "from-ymap" }));

    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    const winner = annMap.get("ann_1") as AnnotationRecordV1;
    expect(winner.rev).toBe(4);
    expect(winner.content).toBe("from-ymap");
    cleanup();
  });

  it("#11 merge: rev tie, file has editedAt, Y.Map doesn't → file wins", async () => {
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeFile(HASH_A, FILE_A, {
        annotations: [annRecord({ id: "ann_1", rev: 2, content: "from-disk", editedAt: 111 })],
      }),
    );
    await store0.flush();
    resetStoreForTesting();

    const ydoc = new Y.Doc();
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const ymapAnn = { ...annRecord({ id: "ann_1", rev: 2, content: "from-ymap" }) };
    // Ensure editedAt undefined, as session-restore would leave it.
    annMap.set("ann_1", ymapAnn);

    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    const winner = annMap.get("ann_1") as AnnotationRecordV1;
    expect(winner.content).toBe("from-disk");
    expect(winner.editedAt).toBe(111);
    cleanup();
  });

  it("#12 merge: rev tie, both have editedAt, higher editedAt wins", async () => {
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeFile(HASH_A, FILE_A, {
        annotations: [annRecord({ id: "ann_1", rev: 2, content: "from-disk", editedAt: 100 })],
      }),
    );
    await store0.flush();
    resetStoreForTesting();

    const ydoc = new Y.Doc();
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    annMap.set("ann_1", annRecord({ id: "ann_1", rev: 2, content: "from-ymap", editedAt: 200 }));

    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    const winner = annMap.get("ann_1") as AnnotationRecordV1;
    expect(winner.content).toBe("from-ymap");
    expect(winner.editedAt).toBe(200);
    cleanup();
  });

  it("#13 merge: tombstone rev > Y.Map rev → annotation deleted from Y.Map", async () => {
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeFile(HASH_A, FILE_A, {
        annotations: [],
        tombstones: [{ id: "ann_1", rev: 5, deletedAt: 9999 }],
      }),
    );
    await store0.flush();
    resetStoreForTesting();

    const ydoc = new Y.Doc();
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    annMap.set("ann_1", annRecord({ id: "ann_1", rev: 3 }));

    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    expect(annMap.get("ann_1")).toBeUndefined();

    // Tombstones should be available via accessor.
    expect(getTombstones(HASH_A)).toEqual([{ id: "ann_1", rev: 5, deletedAt: 9999 }]);
    cleanup();
  });

  it("#14 merge: tombstone rev < Y.Map rev → Y.Map annotation preserved (resurrection)", async () => {
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeFile(HASH_A, FILE_A, {
        annotations: [],
        tombstones: [{ id: "ann_1", rev: 2, deletedAt: 1 }],
      }),
    );
    await store0.flush();
    resetStoreForTesting();

    const ydoc = new Y.Doc();
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    annMap.set("ann_1", annRecord({ id: "ann_1", rev: 7, content: "reborn" }));

    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    const survivor = annMap.get("ann_1") as AnnotationRecordV1 | undefined;
    expect(survivor).toBeDefined();
    expect(survivor?.rev).toBe(7);
    expect(survivor?.content).toBe("reborn");
    cleanup();
  });

  it("#15 merge: alive in Y.Map, absent from file, not tombstoned → kept + queueWrite fires", async () => {
    // File exists but empty.
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() => makeFile(HASH_A, FILE_A, { annotations: [], replies: [] }));
    await store0.flush();
    resetStoreForTesting();

    const ydoc = new Y.Doc();
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    annMap.set("ann_new", annRecord({ id: "ann_new", rev: 0 }));

    const store = createStore(HASH_A, { filePath: FILE_A });
    const queueSpy = vi.spyOn(store, "queueWrite");
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    // Preserved in Y.Map.
    expect(annMap.get("ann_new")).toBeDefined();
    // Post-merge flush should fire queueWrite.
    expect(queueSpy).toHaveBeenCalled();

    await store.flush();
    const raw = await fs.readFile(path.join(tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.annotations).toHaveLength(1);
    expect(onDisk.annotations[0].id).toBe("ann_new");

    cleanup();
  });

  it("#18 merge: file has alive ann AND winning tombstone for same id, Y.Map empty → insert suppressed", async () => {
    // Contradiction: file carries an alive record for "ann_1" (rev 2) and a
    // tombstone for "ann_1" (rev 5). Tombstone wins (5 > 2) so the alive
    // record must NOT be inserted. Exercises shouldSkipInsert /
    // winningTombstoneIds — the only mergeMap path never hit by the existing
    // suite (prior tombstone tests all use annotations: []).
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeFile(HASH_A, FILE_A, {
        annotations: [annRecord({ id: "ann_1", rev: 2 })],
        tombstones: [{ id: "ann_1", rev: 5, deletedAt: 9999 }],
      }),
    );
    await store0.flush();
    resetStoreForTesting();

    const ydoc = new Y.Doc();
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);

    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    expect(annMap.get("ann_1")).toBeUndefined();
    expect(getTombstones(HASH_A)).toEqual([{ id: "ann_1", rev: 5, deletedAt: 9999 }]);
    cleanup();
  });

  it("#18b merge: file has alive ann AND tombstone at equal rev → insert proceeds (strict-> contract)", async () => {
    // Boundary: stone.rev === fileAnn.rev (both 5). The veto is strict
    // greater-than, so equal rev must NOT suppress the insert. Guards against
    // someone changing > to >=.
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeFile(HASH_A, FILE_A, {
        annotations: [annRecord({ id: "ann_1", rev: 5 })],
        tombstones: [{ id: "ann_1", rev: 5, deletedAt: 9999 }],
      }),
    );
    await store0.flush();
    resetStoreForTesting();

    const ydoc = new Y.Doc();
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);

    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    const inserted = annMap.get("ann_1") as AnnotationRecordV1 | undefined;
    expect(inserted).toBeDefined();
    expect(inserted?.rev).toBe(5);
    cleanup();
  });

  it("#19 merge: tombstone loses to Y.Map (resurrection) — no spurious queueWrite", async () => {
    // Tombstone rev=2 loses to Y.Map rev=7. "ann_1" is in Y.Map but NOT in
    // the file's alive list. Without ymapOnlyIgnoreIds, the "Y.Map keys
    // absent from file" pass would see it and set needsWrite → spurious write.
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeFile(HASH_A, FILE_A, {
        annotations: [],
        tombstones: [{ id: "ann_1", rev: 2, deletedAt: 1 }],
      }),
    );
    await store0.flush();
    resetStoreForTesting();

    const ydoc = new Y.Doc();
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    annMap.set("ann_1", annRecord({ id: "ann_1", rev: 7, content: "reborn" }));

    const store = createStore(HASH_A, { filePath: FILE_A });
    const queueSpy = vi.spyOn(store, "queueWrite");
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    const survivor = annMap.get("ann_1") as AnnotationRecordV1 | undefined;
    expect(survivor).toBeDefined();
    expect(survivor?.rev).toBe(7);
    expect(queueSpy).not.toHaveBeenCalled();
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Tombstones
// ---------------------------------------------------------------------------

describe("recordTombstone + getTombstones", () => {
  it("#16a appends tombstone at prevRev+1 (pure state mutation, no write queued)", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const queueSpy = vi.spyOn(store, "queueWrite");
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const before = Date.now();
    recordTombstone(HASH_A, "ann_dead", 3);
    const after = Date.now();

    const stones = getTombstones(HASH_A);
    expect(stones).toHaveLength(1);
    expect(stones[0].id).toBe("ann_dead");
    expect(stones[0].rev).toBe(4);
    expect(stones[0].deletedAt).toBeGreaterThanOrEqual(before);
    expect(stones[0].deletedAt).toBeLessThanOrEqual(after);

    // recordTombstone on its own does NOT queue a write — the caller is
    // expected to follow with a Y.Map.delete, which the observer will pick up.
    expect(queueSpy).not.toHaveBeenCalled();

    cleanup();
  });

  it("#16b recordTombstone + paired Y.Map.delete produces a durable write including the tombstone", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    // Seed the Y.Map with an entry the caller is about to delete.
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    annMap.set("ann_dead", annRecord({ id: "ann_dead", rev: 3 }));

    // Caller order: record tombstone THEN delete from Y.Map (wrapped in an
    // MCP-origin transaction so the observer fires and picks up the
    // already-updated tombstone list via its lazy snapshot thunk).
    recordTombstone(HASH_A, "ann_dead", 3);
    ydoc.transact(() => annMap.delete("ann_dead"), MCP_ORIGIN);

    await store.flush();

    const raw = await fs.readFile(path.join(tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.tombstones).toHaveLength(1);
    expect(onDisk.tombstones[0].id).toBe("ann_dead");
    expect(onDisk.tombstones[0].rev).toBe(4);

    cleanup();
  });

  it("is idempotent: duplicate tombstone at same rev is a no-op", () => {
    recordTombstone(HASH_A, "ann_x", 3);
    recordTombstone(HASH_A, "ann_x", 3);
    expect(getTombstones(HASH_A)).toHaveLength(1);
  });

  it("getTombstones returns a defensive copy (mutation does not leak)", () => {
    recordTombstone(HASH_A, "ann_x", 0);
    const list = getTombstones(HASH_A);
    list.push({ id: "ann_injected", rev: 99, deletedAt: 0 });
    expect(getTombstones(HASH_A)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Replies (canonical merge case)
// ---------------------------------------------------------------------------

describe("replies merge", () => {
  it("#17 file reply rev > Y.Map reply rev → file wins", async () => {
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeFile(HASH_A, FILE_A, {
        replies: [replyRecord({ id: "rep_1", rev: 5, text: "disk" })],
      }),
    );
    await store0.flush();
    resetStoreForTesting();

    const ydoc = new Y.Doc();
    const repMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    repMap.set("rep_1", replyRecord({ id: "rep_1", rev: 2, text: "ymap" }));

    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    const winner = repMap.get("rep_1") as AnnotationReplyRecordV1;
    expect(winner.rev).toBe(5);
    expect(winner.text).toBe("disk");
    cleanup();
  });

  it("replies also survive via observer on browser-origin mutation", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const repMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    repMap.set("rep_1", replyRecord({ id: "rep_1" }));

    await store.flush();
    const raw = await fs.readFile(path.join(tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.replies).toHaveLength(1);
    expect(onDisk.replies[0].id).toBe("rep_1");
    cleanup();
  });

  it("#20 reply: file has reply, Y.Map empty → reply inserted", async () => {
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeFile(HASH_A, FILE_A, {
        replies: [replyRecord({ id: "rep_2", rev: 3, text: "from-disk" })],
      }),
    );
    await store0.flush();
    resetStoreForTesting();

    const ydoc = new Y.Doc();
    const repMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);

    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    const inserted = repMap.get("rep_2") as AnnotationReplyRecordV1 | undefined;
    expect(inserted).toBeDefined();
    expect(inserted?.rev).toBe(3);
    expect(inserted?.text).toBe("from-disk");
    cleanup();
  });

  it("#21 reply: Y.Map has reply, file has no replies → queueWrite fires", async () => {
    // The file must have an annotation so fileEmpty is false — otherwise
    // loadAndMerge takes the first-upgrade fast path and queueWrite fires for
    // a different reason without ever reaching the reply merge loop.
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeFile(HASH_A, FILE_A, {
        annotations: [annRecord({ id: "ann_other", rev: 1 })],
        replies: [],
      }),
    );
    await store0.flush();
    resetStoreForTesting();

    const ydoc = new Y.Doc();
    const repMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    repMap.set("rep_3", replyRecord({ id: "rep_3", rev: 1, text: "in-memory" }));

    const store = createStore(HASH_A, { filePath: FILE_A });
    const queueSpy = vi.spyOn(store, "queueWrite");
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    expect(repMap.get("rep_3")).toBeDefined();
    expect(queueSpy).toHaveBeenCalled();
    cleanup();
  });

  it("#22 reply: Y.Map rev > file rev → Y.Map wins (unchanged)", async () => {
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeFile(HASH_A, FILE_A, {
        replies: [replyRecord({ id: "rep_1", rev: 1, text: "from-disk" })],
      }),
    );
    await store0.flush();
    resetStoreForTesting();

    const ydoc = new Y.Doc();
    const repMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    repMap.set("rep_1", replyRecord({ id: "rep_1", rev: 4, text: "from-ymap" }));

    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    const winner = repMap.get("rep_1") as AnnotationReplyRecordV1;
    expect(winner.rev).toBe(4);
    expect(winner.text).toBe("from-ymap");
    cleanup();
  });
});
