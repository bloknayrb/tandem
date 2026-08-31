/**
 * Tests for the annotation sync module: observer registration, tombstones,
 * and the initial load+merge pass.
 *
 * Uses real Y.Doc instances (no Hocuspocus) and a real `DocStore` backed by a
 * per-test tempdir via `TANDEM_APP_DATA_DIR`.
 */

import fs from "node:fs/promises";
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

import { resetMigrationLog } from "../../../src/server/annotations/migration-log.js";
import {
  type AnnotationRecordV1,
  type AnnotationReplyRecordV1,
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
  migrateTombstoneLedger,
  pickWinner,
  recordTombstone,
  registerAnnotationObserver,
  resetForTesting,
  type SyncContext,
} from "../../../src/server/annotations/sync.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../../src/shared/constants.js";
import { FILE_SYNC_ORIGIN, INTERNAL_ORIGIN, MCP_ORIGIN } from "../../../src/shared/origins.js";
import {
  annRecord,
  FILE_A,
  FILE_B,
  HASH_A,
  HASH_B,
  makeAnnotationDoc,
  replyRecord,
} from "../../helpers/annotation-fixtures.js";
import { useTmpAnnotationsEnvWithFlag } from "../../helpers/annotation-store-env.js";

/**
 * Filter `errorSpy.mock.calls` to only the `legacy-type` migration lines.
 * After #483, `sanitizeAnnotation` also routes `flag-to-note`,
 * `question-to-comment`, `malformed-suggestion-json`, and `unknown-type`
 * events through the same migration-log channel — these tests pre-date
 * #483 and assert the count of the legacy-type umbrella line specifically.
 */
