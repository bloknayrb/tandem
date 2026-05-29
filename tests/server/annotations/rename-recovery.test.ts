/**
 * Tests for rename recovery (#313) and the cross-cutting tombstone-survives-
 * rename failure mode shared with #318.
 *
 * Real Y.Doc instances + a real DocStore backed by a per-test tempdir via
 * `TANDEM_APP_DATA_DIR`. The recovery path runs over actual on-disk envelopes.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/server/notifications.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, pushNotification: vi.fn() };
});

import { contentHash, docHash } from "../../../src/server/annotations/doc-hash.js";
import { recoverRenamedEnvelope } from "../../../src/server/annotations/rename-recovery.js";
import { type AnnotationDocV1, SCHEMA_VERSION } from "../../../src/server/annotations/schema.js";
import {
  createStore,
  resetForTesting as resetStoreForTesting,
} from "../../../src/server/annotations/store.js";
import {
  getTombstones,
  loadAndMerge,
  resetForTesting as resetSyncForTesting,
} from "../../../src/server/annotations/sync.js";
import { extractText } from "../../../src/server/mcp/document-model.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../../src/shared/constants.js";
import { annRecord, replyRecord } from "../../helpers/annotation-fixtures.js";
import { useTmpAnnotationsEnvWithFlag } from "../../helpers/annotation-store-env.js";
import { makeDoc } from "../../helpers/ydoc-factory.js";

const env = useTmpAnnotationsEnvWithFlag("tandem-rename-recovery-");

function annotationsDir(): string {
  return path.join(env.tmpRoot, "annotations");
}

async function writeEnvelope(envelope: AnnotationDocV1): Promise<void> {
  const dir = annotationsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${envelope.docHash}.json`), JSON.stringify(envelope), "utf-8");
}

async function readEnvelope(hash: string): Promise<AnnotationDocV1 | null> {
  try {
    const raw = await fs.readFile(path.join(annotationsDir(), `${hash}.json`), "utf-8");
    return JSON.parse(raw) as AnnotationDocV1;
  } catch {
    return null;
  }
}

function buildEnvelope(
  oldPath: string,
  text: string,
  overrides: Partial<AnnotationDocV1> = {},
): AnnotationDocV1 {
  return {
    schemaVersion: SCHEMA_VERSION,
    docHash: docHash(oldPath),
    meta: { filePath: oldPath, lastUpdated: Date.now(), contentHash: contentHash(text) },
    annotations: [annRecord({ rev: 2 })],
    tombstones: [],
    replies: [],
    ...overrides,
  };
}

beforeEach(() => {
  resetStoreForTesting();
  resetSyncForTesting();
});

afterEach(() => {
  resetStoreForTesting();
  resetSyncForTesting();
});

describe("recoverRenamedEnvelope", () => {
  it("re-keys an orphaned envelope when content matches and the old path is gone", async () => {
    const body = "The quick brown fox jumps over the lazy dog.";
    // Old path never created on disk → it's "gone" → rename signal present.
    const oldPath = path.join(env.tmpRoot, "old-name.md");
    await writeEnvelope(buildEnvelope(oldPath, body));

    const newPath = path.join(env.tmpRoot, "new-name.md");
    const newHash = docHash(newPath);
    const doc = makeDoc(body);
    expect(contentHash(extractText(doc))).toBe(contentHash(body));

    const recovered = await recoverRenamedEnvelope(doc, newHash, newPath);
    expect(recovered).toBe(true);

    // New-hash envelope now exists; old-hash envelope unlinked.
    const newEnvelope = await readEnvelope(newHash);
    expect(newEnvelope).not.toBeNull();
    expect(newEnvelope?.annotations).toHaveLength(1);
    expect(newEnvelope?.meta.filePath).toBe(newPath);
    expect(await readEnvelope(docHash(oldPath))).toBeNull();

    // Annotations were injected into the Y.Doc.
    expect(doc.getMap(Y_MAP_ANNOTATIONS).size).toBe(1);
  });

  it("does NOT steal annotations when the old path still exists (copy, not rename)", async () => {
    const body = "Shared identical content across two files.";
    // Old path EXISTS on disk → copy semantics → must not steal.
    const oldPath = path.join(env.tmpRoot, "original.md");
    await fs.writeFile(oldPath, body, "utf-8");
    await writeEnvelope(buildEnvelope(oldPath, body));

    const newPath = path.join(env.tmpRoot, "copy.md");
    const newHash = docHash(newPath);
    const doc = makeDoc(body);

    const recovered = await recoverRenamedEnvelope(doc, newHash, newPath);
    expect(recovered).toBe(false);
    expect(await readEnvelope(newHash)).toBeNull(); // nothing re-keyed
    expect(await readEnvelope(docHash(oldPath))).not.toBeNull(); // original intact
    expect(doc.getMap(Y_MAP_ANNOTATIONS).size).toBe(0); // no injection
  });

  it("does NOT unlink the old envelope when the store feature is disabled (TANDEM_ANNOTATION_STORE=off)", async () => {
    // Feature-off makes queueWrite/flush inert no-ops AND annotationFileExists
    // short-circuit to false (so recovery is entered). Without a feature-flag
    // guard, recovery would inject + unlink the old envelope with no durable
    // re-keyed copy — silent data loss. Recovery must bail before mutating.
    const body = "Content present in an orphaned envelope, store turned off.";
    const oldPath = path.join(env.tmpRoot, "renamed-while-off.md");
    await writeEnvelope(buildEnvelope(oldPath, body));

    const newPath = path.join(env.tmpRoot, "now-open.md");
    const newHash = docHash(newPath);
    const doc = makeDoc(body);

    process.env.TANDEM_ANNOTATION_STORE = "off";
    const recovered = await recoverRenamedEnvelope(doc, newHash, newPath);

    expect(recovered).toBe(false);
    // Old envelope still on disk (not unlinked), nothing re-keyed, no injection.
    expect(await readEnvelope(docHash(oldPath))).not.toBeNull();
    expect(await readEnvelope(newHash)).toBeNull();
    expect(doc.getMap(Y_MAP_ANNOTATIONS).size).toBe(0);
  });

  it("skips empty/whitespace documents (every new file collides on the empty hash)", async () => {
    const emptyDoc = makeDoc("");
    const newPath = path.join(env.tmpRoot, "fresh.md");
    const recovered = await recoverRenamedEnvelope(emptyDoc, docHash(newPath), newPath);
    expect(recovered).toBe(false);
  });

  it("unlinks by FILENAME, not the envelope's internal docHash (path-safe)", async () => {
    const body = "Envelope whose internal docHash disagrees with its filename.";
    const oldPath = path.join(env.tmpRoot, "diverged.md");
    const fileHash = docHash(oldPath);

    // Write the envelope at its real filename (`<fileHash>.json`) but with a
    // bogus, non-hex internal docHash (a path-traversal attempt). Recovery must
    // unlink the real filename and never touch the bogus path.
    const dir = annotationsDir();
    await fs.mkdir(dir, { recursive: true });
    const envelope = buildEnvelope(oldPath, body, { docHash: "../escaped" });
    await fs.writeFile(path.join(dir, `${fileHash}.json`), JSON.stringify(envelope), "utf-8");

    const newPath = path.join(env.tmpRoot, "diverged-renamed.md");
    const newHash = docHash(newPath);
    const doc = makeDoc(body);

    const recovered = await recoverRenamedEnvelope(doc, newHash, newPath);
    expect(recovered).toBe(true);

    // Re-keyed to the new hash; the real source file (by filename) was removed.
    expect(await readEnvelope(newHash)).not.toBeNull();
    expect(await readEnvelope(fileHash)).toBeNull();
    // No stray file escaped the annotations dir.
    expect(await readEnvelope("../escaped")).toBeNull();
  });

  it("refuses to re-key on an ambiguous (non-unique) content-hash match", async () => {
    const body = "Two orphaned envelopes, identical bodies.";
    const oldA = path.join(env.tmpRoot, "gone-a.md");
    const oldB = path.join(env.tmpRoot, "gone-b.md");
    await writeEnvelope(buildEnvelope(oldA, body));
    await writeEnvelope(buildEnvelope(oldB, body));

    const newPath = path.join(env.tmpRoot, "renamed.md");
    const doc = makeDoc(body);
    const recovered = await recoverRenamedEnvelope(doc, docHash(newPath), newPath);
    expect(recovered).toBe(false);
  });

  it("rename with a pending tombstone + reply: deletion still sticks and reply survives after reopen", async () => {
    const body = "Document body that survives the rename intact.";
    const oldPath = path.join(env.tmpRoot, "before-rename.md");

    // Envelope carries: one alive annotation (ann_keep), a tombstone for a
    // deleted annotation (ann_dead @ rev 3), and a reply to the alive one.
    const envelope = buildEnvelope(oldPath, body, {
      annotations: [annRecord({ id: "ann_keep", rev: 1 })],
      tombstones: [{ id: "ann_dead", rev: 3, deletedAt: Date.now() }],
      replies: [replyRecord({ id: "rep_1", annotationId: "ann_keep", rev: 1 })],
    });
    await writeEnvelope(envelope);

    const newPath = path.join(env.tmpRoot, "after-rename.md");
    const newHash = docHash(newPath);
    const doc = makeDoc(body);

    // Simulate a stale tab having re-added the deleted annotation BEFORE merge
    // — recovery + loadAndMerge must re-bury it via the tombstone.
    doc.getMap(Y_MAP_ANNOTATIONS).set("ann_dead", annRecord({ id: "ann_dead", rev: 2 }));

    const recovered = await recoverRenamedEnvelope(doc, newHash, newPath);
    expect(recovered).toBe(true);

    // Tombstone was seeded under the NEW hash.
    expect(getTombstones(newHash).find((s) => s.id === "ann_dead")?.rev).toBe(3);

    // loadAndMerge applies the tombstone (rev 3 > resurrected rev 2) → deleted.
    const store = createStore(newHash, { filePath: newPath });
    await loadAndMerge({ ydoc: doc, store, docHash: newHash, meta: { filePath: newPath } });

    const annMap = doc.getMap(Y_MAP_ANNOTATIONS);
    const repMap = doc.getMap(Y_MAP_ANNOTATION_REPLIES);
    expect(annMap.has("ann_dead")).toBe(false); // deletion stuck through rename
    expect(annMap.has("ann_keep")).toBe(true); // alive annotation survived
    expect(repMap.has("rep_1")).toBe(true); // reply survived

    // Tombstone persisted to the new-hash envelope on disk.
    await store.flush();
    const persisted = await readEnvelope(newHash);
    expect(persisted?.tombstones.find((t) => t.id === "ann_dead")?.rev).toBe(3);
  });
});
