/**
 * NEW-BEHAVIOUR tests for the envelope assignment pass (`legacy-envelope.ts`)
 * and the sticky-`private` reply merge.
 *
 * Old-format envelopes are literal fixtures (no `meta.keyIdentity`), never
 * produced by the branch's `snapshot()`, which would mark them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

vi.mock(import("../../../src/server/notifications.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  pushNotification: vi.fn(),
}));
vi.mock(import("../../../src/server/integrations/acl-win.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  setRestrictiveAcl: vi.fn().mockResolvedValue(undefined),
}));

import { appendAliasLedger } from "../../../src/server/annotations/alias-ledger.js";
import { assignEnvelopeRows, isFreshKey } from "../../../src/server/annotations/legacy-envelope.js";
import { resetMigrationLog } from "../../../src/server/annotations/migration-log.js";
import {
  type AnnotationRecordV1,
  KEY_IDENTITY_FORMAT,
} from "../../../src/server/annotations/schema.js";
import {
  createStore,
  resetForTesting as resetStoreForTesting,
} from "../../../src/server/annotations/store.js";
import { loadAndMerge, resetForTesting } from "../../../src/server/annotations/sync.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../../src/shared/constants.js";
import { withInternal } from "../../../src/shared/origins.js";
import {
  annRecord,
  FILE_A,
  HASH_A,
  makeAnnotationDoc,
  replyRecord,
} from "../../helpers/annotation-fixtures.js";
import { useTmpAnnotationsEnvWithFlag } from "../../helpers/annotation-store-env.js";

useTmpAnnotationsEnvWithFlag("tandem-legacy-envelope-");

beforeEach(() => {
  resetForTesting();
  resetStoreForTesting();
  resetMigrationLog();
});
afterEach(() => {
  resetForTesting();
  resetStoreForTesting();
  resetMigrationLog();
  vi.restoreAllMocks();
});

const T_X = 1_700_000_000_000;
const T_K = 1_700_000_500_000;
const X = annRecord({ id: "X", type: "comment", content: "X body", timestamp: T_X, rev: 1 });
const K = annRecord({
  id: "K",
  author: "user",
  type: "note",
  content: "K body",
  timestamp: T_K,
  rev: 1,
});

function liveDoc(records: Record<string, unknown>): Y.Doc {
  const doc = new Y.Doc();
  withInternal(doc, () => {
    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    for (const [key, value] of Object.entries(records)) map.set(key, value);
  });
  return doc;
}

function envelope(annotations: AnnotationRecordV1[], marked = false) {
  const doc = makeAnnotationDoc(HASH_A, FILE_A, { annotations });
  if (marked) doc.meta = { ...doc.meta, keyIdentity: KEY_IDENTITY_FORMAT };
  return doc;
}

const assign = (doc: Y.Doc, annotations: AnnotationRecordV1[], marked = false) =>
  assignEnvelopeRows(envelope(annotations, marked), doc.getMap(Y_MAP_ANNOTATIONS), [], HASH_A);

const bodies = (rows: Map<string, AnnotationRecordV1>) =>
  Object.fromEntries([...rows].map(([key, row]) => [key, row.content]));

describe("assignEnvelopeRows — old-format envelopes", () => {
  it("a well-formed envelope assigns every row to its own key and moves nothing", () => {
    const doc = liveDoc({ X: { ...X }, K: { ...K } });
    const out = assign(doc, [{ ...X }, { ...K }]);
    expect(bodies(out.rows)).toEqual({ X: "X body", K: "K body" });
    expect(out.moved).toBe(false);
    expect(out.quarantineIds.size).toBe(0);
  });

  it("records sharing one timestamp (tutorial seeds, one import pass) are not duplicated", () => {
    const a = annRecord({ id: "a", content: "A", timestamp: T_X });
    const b = annRecord({ id: "b", content: "B", timestamp: T_X });
    const c = annRecord({ id: "c", content: "C", timestamp: T_X });
    const doc = liveDoc({ a: { ...a }, b: { ...b }, c: { ...c } });
    const out = assign(doc, [{ ...a }, { ...b }, { ...c }]);
    expect(bodies(out.rows)).toEqual({ a: "A", b: "B", c: "C" });
    expect(out.moved).toBe(false);
  });

  it("an alias row beside its record goes to the aliased record's key", () => {
    const doc = liveDoc({ X: { ...X }, K: { ...K } });
    const out = assign(doc, [{ ...X }, { ...K, id: "X", rev: 5 }]);
    expect(bodies(out.rows)).toEqual({ X: "X body", K: "K body" });
    expect(out.rows.get("K")?.id).toBe("K");
    expect(out.quarantineIds.has("X")).toBe(true);
  });

  it("a key cycle routes each row to its own record (K stored as X, X stored as K)", () => {
    const doc = liveDoc({ X: { ...X }, K: { ...K } });
    const out = assign(doc, [
      { ...K, id: "X", rev: 9 },
      { ...X, id: "K", rev: 9 },
    ]);
    expect(bodies(out.rows)).toEqual({ K: "K body", X: "X body" });
  });

  it("indistinguishable twins at a duplicated id are both kept, at fresh keys, X untouched", () => {
    const twin = annRecord({ id: "X", content: "twin", timestamp: T_X });
    const doc = liveDoc({ X: { ...X } });
    const out = assign(doc, [
      { ...twin, rev: 9 },
      { ...twin, content: "twin 2", rev: 9 },
    ]);
    expect(out.rows.has("X")).toBe(false);
    expect([...out.rows.keys()].every(isFreshKey)).toBe(true);
    expect(out.rows.size).toBe(2);
  });

  it("a lone row whose id holds a different random-id record goes to a fresh key", () => {
    const doc = liveDoc({ X: { ...X } });
    const out = assign(doc, [{ ...K, id: "X", rev: 9 }]);
    expect(out.rows.has("X")).toBe(false);
    expect(out.rows.size).toBe(1);
    expect(out.quarantineIds.has("X")).toBe(true);
  });

  it("the ledger is the authority: a stale row of a repaired, since-deleted record still finds it", () => {
    const doc = liveDoc({ X: { ...X } });
    appendAliasLedger(doc, [
      {
        key: "K",
        storedId: "X",
        timestamp: T_K,
        textSnapshot: undefined,
        commentId: undefined,
        type: "note",
      },
    ]);
    const out = assignEnvelopeRows(
      envelope([{ ...K, id: "X", rev: 9 }]),
      doc.getMap(Y_MAP_ANNOTATIONS),
      [
        {
          key: "K",
          storedId: "X",
          timestamp: T_K,
          textSnapshot: undefined,
          commentId: undefined,
          type: "note",
        },
      ],
      HASH_A,
    );
    expect(bodies(out.rows)).toEqual({ K: "K body" });
  });

  it("an unreadable live value is replaced by the file copy, as before", () => {
    const doc = liveDoc({ X: "garbage" });
    const out = assign(doc, [{ ...X }]);
    expect(bodies(out.rows)).toEqual({ X: "X body" });
  });

  it("a live record the envelope's tombstone beats is no candidate", () => {
    const doomed = annRecord({ id: "dead", content: "dead", timestamp: T_X, rev: 2 });
    const doc = liveDoc({ dead: { ...doomed } });
    const file = makeAnnotationDoc(HASH_A, FILE_A, {
      annotations: [annRecord({ id: "keep", content: "keep", timestamp: T_X })],
      tombstones: [{ id: "dead", rev: 3, deletedAt: 1 }],
    });
    const out = assignEnvelopeRows(file, doc.getMap(Y_MAP_ANNOTATIONS), [], HASH_A);
    expect(bodies(out.rows)).toEqual({ keep: "keep" });
  });

  it("fresh keys are deterministic: a re-run against the same envelope gives the same keys", () => {
    const twin = annRecord({ id: "X", content: "twin", timestamp: T_X });
    const rows = [
      { ...twin, rev: 9 },
      { ...twin, content: "twin 2", rev: 9 },
    ];
    const first = [...assign(liveDoc({ X: { ...X } }), rows).rows.keys()].sort();
    const second = [...assign(liveDoc({ X: { ...X } }), rows).rows.keys()].sort();
    expect(second).toEqual(first);
  });

  it("a fresh key survives the envelope being rewritten in another order", () => {
    const stray = annRecord({ id: "X", content: "stray", timestamp: T_K, rev: 9 });
    const other = annRecord({ id: "o", content: "other", timestamp: T_X });
    const keyOf = (rows: AnnotationRecordV1[]) =>
      [...assign(liveDoc({ X: { ...X }, o: { ...other } }), rows).rows].find(
        ([, row]) => row.content === "stray",
      )?.[0];

    const before = keyOf([{ ...other }, { ...stray }]);
    expect(before !== undefined && isFreshKey(before)).toBe(true);
    expect(keyOf([{ ...stray }, { ...other }])).toBe(before);
  });

  it("an import comment row pairs with a live migrated import note only on an equal commentId", () => {
    const source = { author: "Ann", file: "review.docx" };
    const liveNote = annRecord({
      id: "import-a",
      author: "import",
      type: "note",
      content: "B's note",
      timestamp: T_X,
      importSource: { ...source, commentId: "2" },
    } as never);
    const doc = liveDoc({ "import-a": { ...liveNote } });
    const legacyRow = annRecord({
      id: "Q",
      author: "import",
      type: "comment",
      content: "A's comment",
      timestamp: T_X,
      importSource: { ...source, commentId: "1" },
    } as never);
    const out = assign(doc, [legacyRow]);
    expect(out.rows.has("import-a")).toBe(false);
  });
});

/**
 * Round 16: records indistinguishable on timestamp, type and snapshot ("twins")
 * in a key cycle, with NO ledger (after a restart). Each id appears once in the
 * file, so each row would claim its own id and the bodies would swap.
 */