function legacyTypeLogs(errorSpy: ReturnType<typeof vi.spyOn>): unknown[][] {
  return errorSpy.mock.calls.filter((args: unknown[]) =>
    String(args[0]).includes("legacy migration: legacy-type"),
  );
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

const env = useTmpAnnotationsEnvWithFlag("tandem-sync-test-");

beforeEach(() => {
  resetForTesting();
  resetStoreForTesting();
  resetMigrationLog();
});

afterEach(() => {
  resetForTesting();
  resetStoreForTesting();
  resetMigrationLog();
  // Console spies here restore by hand as their last statement, which does
  // nothing for a spec that fails mid-body: the mock leaks and silences that
  // channel for the rest of the run, so the failure reads as one red spec
  // rather than as blindness. This is the net for that, and the two warn specs
  // below rely on it rather than restoring by hand — so the by-hand calls above
  // are now belt-and-braces, not the mechanism. `vitest.config.ts` sets no
  // `restoreMocks`. Restores `vi.spyOn` spies only; the module mock at the top
  // of the file is unaffected, and its call history is NOT cleared.
  vi.restoreAllMocks();
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

    const raw = await fs.readFile(path.join(env.tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
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

    const raw = await fs.readFile(path.join(env.tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
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
      fs.access(path.join(env.tmpRoot, "annotations", `${HASH_A}.json`)),
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

    const raw = await fs.readFile(path.join(env.tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
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

    const raw = await fs.readFile(path.join(env.tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
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

  it("snapshot logs console.error when normalizeAnnotation drops a non-object entry", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    ydoc.transact(() => {
      annMap.set("ann_valid", annRecord({ id: "ann_valid" }));
      annMap.set("ann_bad", "not-an-object" as unknown as Record<string, unknown>);
    }, MCP_ORIGIN);

    await store.flush();

    const dropCalls = errorSpy.mock.calls.filter((args) =>
      String(args[0]).includes("[ANNOTATION-STORE] snapshot: dropped"),
    );
    expect(dropCalls).toHaveLength(1);
    expect(dropCalls[0][0]).toMatch(/dropped 1 annotation\(s\), 0 reply\(ies\)/);

    cleanup();
    errorSpy.mockRestore();
  });

  it("snapshot logs console.error when normalizeReply drops a non-object entry", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const repMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    ydoc.transact(() => {
      annMap.set("ann_valid", annRecord({ id: "ann_valid" }));
      repMap.set("rep_bad", "not-an-object" as unknown as Record<string, unknown>);
    }, MCP_ORIGIN);

    await store.flush();

    const dropCalls = errorSpy.mock.calls.filter((args) =>
      String(args[0]).includes("[ANNOTATION-STORE] snapshot: dropped"),
    );
    expect(dropCalls).toHaveLength(1);
    expect(dropCalls[0][0]).toMatch(/dropped 0 annotation\(s\), 1 reply\(ies\)/);

    cleanup();
    errorSpy.mockRestore();
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

    const raw = await fs.readFile(path.join(env.tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.annotations).toHaveLength(1);
    expect(onDisk.annotations[0].type).toBe("comment");

    // The critical invariant: the envelope we just wrote must round-trip
    // cleanly through the v1 parser. If this assertion ever regresses, the
    // durable store will self-quarantine on the next open.
    const parsed = parseAnnotationDoc(raw);
    expect(parsed.ok).toBe(true);

    expect(legacyTypeLogs(errorSpy)).toHaveLength(1);
    cleanup();
    errorSpy.mockRestore();
  });

  it("rewrites 'question' type to 'comment' (directedAt stripped per ADR-027), envelope stays loadable", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    ydoc.transact(
      () =>
        annMap.set("ann_question", {
          ...annRecord({ id: "ann_question", rev: 3 }),
          type: "question",
        }),
      MCP_ORIGIN,
    );

    await store.flush();

    const raw = await fs.readFile(path.join(env.tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.annotations[0].type).toBe("comment");
    // directedAt is stripped by ADR-027 sanitize/migrate
    expect(onDisk.annotations[0].directedAt).toBeUndefined();

    // Envelope must parse cleanly — regression here means the store would
    // self-quarantine on the next open.
    const parsed = parseAnnotationDoc(raw);
    expect(parsed.ok).toBe(true);

    cleanup();
    errorSpy.mockRestore();
  });

  it("fast-path (canonical type + numeric rev) strips directedAt from disk output", async () => {
    // The fast path returns obj as-is when type is canonical and rev is numeric,
    // so it must explicitly strip directedAt — pre-ADR-027 records may carry it.
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    ydoc.transact(
      () =>
        annMap.set("ann_with_directed", {
          ...annRecord({ id: "ann_with_directed", rev: 5 }),
          type: "comment",
          directedAt: "claude",
        }),
      MCP_ORIGIN,
    );

    await store.flush();

    const raw = await fs.readFile(path.join(env.tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.annotations[0].type).toBe("comment");
    expect(onDisk.annotations[0].directedAt).toBeUndefined();

    const parsed = parseAnnotationDoc(raw);
    expect(parsed.ok).toBe(true);

    cleanup();
  });

  it("fast-path directedAt strip logs the migration once per doc", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    ydoc.transact(() => {
      annMap.set("a1", {
        ...annRecord({ id: "a1", rev: 5 }),
        type: "comment",
        directedAt: "claude",
      });
      annMap.set("a2", {
        ...annRecord({ id: "a2", rev: 5 }),
        type: "comment",
        directedAt: "claude",
      });
    }, MCP_ORIGIN);
    await store.flush();

    const directedAtLogs = errorSpy.mock.calls.filter((args) =>
      String(args[0]).includes(`legacy migration: directedAt in ${HASH_A}`),
    );
    expect(directedAtLogs).toHaveLength(1);

    cleanup();
    errorSpy.mockRestore();
  });

  it("normalizeReply drops a malformed reply with a logged error", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const repMap = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
    ydoc.transact(() => {
      // Missing required fields (annotationId, author, text, timestamp)
      repMap.set("rep_bad", { id: "rep_bad", rev: 1 });
    }, MCP_ORIGIN);
    await store.flush();

    const raw = await fs.readFile(path.join(env.tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.replies).toHaveLength(0);

    const dropLogs = errorSpy.mock.calls.filter((args) =>
      String(args[0]).includes("normalizeReply: dropping reply id=rep_bad"),
    );
    expect(dropLogs.length).toBeGreaterThanOrEqual(1);

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

    // Two legacy records, one docHash → exactly one legacy-type warning
    // (sanitize-derived events are counted separately).
    expect(legacyTypeLogs(errorSpy)).toHaveLength(1);
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
    expect(legacyTypeLogs(errorSpy)).toHaveLength(1);
    cleanup1("close");

    // Fresh observer for the same docHash — dedupe state should have been
    // cleared so a further legacy record emits a new warning.
    const cleanup2 = registerAnnotationObserver(syncCtx(ydoc, store));
    ydoc.transact(
      () => annMap.set("a2", { ...annRecord({ id: "a2" }), type: "question" }),
      MCP_ORIGIN,
    );
    await store.flush();
    expect(legacyTypeLogs(errorSpy)).toHaveLength(2);

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
    expect(legacyTypeLogs(errorSpy)).toHaveLength(1);
    cleanup1("swap");

    const cleanup2 = registerAnnotationObserver(syncCtx(ydoc, store));
    ydoc.transact(
      () => annMap.set("a2", { ...annRecord({ id: "a2" }), type: "question" }),
      MCP_ORIGIN,
    );
    await store.flush();
    // Same docHash, swap semantics → no additional legacy-type warning.
    expect(legacyTypeLogs(errorSpy)).toHaveLength(1);

    cleanup2("close");
    errorSpy.mockRestore();
  });

  it("preserves the original rev value through the sanitize branch (not zeroed)", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    // Use a nonzero rev so a regression that resets to 0 is detectable.
    ydoc.transact(
      () =>
        annMap.set("ann_rev_check", {
          ...annRecord({ id: "ann_rev_check", rev: 7 }),
          type: "suggestion",
        }),
      MCP_ORIGIN,
    );

    await store.flush();

    const raw = await fs.readFile(path.join(env.tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.annotations[0].rev).toBe(7);

    cleanup();
    errorSpy.mockRestore();
  });

  it("dedupes independently per docHash (two docs each log once)", async () => {
    const ydocA = new Y.Doc();
    const storeA = createStore(HASH_A, { filePath: FILE_A });
    const ydocB = new Y.Doc();
    const storeB = createStore(HASH_B, { filePath: FILE_B });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const cleanupA = registerAnnotationObserver(syncCtx(ydocA, storeA));
    const cleanupB = registerAnnotationObserver(
      syncCtx(ydocB, storeB, { docHash: HASH_B, meta: { filePath: FILE_B } }),
    );

    const annMapA = ydocA.getMap(Y_MAP_ANNOTATIONS);
    const annMapB = ydocB.getMap(Y_MAP_ANNOTATIONS);

    ydocA.transact(
      () => annMapA.set("a1", { ...annRecord({ id: "a1" }), type: "suggestion" }),
      MCP_ORIGIN,
    );
    ydocB.transact(
      () => annMapB.set("b1", { ...annRecord({ id: "b1" }), type: "question" }),
      MCP_ORIGIN,
    );

    await storeA.flush();
    await storeB.flush();

    // Two different docHashes → two independent legacy-type log entries.
    // If dedupe collapsed to a single boolean, the second would be suppressed.
    expect(legacyTypeLogs(errorSpy)).toHaveLength(2);

    cleanupA();
    cleanupB();
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
      makeAnnotationDoc(HASH_A, FILE_A, {
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
    expect(legacyTypeLogs(errorSpy)).toHaveLength(1);

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

    const raw = await fs.readFile(path.join(env.tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
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
      makeAnnotationDoc(HASH_A, FILE_A, { annotations: [annRecord({ id: "ann_disk", rev: 5 })] }),
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
      makeAnnotationDoc(HASH_A, FILE_A, {
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
      makeAnnotationDoc(HASH_A, FILE_A, {
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
      makeAnnotationDoc(HASH_A, FILE_A, {
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
      makeAnnotationDoc(HASH_A, FILE_A, {
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
      makeAnnotationDoc(HASH_A, FILE_A, {
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
      makeAnnotationDoc(HASH_A, FILE_A, {
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
    store0.queueWrite(() => makeAnnotationDoc(HASH_A, FILE_A, { annotations: [], replies: [] }));
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
    const raw = await fs.readFile(path.join(env.tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
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
      makeAnnotationDoc(HASH_A, FILE_A, {
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
      makeAnnotationDoc(HASH_A, FILE_A, {
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
      makeAnnotationDoc(HASH_A, FILE_A, {
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
// loadAndMerge — rename tombstone union (#1040)
// ---------------------------------------------------------------------------

describe("loadAndMerge — rename tombstone union (#1040)", () => {
  // Union-not-clobber (#1040, window a3): a migrated-forward DELETE may sit in the
  // in-memory ledger for `docHash` that the just-written file does NOT yet carry.
  // loadAndMerge must NOT clobber the seed with only the file tombstones — it must
  // UNION both, keep the migrated-forward tombstone, APPLY it to the Y.Map, and
  // FORCE a write (the `seedHasExtraTombstones` branch) so it reaches disk for a
  // later reopen with an empty ledger.
  it("preserves a seeded tombstone the file lacks, applies it, and forces a write", async () => {
    // File envelope has A alive at rev 1 and NO tombstone for it.
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeAnnotationDoc(HASH_A, FILE_A, {
        annotations: [annRecord({ id: "A", rev: 1 })],
        tombstones: [],
      }),
    );
    await store0.flush();
    resetStoreForTesting();

    // Pre-seed the in-memory ledger for HASH_A with a tombstone the file lacks —
    // this stands in for a rename's migrated-forward DELETE (recordTombstone bumps
    // to prevRev+1, so A is tombstoned at rev 2 > the file's alive rev 1).
    recordTombstone(HASH_A, "A", 1);
    expect(getTombstones(HASH_A).map((t) => t.id)).toContain("A");

    const ydoc = new Y.Doc();
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    // A is also live in the Y.Map at the pre-deletion rev (a stale-tab merge would
    // re-introduce it); the union'd tombstone must drop it.
    annMap.set("A", annRecord({ id: "A", rev: 1 }));

    const store = createStore(HASH_A, { filePath: FILE_A });
    const queueSpy = vi.spyOn(store, "queueWrite");
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    // The seeded tombstone is preserved (not clobbered by the file seed)...
    expect(getTombstones(HASH_A).map((t) => t.id)).toContain("A");
    // ...applied to the Y.Map (tombstone rev 2 > Y.Map rev 1 -> A dropped)...
    expect(annMap.has("A")).toBe(false);
    // ...and a write is FORCED so the migrated-forward delete reaches disk.
    expect(queueSpy).toHaveBeenCalled();

    await store.flush();
    const persisted = await fs.readFile(
      path.join(env.tmpRoot, "annotations", `${HASH_A}.json`),
      "utf-8",
    );
    const parsed = parseAnnotationDoc(persisted);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.doc.tombstones.map((t) => t.id)).toContain("A");
      expect(parsed.doc.annotations.map((a) => a.id)).not.toContain("A");
    }
    cleanup();
  });

  // Force-reload safety: clearAndReload clears the in-memory ledger (via
  // clearFileSyncContext's "close" phase -> tombstonesByDoc.delete) AND the store
  // BEFORE loadAndMerge runs, so the union degenerates to the (empty) file seed.
  // A stale ledger entry must NOT survive a legitimate reload to eat a freshly
  // resurrected annotation. We emulate that ordering: seed a stale tombstone,
  // clear the ledger (migrateTombstoneLedger from an empty source is a no-op; the
  // clear is what matters), then loadAndMerge against a file that legitimately
  // carries the annotation alive — it must NOT be dropped.
  it("a cleared ledger before reload leaves no stale tombstone to eat a live annotation", async () => {
    // File envelope (post-reload disk state) has A alive at rev 5, no tombstone.
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeAnnotationDoc(HASH_A, FILE_A, {
        annotations: [annRecord({ id: "A", rev: 5, content: "reloaded-alive" })],
        tombstones: [],
      }),
    );
    await store0.flush();

    // A stale in-memory tombstone exists for A (e.g. from a pre-reload session).
    recordTombstone(HASH_A, "A", 1);
    expect(getTombstones(HASH_A).map((t) => t.id)).toContain("A");

    // Force-reload prep clears the in-memory ledger for this hash (the "close"
    // phase of clearFileSyncContext / resetForTesting does exactly this). After
    // this the union below must start empty.
    resetForTesting();
    expect(getTombstones(HASH_A)).toHaveLength(0);

    // migrateTombstoneLedger from an empty source is a no-op — there is nothing to
    // fold forward — so the union remains empty and the file's live A survives.
    migrateTombstoneLedger(HASH_B, HASH_A);

    const ydoc = new Y.Doc();
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);

    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    // The legitimately-resurrected (reloaded) annotation A is NOT eaten by a stale
    // tombstone — the cleared ledger contributed nothing to the union.
    const survivor = annMap.get("A") as AnnotationRecordV1 | undefined;
    expect(survivor).toBeDefined();
    expect(survivor?.rev).toBe(5);
    expect(getTombstones(HASH_A).map((t) => t.id)).not.toContain("A");
    cleanup();
  });

  it("migrateTombstoneLedger folds into a populated destination without clobbering it", async () => {
    // The fold's arrival half is covered end-to-end in rename-document.test.ts;
    // what has never been exercised is a destination that ALREADY holds the id.
    // Four ids, because the two mutants this guards against are visible in
    // different rows and neither row catches both:
    //
    //   - replacing the body with `tombstonesByDoc.set(toHash, from)` shows up
    //     only where the destination's rev is strictly higher;
    //   - relaxing `stone.rev > existing.rev` to `>=` shows up only on a rev
    //     TIE, and there only through `deletedAt`, since the rev is equal by
    //     construction.
    //
    // Which is why the destination is seeded from a file envelope rather than
    // with `recordTombstone`: that stamps `Date.now()` and takes no
    // `deletedAt`, and two back-to-back calls land in the same millisecond, so
    // a ledger built that way has no discriminator and stays green under `>=`.
    // `loadAndMerge`'s seed preserves the file record verbatim, which is what
    // makes the chosen timestamps observable.
    //
    // The tie is a LIVE branch, not a hypothetical: a rename folds twice into
    // the same destination — once directly before the RMW snapshot, once via
    // `loadAndMerge`'s `migrateTombstonesFrom` — so every already-folded record
    // re-enters at an identical rev. But the first fold spreads the source, so
    // on the real path the two sides are byte-identical and preserve-vs-clobber
    // is unobservable. The differing `deletedAt` below is constructed for that
    // reason; the rename never produces it.
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeAnnotationDoc(HASH_A, FILE_A, {
        annotations: [],
        tombstones: [
          { id: "ann_from_higher", rev: 3, deletedAt: 103 },
          { id: "ann_tie", rev: 4, deletedAt: 202 },
          { id: "ann_to_higher", rev: 8, deletedAt: 208 },
        ],
      }),
    );
    await store0.flush();
    resetStoreForTesting();
    resetForTesting();

    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));
    expect(getTombstones(HASH_A)).toHaveLength(3);

    // Source ledger under the pre-rename hash.
    recordTombstone(HASH_B, "ann_only_from", 1); // → rev 2, destination has none
    recordTombstone(HASH_B, "ann_from_higher", 8); // → rev 9 beats the file's 3
    recordTombstone(HASH_B, "ann_tie", 3); // → rev 4, an exact tie
    recordTombstone(HASH_B, "ann_to_higher", 0); // → rev 1, loses to the file's 8

    migrateTombstoneLedger(HASH_B, HASH_A);

    const byId = new Map(getTombstones(HASH_A).map((t) => [t.id, t]));
    expect(byId.size).toBe(4);

    // Arrival — a control, not a mutant-kill: removing it leaves every mutant
    // above still caught, and the size check already stops the spec passing on
    // a fold that did nothing. It earns its place by keeping the
    // destination-empty case readable beside the three that are not.
    expect(byId.get("ann_only_from")?.rev).toBe(2);

    // Source wins on a higher rev, and brings its own record with it. The
    // timestamp half carries a third mutant of its own, beyond the two named
    // above: a partial overwrite that copies `rev` onto the destination while
    // keeping its old record. Measured RED here, and here only — an
    // unguarded-spread spelling of the same idea would also break the
    // arrival row, so "only" is about this spelling, not the whole class.
    expect(byId.get("ann_from_higher")?.rev).toBe(9);
    expect(byId.get("ann_from_higher")?.deletedAt).not.toBe(103);

    // Tie → destination preserved. The rev assertion alone proves nothing here
    // (both sides are 4); the timestamp is the whole discriminator.
    expect(byId.get("ann_tie")?.rev).toBe(4);
    expect(byId.get("ann_tie")?.deletedAt).toBe(202);

    // Destination strictly higher → preserved.
    expect(byId.get("ann_to_higher")?.rev).toBe(8);
    expect(byId.get("ann_to_higher")?.deletedAt).toBe(208);

    // The fold is a fold, not a move: the source ledger survives it. Its
    // teardown is the caller's "close" phase, not this function.
    expect(getTombstones(HASH_B)).toHaveLength(4);

    cleanup();
  });

  it("the load-time seed unions file tombstones with the in-memory ledger, highest rev winning", async () => {
    // The sibling of the fold rule above, 200 lines away and guarding the same
    // window: `loadAndMerge` seeds from the file INTO the in-memory ledger, and
    // the in-memory side may hold a migrated-forward delete the file does not
    // carry yet (#1040 window a3). If a lower-rev file record could clobber it,
    // that delete is lost and the annotation resurrects.
    //
    // Measured as genuinely open before this spec: making the seed
    // unconditional, and inverting its comparison, BOTH survived the whole
    // annotation suite. The fold rule was pinned and this one was not.
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeAnnotationDoc(HASH_A, FILE_A, {
        annotations: [],
        tombstones: [
          { id: "ann_file_loses", rev: 2, deletedAt: 100 },
          { id: "ann_file_wins", rev: 9, deletedAt: 109 },
          { id: "ann_tie", rev: 3, deletedAt: 103 },
        ],
      }),
    );
    await store0.flush();
    resetStoreForTesting();
    resetForTesting();

    // In-memory ledger, as a rename's fold-forward would have left it.
    recordTombstone(HASH_A, "ann_file_loses", 4); // → rev 5, beats the file's 2
    recordTombstone(HASH_A, "ann_file_wins", 2); // → rev 3, loses to the file's 9
    recordTombstone(HASH_A, "ann_tie", 2); // → rev 3, an exact tie

    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    const byId = new Map(getTombstones(HASH_A).map((t) => [t.id, t]));
    expect(byId.size).toBe(3);

    // The in-memory record is the one that must not be lost.
    expect(byId.get("ann_file_loses")?.rev).toBe(5);
    // The file legitimately wins when it is strictly newer.
    expect(byId.get("ann_file_wins")?.rev).toBe(9);
    // Tie → the in-memory side is preserved, same as the fold. The rev is 3
    // either way, so as there the timestamp is the whole discriminator: the
    // file's is a literal, the ledger's is a stamped `Date.now()`.
    expect(byId.get("ann_tie")?.rev).toBe(3);
    expect(byId.get("ann_tie")?.deletedAt).not.toBe(103);

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

    const raw = await fs.readFile(path.join(env.tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.tombstones).toHaveLength(1);
    expect(onDisk.tombstones[0].id).toBe("ann_dead");
    expect(onDisk.tombstones[0].rev).toBe(4);

    cleanup();
  });

  it("is idempotent: duplicate tombstone at same rev is a no-op", () => {
    // The length assertion alone does not say "no-op": relaxing the guard from
    // `existing.rev >= newRev` to `>` lets the second call OVERWRITE the record
    // with a fresh `deletedAt` while the count stays 1. Measured — that mutant
    // survived the whole annotation suite before this spec asserted the record.
    //
    // The overwrite is not cosmetic. `deletedAt` is what `cleanupStaleTombstones`
    // ages against, so a re-record resets the retention clock; and same-rev
    // double-recording is a LIVE path, not a hypothetical — it is the contract
    // this function's docblock names, and `rename-recovery`'s `rev - 1` reseed
    // is exactly what produces it.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      recordTombstone(HASH_A, "ann_x", 3);
      const first = getTombstones(HASH_A)[0];

      vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
      recordTombstone(HASH_A, "ann_x", 3);

      const after = getTombstones(HASH_A);
      expect(after).toHaveLength(1);
      expect(after[0].rev).toBe(first.rev);
      expect(after[0].deletedAt).toBe(first.deletedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("getTombstones returns a defensive copy (mutation does not leak)", () => {
    recordTombstone(HASH_A, "ann_x", 0);
    const list = getTombstones(HASH_A);
    list.push({ id: "ann_injected", rev: 99, deletedAt: 0 });
    expect(getTombstones(HASH_A)).toHaveLength(1);
  });
});

describe("observer-driven tombstones (#695)", () => {
  it("MCP-origin Y.Map.delete produces a tombstone via the observer", () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    annMap.set("ann_dead", annRecord({ id: "ann_dead", rev: 3 }));

    ydoc.transact(() => annMap.delete("ann_dead"), MCP_ORIGIN);

    const stones = getTombstones(HASH_A);
    expect(stones).toHaveLength(1);
    expect(stones[0].id).toBe("ann_dead");
    expect(stones[0].rev).toBe(4); // prevRev (3) + 1

    cleanup();
  });

  it("browser-origin Y.Map.delete produces a tombstone via the observer", () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    annMap.set("ann_dead", annRecord({ id: "ann_dead", rev: 7 }));

    // No-origin transaction simulates a browser-driven delete that bypasses
    // the MCP tool. Pre-fix this would silently skip the tombstone ledger
    // and the annotation could resurrect from a stale-tab CRDT merge.
    ydoc.transact(() => annMap.delete("ann_dead"));

    const stones = getTombstones(HASH_A);
    expect(stones).toHaveLength(1);
    expect(stones[0].id).toBe("ann_dead");
    expect(stones[0].rev).toBe(8);

    cleanup();
  });

  it("simulated stale-tab CRDT merge delete is captured by the observer", () => {
    // Author A: holds an annotation. Author B (stale peer): deletes it.
    // Merge B → A simulates the stale-tab path where the delete propagates
    // via Hocuspocus's sync protocol rather than an MCP tool call.
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const annA = docA.getMap(Y_MAP_ANNOTATIONS);
    const annB = docB.getMap(Y_MAP_ANNOTATIONS);

    docA.transact(() => annA.set("ann_remote", annRecord({ id: "ann_remote", rev: 2 })));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    docB.transact(() => annB.delete("ann_remote"));

    // Register observer on docA, then merge the deletion in. The observer
    // fires with the txn origin set by Yjs's own apply path (not MCP, not
    // FILE_SYNC), and we want the tombstone recorded.
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = registerAnnotationObserver(syncCtx(docA, store));

    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

    const stones = getTombstones(HASH_A);
    expect(stones.map((t) => t.id)).toContain("ann_remote");

    cleanup();
  });

  it("FILE_SYNC-origin Y.Map.delete records a tombstone but does NOT queue a write", () => {
    // File-sync deletes happen during `loadAndMerge` when applying file
    // tombstones to the Y.Map. The tombstone IS recorded by the observer
    // (load-bearing for the partial-load case where `loadAndMerge` failed
    // or was skipped); `recordTombstone` coalesces, so the seed + observer
    // record at the same rev is a no-op. The write queue is NOT touched —
    // FILE_SYNC echoes must not round-trip back to disk.
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const queueSpy = vi.spyOn(store, "queueWrite");
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    annMap.set("ann_dead", annRecord({ id: "ann_dead", rev: 1 }));
    queueSpy.mockClear();

    ydoc.transact(() => annMap.delete("ann_dead"), FILE_SYNC_ORIGIN);

    const stones = getTombstones(HASH_A);
    expect(stones).toHaveLength(1);
    expect(stones[0].id).toBe("ann_dead");
    expect(stones[0].rev).toBe(2); // prevRev=1 + 1
    expect(queueSpy).not.toHaveBeenCalled();

    cleanup();
  });

  it("INTERNAL-origin Y.Map.delete records a tombstone but does NOT queue a write", () => {
    // INTERNAL is in the durable-sync skip set (origins.ts DURABLE_SKIP) too —
    // the observer must record the tombstone WITHOUT round-tripping the
    // delete back to disk via queueWrite. Mirrors the FILE_SYNC test above
    // for the deleted-shouldSkipTombstone contract's other half. Pre-PR-#765
    // behavior: shouldSkipTombstone skipped both file-sync AND internal; now
    // both record. This locks the internal half.
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const queueSpy = vi.spyOn(store, "queueWrite");
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    annMap.set("ann_dead", annRecord({ id: "ann_dead", rev: 1 }));
    queueSpy.mockClear();

    ydoc.transact(() => annMap.delete("ann_dead"), INTERNAL_ORIGIN);

    const stones = getTombstones(HASH_A);
    expect(stones).toHaveLength(1);
    expect(stones[0].id).toBe("ann_dead");
    expect(stones[0].rev).toBe(2); // prevRev=1 + 1
    expect(queueSpy).not.toHaveBeenCalled();

    cleanup();
  });

  it("FILE_SYNC-origin delete records tombstone even without loadAndMerge seed (#700 partial-load invariant)", () => {
    // Codifies the regression fix for PR #700: if `loadAndMerge` fails or
    // is skipped on a doc, the observer must still record tombstones on
    // FILE_SYNC delete events so they aren't lost. Previously the early-
    // return on FILE_SYNC_ORIGIN dropped the tombstone silently.
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    annMap.set("ann_orphan", annRecord({ id: "ann_orphan", rev: 3 }));

    // No `loadAndMerge` call → no seed in the ledger.
    expect(getTombstones(HASH_A)).toHaveLength(0);

    ydoc.transact(() => annMap.delete("ann_orphan"), FILE_SYNC_ORIGIN);

    const stones = getTombstones(HASH_A);
    expect(stones.map((t) => t.id)).toContain("ann_orphan");
    expect(stones.find((t) => t.id === "ann_orphan")?.rev).toBe(4);

    cleanup();
  });

  it("a delete whose old value has no rev tombstones at rev 1, warns, and loses to a live rev-1 copy", async () => {
    // `sync.ts` falls back to `prevRev = 0` when the deleted value carries no
    // `rev`, so the tombstone lands at 1. That fallback is CORRECT and must not
    // be "fixed" upward: `normalizeAnnotation` maps a missing `rev` to 0, so 1
    // is the minimum value that beats the record the observer actually saw.
    //
    // The cost is recorded here rather than treated as a defect. Against the
    // delete rule (`stone.rev > ymapRec.rev`) a rev-1 tombstone cannot beat a
    // peer that edited its own copy of the same rev-less record — `nextRev`
    // takes it to rev 1 as well, and 1 > 1 is false. That is inherent to a
    // single integer rev over a record that never had one, which is exactly
    // what the warning announces.
    //
    // The tombstone MUST be produced by the observer here, not planted with
    // `recordTombstone`: a planted one stays green with the whole `hasRev`
    // fallback deleted, because then the test's own literal supplies the rev
    // rather than the branch under test.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    // `annRecord` always supplies `rev: 0`; drop the key entirely so the
    // stored value is shaped like a pre-`rev` legacy session blob.
    const legacy = { ...annRecord({ id: "ann_legacy" }) } as Partial<AnnotationRecordV1>;
    delete legacy.rev;
    annMap.set("ann_legacy", legacy);

    ydoc.transact(() => annMap.delete("ann_legacy"), MCP_ORIGIN);

    const stones = getTombstones(HASH_A);
    expect(stones).toHaveLength(1);
    expect(stones[0].rev).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("ann_legacy");

    // Now the consequence, on the SAME ledger. `"swap"` rather than
    // `"close"`, because close drops the ledger and the merge below has to
    // see the tombstone the observer just recorded.
    //
    // This half COULD be its own spec — `recordTombstone(HASH_A, id, 0)`
    // produces an identical ledger, so an earlier version of this comment
    // was wrong to call the spec unsplittable. What the chain buys is the
    // link between the two: split, one spec pins the value the fallback
    // picks and the other pins the merge rule at a tie, and nothing asserts
    // that the value the fallback picks IS the one that ties.
    cleanup("swap");
    annMap.set("ann_legacy", annRecord({ id: "ann_legacy", rev: 1, content: "reborn" }));

    const cleanup2 = await loadAndMerge(syncCtx(ydoc, store));
    const survivor = annMap.get("ann_legacy") as AnnotationRecordV1 | undefined;
    expect(survivor?.content).toBe("reborn");

    // Positive control, on the same ledger, because "survives" is an OUTCOME
    // that a merge doing nothing at all also produces. Measured: disabling the
    // delete branch entirely (`if (false && stone.rev > ymapAnn.rev)`) left the
    // assertion above green — it pins the rule against being LOOSENED, not
    // against being deleted. Dropping the live copy below the tombstone proves
    // the branch is live before the survival claim leans on it.
    cleanup2("swap");
    annMap.set("ann_legacy", annRecord({ id: "ann_legacy", rev: 0, content: "stale" }));

    const cleanup3 = await loadAndMerge(syncCtx(ydoc, store));
    expect(annMap.get("ann_legacy")).toBeUndefined();
    cleanup3();
  });

  it("a delete whose old value HAS a rev tombstones at rev+1 and does not warn", () => {
    // Control for the spec above: without it, a mutant that warns
    // unconditionally — or one that always uses the `prevRev = 0` fallback —
    // survives, since the other spec only ever asserts the legacy shape.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
    annMap.set("ann_versioned", annRecord({ id: "ann_versioned", rev: 5 }));

    ydoc.transact(() => annMap.delete("ann_versioned"), MCP_ORIGIN);

    const stones = getTombstones(HASH_A);
    expect(stones).toHaveLength(1);
    expect(stones[0].rev).toBe(6);
    expect(warnSpy).not.toHaveBeenCalled();

    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Replies (canonical merge case)
// ---------------------------------------------------------------------------

describe("replies merge", () => {
  it("#17 file reply rev > Y.Map reply rev → file wins", async () => {
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeAnnotationDoc(HASH_A, FILE_A, {
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
    const raw = await fs.readFile(path.join(env.tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.replies).toHaveLength(1);
    expect(onDisk.replies[0].id).toBe("rep_1");
    cleanup();
  });

  it("#20 reply: file has reply, Y.Map empty → reply inserted", async () => {
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeAnnotationDoc(HASH_A, FILE_A, {
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
      makeAnnotationDoc(HASH_A, FILE_A, {
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
      makeAnnotationDoc(HASH_A, FILE_A, {
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

describe("observer cleanup — tombstone survival (#333)", () => {
  it("swap-phase cleanup preserves the per-doc tombstone ledger", () => {
    // A debounced write queued against the OLD Y.Doc can still fire after
    // the swap; it must see tombstones so they land on disk.
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    recordTombstone(HASH_A, "ann_deleted", 3);
    expect(getTombstones(HASH_A)).toHaveLength(1);

    cleanup("swap");
    expect(getTombstones(HASH_A)).toHaveLength(1);
  });

  it("close-phase cleanup drops the per-doc tombstone ledger", () => {
    // Matches `loggedLegacyDocs` close semantics: fresh context on reopen.
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    recordTombstone(HASH_A, "ann_deleted", 3);
    expect(getTombstones(HASH_A)).toHaveLength(1);

    cleanup("close");
    expect(getTombstones(HASH_A)).toHaveLength(0);
  });

  it("cleanup with no argument defaults to the close phase", () => {
    // The two specs above always pass an explicit phase, so neither can see
    // the DEFAULT in `(phase: ObserverCleanupPhase = "close")` being flipped.
    // Nothing else in the suite can either: dozens of specs in this file call a
    // bare `cleanup()` as teardown, but none asserts ledger state afterwards,
    // and `resetForTesting()` runs on both sides of every spec — so a default
    // of `"swap"` would leak nothing and the whole suite would stay green.
    //
    // The ledger assertion covers both halves of the branch: the
    // `tombstonesByDoc.delete` and the `forgetDoc` share one conditional, so a
    // flipped default skips them together. The narrower mutant that moves only
    // `forgetDoc` out of the `if` dies on the migration-log dedup specs above.
    //
    // Scope, stated honestly: the default is dead in production today. The one
    // consumer of this cleanup reaches it through `safeCleanup`, which forwards
    // an explicit phase at all four of its call sites. This pins the contract
    // for a future caller and for the optional `phase?` in the returned type.
    //
    // A required parameter would be the stronger form — it refuses that future
    // caller rather than describing what happens to it — and this spec would
    // then be deleted rather than kept alongside it. The trade is ~100
    // mechanical test edits against a three-spec PR; it is #1695, not a defect.
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));

    recordTombstone(HASH_A, "ann_deleted", 3);
    expect(getTombstones(HASH_A)).toHaveLength(1);

    cleanup();
    expect(getTombstones(HASH_A)).toHaveLength(0);
  });
});

describe("pickWinner", () => {
  it("higher file rev wins (rule 1)", () => {
    expect(pickWinner({ rev: 5 }, { rev: 4 })).toBe("file");
  });

  it("higher ymap rev wins (rule 1)", () => {
    expect(pickWinner({ rev: 4 }, { rev: 5 })).toBe("ymap");
  });

  it("tied rev, higher file editedAt wins (rule 2)", () => {
    expect(pickWinner({ rev: 3, editedAt: 200 }, { rev: 3, editedAt: 100 })).toBe("file");
  });

  it("tied rev, higher ymap editedAt wins (rule 2)", () => {
    expect(pickWinner({ rev: 3, editedAt: 100 }, { rev: 3, editedAt: 200 })).toBe("ymap");
  });

  it("tied rev + tied editedAt → ymap wins (default to live session)", () => {
    expect(pickWinner({ rev: 3, editedAt: 100 }, { rev: 3, editedAt: 100 })).toBe("ymap");
  });

  it("tied rev, file has editedAt but ymap does not → file wins (rule 3 — session-restore heuristic)", () => {
    // Session-restored Y.Map entries from pre-plan Tandem versions lack
    // `editedAt`. If the file carries a real timestamp, treat it as more
    // recent than the ambient live-session state.
    expect(pickWinner({ rev: 2, editedAt: 500 }, { rev: 2 })).toBe("file");
  });

  it("tied rev, ymap has editedAt but file does not → ymap wins (rule 4 — no session-restore heuristic for reverse)", () => {
    // Symmetric inverse of the session-restore heuristic: the heuristic only
    // kicks in when the FILE carries a timestamp the Y.Map is missing. In
    // the reverse shape, we default to Y.Map (live session).
    expect(pickWinner({ rev: 2 }, { rev: 2, editedAt: 500 })).toBe("ymap");
  });

  it("rev 0 vs rev 0 with no editedAt → ymap (both-missing-everything case)", () => {
    // Legacy session blob → legacy session blob. The default-ymap rule
    // prevents a loadAndMerge loop on a file that carries the same state.
    expect(pickWinner({ rev: 0 }, { rev: 0 })).toBe("ymap");
  });

  it("tied rev, file editedAt: 0 beats ymap with no editedAt (typeof guard, not truthy)", () => {
    // `pickWinner` uses `typeof === "number"`, so 0 is a valid defined
    // timestamp. A truthy refactor (`if (fileEdit)`) would silently break
    // the session-restore heuristic for epoch-0 records.
    expect(pickWinner({ rev: 1, editedAt: 0 }, { rev: 1 })).toBe("file");
  });

  it("tied rev, both editedAt: 0 → ymap wins (Rule 2 tie, not Rule 3 fallback)", () => {
    // Both sides carry a defined timestamp — `0 > 0` is false, Rule 2
    // returns ymap. Guards against a truthy refactor dropping into Rule 4.
    expect(pickWinner({ rev: 1, editedAt: 0 }, { rev: 1, editedAt: 0 })).toBe("ymap");
  });
});
