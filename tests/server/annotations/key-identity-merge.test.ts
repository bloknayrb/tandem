/**
 * The annotation envelope on disk keeps each record under its Y.Map key.
 *
 * `snapshot()` used to persist `value.id`, so a record stored under key K with
 * `id: X` reached disk as X, and the next `loadAndMerge` (which keys file rows
 * by id, last one wins) wrote K's body over the record really stored at X.
 *
 * REGRESSION tests here use only APIs that exist on master. Old-format
 * envelopes are literal fixtures, never produced by the branch's `snapshot()`,
 * which would mark them and take the new-format path.
 */

import fs from "node:fs/promises";
import path from "node:path";
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

import { resetMigrationLog } from "../../../src/server/annotations/migration-log.js";
import type { AnnotationRecordV1 } from "../../../src/server/annotations/schema.js";
import type { DocStore } from "../../../src/server/annotations/store.js";
import {
  createStore,
  resetForTesting as resetStoreForTesting,
} from "../../../src/server/annotations/store.js";
import {
  loadAndMerge,
  registerAnnotationObserver,
  resetForTesting,
  type SyncContext,
} from "../../../src/server/annotations/sync.js";
import { Y_MAP_ANNOTATIONS } from "../../../src/shared/constants.js";
import { withMcp } from "../../../src/shared/origins.js";
import { annRecord, FILE_A, HASH_A, makeAnnotationDoc } from "../../helpers/annotation-fixtures.js";
import { useTmpAnnotationsEnvWithFlag } from "../../helpers/annotation-store-env.js";

const env = useTmpAnnotationsEnvWithFlag("tandem-key-identity-");

function syncCtx(ydoc: Y.Doc, store: DocStore): SyncContext {
  return { ydoc, store, docHash: HASH_A, meta: { filePath: FILE_A } };
}

async function readEnvelope(): Promise<{
  annotations: AnnotationRecordV1[];
  meta: Record<string, unknown>;
}> {
  const raw = await fs.readFile(path.join(env.tmpRoot, "annotations", `${HASH_A}.json`), "utf-8");
  return JSON.parse(raw);
}

/** Write a literal (old-format, unmarked) envelope to disk. */
async function writeOldEnvelope(annotations: AnnotationRecordV1[]): Promise<void> {
  const store = createStore(HASH_A, { filePath: FILE_A });
  store.queueWrite(() => makeAnnotationDoc(HASH_A, FILE_A, { annotations }));
  await store.flush();
  resetStoreForTesting();
}

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

const COMMENT_X = annRecord({
  id: "X",
  author: "claude",
  type: "comment",
  content: "the real comment at X",
  timestamp: 1_700_000_000_000,
  rev: 1,
});
const NOTE_K = annRecord({
  id: "K",
  author: "user",
  type: "note",
  content: "a private note",
  range: { from: 6, to: 11 },
  timestamp: 1_700_000_500_000,
  rev: 1,
});

describe("snapshot() persists each record under its map key", () => {
  it("REGRESSION: a record stored under K with id X reaches disk as K", async () => {
    const ydoc = new Y.Doc();
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = registerAnnotationObserver(syncCtx(ydoc, store));
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);

    withMcp(ydoc, () => {
      map.set("X", { ...COMMENT_X });
      map.set("K", { ...NOTE_K, id: "X" });
    });
    await store.flush();

    const ids = (await readEnvelope()).annotations.map((a) => a.id).sort();
    expect(ids).toEqual(["K", "X"]);
    cleanup("close");
  });
});

describe("loadAndMerge never writes one record's old row over another", () => {
  it("REGRESSION: an old envelope holding K's row under id X (higher rev, last) leaves X intact", async () => {
    // The old snapshot() wrote K's note as id X, beside X's own row.
    await writeOldEnvelope([{ ...COMMENT_X }, { ...NOTE_K, id: "X", rev: 5 }]);

    // The live map already holds both records under their own keys.
    const ydoc = new Y.Doc();
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    map.set("X", { ...COMMENT_X });
    map.set("K", { ...NOTE_K });

    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    const x = map.get("X") as AnnotationRecordV1;
    expect(x.type).toBe("comment");
    expect(x.content).toBe("the real comment at X");
    // K keeps its note; nothing is lost.
    expect((map.get("K") as AnnotationRecordV1).content).toBe("a private note");
    cleanup("close");
  });

  it("REGRESSION: with no live state, both rows of a duplicated id survive", async () => {
    await writeOldEnvelope([{ ...COMMENT_X }, { ...NOTE_K, id: "X", rev: 5 }]);

    const ydoc = new Y.Doc();
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const store = createStore(HASH_A, { filePath: FILE_A });
    const cleanup = await loadAndMerge(syncCtx(ydoc, store));

    const contents = [...map.values()].map((v) => (v as AnnotationRecordV1).content).sort();
    expect(contents).toEqual(["a private note", "the real comment at X"]);
    cleanup("close");
  });
});