describe("assignEnvelopeRows — indistinguishable twins, no ledger", () => {
  const twin = (id: string, content: string, rev: number) =>
    annRecord({ id, author: "user", type: "note", content, timestamp: T_X, rev });

  it("a 2-cycle never writes one twin's body over the other, and quarantines both ids", () => {
    const doc = liveDoc({ X: twin("X", "X body", 1), K: twin("K", "K body", 7) });
    // Row X holds K's body at a higher rev than live X; row K holds X's body.
    const out = assign(doc, [twin("X", "K body", 6), twin("K", "X body", 0)]);
    // The row the file would win with goes to a fresh key: duplicated, not
    // written over X. The row live wins against is a no-op claim.
    expect(out.rows.get("X")).toBeUndefined();
    expect(out.rows.get("K")?.content).toBe("X body");
    expect([...out.rows.keys()].filter(isFreshKey)).toHaveLength(1);
    expect(out.quarantineIds.has("X")).toBe(true);
    expect(out.quarantineIds.has("K")).toBe(true);
    expect(out.moved).toBe(true);
  });

  it("a 3-cycle at higher file revs rotates nothing onto a live record", () => {
    const doc = liveDoc({ A: twin("A", "A", 1), B: twin("B", "B", 1), C: twin("C", "C", 1) });
    const out = assign(doc, [twin("B", "A", 9), twin("C", "B", 9), twin("A", "C", 9)]);
    for (const key of ["A", "B", "C"]) expect(out.rows.has(key)).toBe(false);
    expect([...out.rows.keys()].every(isFreshKey)).toBe(true);
  });

  it("a chain with a distinguishable head moves no twin's body onto another", () => {
    const head = annRecord({ id: "C", content: "C", timestamp: T_K, rev: 1 });
    const doc = liveDoc({ C: { ...head }, B: twin("B", "B", 1), x: twin("x", "x", 1) });
    const out = assign(doc, [{ ...head }, twin("x", "B", 9), twin("B", "x", 9)]);
    expect(out.rows.get("C")?.content).toBe("C");
    expect(out.rows.has("B")).toBe(false);
    expect(out.rows.has("x")).toBe(false);
  });

  it("re-running against the unchanged envelope adds no further duplicate", () => {
    const doc = liveDoc({ X: twin("X", "X body", 1), K: twin("K", "K body", 7) });
    const rows = [twin("X", "K body", 6), twin("K", "X body", 0)];
    const first = assign(doc, rows);
    // Place run 1's fresh rows in the live map, as the merge would.
    withInternal(doc, () => {
      for (const [key, row] of first.rows)
        if (isFreshKey(key)) doc.getMap(Y_MAP_ANNOTATIONS).set(key, row);
    });
    const second = assign(doc, rows);
    expect([...second.rows.keys()].sort()).toEqual([...first.rows.keys()].sort());
  });
});

describe("assignEnvelopeRows — an own record whose snapshot contradicts the row", () => {
  it("round 17: a foreign body stored as X never overwrites X, and X's replies are quarantined", () => {
    // Live X: a private comment over "bravo". The old envelope holds K's body
    // stored as X (K since deleted, no ledger): outbound, over "alpha", newer.
    const liveX = annRecord({
      id: "X",
      author: "user",
      type: "comment",
      audience: "private",
      content: "X body",
      textSnapshot: "bravo",
      timestamp: T_X,
      rev: 1,
    } as never);
    const doc = liveDoc({ X: { ...liveX } });
    const out = assign(doc, [
      { ...liveX, audience: "outbound", content: "K body", textSnapshot: "alpha", rev: 6 } as never,
    ]);
    expect(out.rows.has("X")).toBe(false);
    expect([...out.rows.keys()].every(isFreshKey)).toBe(true);
    expect(out.quarantineIds.has("X")).toBe(true);
  });

  it("an own record whose snapshot merely went missing still merges onto X", () => {
    const liveX = annRecord({ id: "X", content: "X body", timestamp: T_X, rev: 1 });
    const doc = liveDoc({ X: { ...liveX } });
    const out = assign(doc, [{ ...liveX, textSnapshot: "bravo", rev: 3 } as never]);
    expect(out.rows.get("X")?.content).toBe("X body");
    expect(out.quarantineIds.has("X")).toBe(false);
  });
});

describe("assignEnvelopeRows — a row whose own record its tombstone beats", () => {
  it("targets its own id, where the tombstone deletes it, never a fresh key", () => {
    const doc = liveDoc({ X: { ...X, rev: 1 } });
    const file = makeAnnotationDoc(HASH_A, FILE_A, {
      annotations: [{ ...X, rev: 1 }],
      tombstones: [{ id: "X", rev: 4, deletedAt: 1 }],
    });
    const out = assignEnvelopeRows(file, doc.getMap(Y_MAP_ANNOTATIONS), [], HASH_A);
    expect([...out.rows.keys()]).toEqual(["X"]);
    expect(out.moved).toBe(false);
  });
});

describe("assignEnvelopeRows — marked envelopes", () => {
  it("merges by id, but a second row at one id never races: it goes to a fresh key", () => {
    const doc = liveDoc({ X: { ...X } });
    const out = assign(doc, [{ ...X }, { ...X, content: "hand-edited copy" }], true);
    expect(out.rows.get("X")?.content).toBe("X body");
    expect(out.rows.size).toBe(2);
    expect(out.oldFormat).toBe(false);
  });
});

describe("loadAndMerge — replies", () => {
  it("a file-only user reply under an ambiguous id is merged private", async () => {
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeAnnotationDoc(HASH_A, FILE_A, {
        annotations: [{ ...X }, { ...K, id: "X", rev: 5 }],
        replies: [replyRecord({ id: "r-note", annotationId: "X", author: "user", rev: 1 })],
      }),
    );
    await store0.flush();
    resetStoreForTesting();
    const doc = liveDoc({ X: { ...X }, K: { ...K } });

    const cleanup = await loadAndMerge({
      ydoc: doc,
      store: createStore(HASH_A, { filePath: FILE_A }),
      docHash: HASH_A,
      meta: { filePath: FILE_A },
    });

    expect(doc.getMap(Y_MAP_ANNOTATION_REPLIES).get("r-note")).toMatchObject({ private: true });
    cleanup("close");
  });

  it("round 16: a file-only note-thread reply under a twin cycle stays private, and the stamp is written", async () => {
    const twin = (id: string, content: string, rev: number, extra = {}) =>
      annRecord({ id, author: "user", type: "note", content, timestamp: T_X, rev, ...extra });
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeAnnotationDoc(HASH_A, FILE_A, {
        annotations: [twin("X", "N body", 1), twin("K", "C body", 1)],
        replies: [replyRecord({ id: "r1", annotationId: "X", author: "user", rev: 1 })],
      }),
    );
    await store0.flush();
    resetStoreForTesting();
    // Live already repaired (no ledger: a restart). X is now the promoted,
    // outbound comment C; K is the note N.
    const doc = liveDoc({
      X: twin("X", "C body", 5, { type: "comment", promotedFrom: "note", audience: "outbound" }),
      K: twin("K", "N body", 5),
    });
    const store = createStore(HASH_A, { filePath: FILE_A });
    const queued = vi.spyOn(store, "queueWrite");

    const cleanup = await loadAndMerge({
      ydoc: doc,
      store,
      docHash: HASH_A,
      meta: { filePath: FILE_A },
    });

    expect(doc.getMap(Y_MAP_ANNOTATION_REPLIES).get("r1")).toMatchObject({ private: true });
    expect(queued).toHaveBeenCalled();
    cleanup("close");
  });

  it("sticky private: a stale non-private file copy with a higher rev cannot undo a quarantine", async () => {
    const store0 = createStore(HASH_A, { filePath: FILE_A });
    store0.queueWrite(() =>
      makeAnnotationDoc(HASH_A, FILE_A, {
        annotations: [{ ...X }],
        replies: [
          replyRecord({ id: "r1", annotationId: "X", author: "user", rev: 7, editedAt: 99 }),
        ],
      }),
    );
    await store0.flush();
    resetStoreForTesting();
    const doc = liveDoc({ X: { ...X } });
    withInternal(doc, () =>
      doc
        .getMap(Y_MAP_ANNOTATION_REPLIES)
        .set(
          "r1",
          replyRecord({ id: "r1", annotationId: "X", author: "user", rev: 2, private: true }),
        ),
    );

    const cleanup = await loadAndMerge({
      ydoc: doc,
      store: createStore(HASH_A, { filePath: FILE_A }),
      docHash: HASH_A,
      meta: { filePath: FILE_A },
    });

    expect(doc.getMap(Y_MAP_ANNOTATION_REPLIES).get("r1")).toMatchObject({
      private: true,
      rev: 8,
    });
    cleanup("close");
  });
});
