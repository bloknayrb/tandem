/**
 * #1813 / decision C: force-open (`tandem_open force: true`) and the source-view
 * commit clear only the IN-MEMORY annotation map. The durable envelope
 * `<annotations-dir>/<docHash>.json` survives — `clearAndReload` flushes it
 * rather than unlinking it — and the caller's `wireAnnotationStore` ->
 * `loadAndMerge` brings every record back, re-anchored by `refreshRange`.
 *
 * ISOLATION IS THE FIRST LINE OF THIS FILE. These specs write real envelopes
 * and, before the fix, unlinked them. `useTmpAnnotationsEnvWithFlag` gives each
 * test its own `TANDEM_APP_DATA_DIR` *and* deletes an inherited
 * `TANDEM_ANNOTATION_STORE`: without the tmpdir the suite would destroy the
 * developer's real store, and with the flag set to "off" every store op is
 * inert and every spec below passes VACUOUSLY against unfixed code. The
 * "the store is actually on" assertion in `seedAndFlush` is what makes a
 * disabled store fail the suite instead of greening it.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";

vi.mock("../../src/server/notifications.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/notifications.js")>();
  return { ...actual, pushNotification: vi.fn() };
});

const watcherMocks = vi.hoisted(() => ({ watchFile: vi.fn() }));
vi.mock("../../src/server/file-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: watcherMocks.watchFile,
}));

import { docHash } from "../../src/server/annotations/doc-hash.js";
import { envelopePath, resetForTesting } from "../../src/server/annotations/store.js";
import { openFromDisk } from "../../src/server/documents/open.js";
import { clearAndReload } from "../../src/server/documents/populate.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { reloadDocumentFromMarkdown } from "../../src/server/documents/reload-family.js";
import { docIdFromPath, extractText } from "../../src/server/mcp/document-model.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { anchoredRange, refreshRange } from "../../src/server/positions.js";
import { stopAutoSave } from "../../src/server/session/manager.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { MCP_ORIGIN } from "../../src/shared/origins.js";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import type { Annotation, AnnotationType } from "../../src/shared/types.js";
import { makeAnnotationDoc, writeEnvelopeToDisk } from "../helpers/annotation-fixtures.js";
import { useTmpAnnotationsEnvWithFlag } from "../helpers/annotation-store-env.js";

useTmpAnnotationsEnvWithFlag("tandem-force-open-");

const CONTENT = "# Title\n\nThe quick brown fox jumps.\n\nA second paragraph here.\n";

let tmpDir: string;

beforeEach(async () => {
  // `annotationsDirReady` is a module-level marker, so without this the SECOND
  // spec's fresh tmpdir is never mkdir'd and every write fails with ENOENT.
  resetForTesting();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-force-open-doc-"));
});

afterEach(async () => {
  stopAutoSave();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

/** Write an annotation into the live Y.Map the way an MCP write does. */
function seed(doc: Y.Doc, snapshot: string, type: AnnotationType, author: "user" | "claude") {
  const text = extractText(doc);
  const idx = text.indexOf(snapshot);
  if (idx < 0) throw new Error(`snapshot "${snapshot}" not found in ${JSON.stringify(text)}`);
  const result = anchoredRange(
    doc,
    toFlatOffset(idx),
    toFlatOffset(idx + snapshot.length),
    snapshot,
  );
  if (!result.ok) throw new Error("anchoredRange failed");
  const id = `ann_${type}_${Math.random().toString(36).slice(2, 8)}`;
  const ann: Annotation = {
    id,
    author,
    type,
    range: result.range,
    ...(result.fullyAnchored ? { relRange: result.relRange } : {}),
    content: `seeded ${type}`,
    status: "pending",
    timestamp: Date.now(),
    textSnapshot: snapshot,
    rev: 1,
  };
  doc.transact(() => doc.getMap<Annotation>(Y_MAP_ANNOTATIONS).set(id, ann), MCP_ORIGIN);
  return id;
}

/** Let the store's 100ms debounce fire, then prove the envelope really exists. */
async function settleEnvelope(filePath: string): Promise<string> {
  const target = envelopePath(docHash(filePath));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 25));
    if (
      await fs
        .stat(target)
        .then(() => true)
        .catch(() => false)
    ) {
      return target;
    }
  }
  throw new Error(`envelope never written at ${target} — is TANDEM_ANNOTATION_STORE off?`);
}

async function openDoc(content = CONTENT) {
  const filePath = path.join(tmpDir, "doc.md");
  await fs.writeFile(filePath, content, "utf-8");
  await openFromDisk(filePath);
  const id = docIdFromPath(filePath);
  return { filePath, id, doc: getOrCreateDocument(id) };
}

/** Every annotation currently in the Y.Map. */
function records(doc: Y.Doc): Annotation[] {
  return [...doc.getMap<Annotation>(Y_MAP_ANNOTATIONS).values()];
}

describe("force-open keeps the durable annotation envelope (#1813)", () => {
  it("records come back over the SAME text they annotated, not merely by id", async () => {
    const { filePath, id, doc } = await openDoc();
    seed(doc, "brown fox", "comment", "claude");
    seed(doc, "second paragraph", "note", "user");
    const envelope = await settleEnvelope(filePath);

    await openFromDisk(filePath, { force: true });

    // The unlink is gone: the file is still there for `loadAndMerge` to read.
    await expect(fs.stat(envelope)).resolves.toBeTruthy();

    const live = getOrCreateDocument(id);
    const back = records(live);
    expect(back).toHaveLength(2);

    // A membership-only assertion passes even if every record lands at a wrong
    // offset — the live hazard now that the ungated `updated` arm is reachable
    // on this path. Assert the recovered SPAN instead.
    const text = extractText(live);
    for (const ann of back) {
      const refreshed = refreshRange(ann, live);
      expect(refreshed.kind).not.toBe("failed");
      const r = refreshed.annotation.range;
      expect(text.slice(r.from, r.to)).toBe(ann.textSnapshot);
    }
  });

  it("the personal NOTE specifically survives — the loss this issue is about", async () => {
    // Asserted apart from the comment: notes are ADR-027 personal data, and a
    // read filter hiding them would let a comments-only assertion pass.
    const { filePath, id, doc } = await openDoc();
    const noteId = seed(doc, "second paragraph", "note", "user");
    await settleEnvelope(filePath);

    await openFromDisk(filePath, { force: true });

    const live = getOrCreateDocument(id);
    const note = live.getMap<Annotation>(Y_MAP_ANNOTATIONS).get(noteId);
    expect(note).toBeDefined();
    expect(note?.type).toBe("note");
    const text = extractText(live);
    expect(text.slice(note?.range.from ?? 0, note?.range.to ?? 0)).toBe("second paragraph");
  });

  it("the source-view commit keeps them too — the path where the user just edited", async () => {
    // Both callers share the changed line, but only a two-caller test proves
    // the path where the text itself was rewritten by the user.
    const { filePath, id, doc } = await openDoc();
    const annId = seed(doc, "brown fox", "comment", "claude");
    const envelope = await settleEnvelope(filePath);

    await reloadDocumentFromMarkdown(
      id,
      "# Title\n\nThe quick brown fox jumps.\n\nAn edited second paragraph.\n",
    );

    await expect(fs.stat(envelope)).resolves.toBeTruthy();
    const live = getOrCreateDocument(id);
    const ann = live.getMap<Annotation>(Y_MAP_ANNOTATIONS).get(annId);
    expect(ann).toBeDefined();
    const text = extractText(live);
    expect(text.slice(ann?.range.from ?? 0, ann?.range.to ?? 0)).toBe("brown fox");
  });

  it("a record whose span is gone comes back degraded, with relRange stripped", async () => {
    const { filePath, id, doc } = await openDoc();
    const annId = seed(doc, "brown fox", "comment", "claude");
    const stored = doc.getMap<Annotation>(Y_MAP_ANNOTATIONS).get(annId);
    const storedRange = { ...(stored?.range as { from: number; to: number }) };
    await settleEnvelope(filePath);

    await fs.writeFile(filePath, "# Title\n\nNothing like the original.\n", "utf-8");
    await openFromDisk(filePath, { force: true });

    const live = getOrCreateDocument(id);
    const ann = live.getMap<Annotation>(Y_MAP_ANNOTATIONS).get(annId);
    expect(ann).toBeDefined();
    const refreshed = refreshRange(ann as Annotation, live);
    expect(refreshed.kind).toBe("degraded");
    // The flat range survives for relocation and undo...
    expect(refreshed.annotation.range).toEqual(storedRange);
    // ...but a dead RelativePosition is stripped, never preserved: a stale one
    // resolving to null blocks the lazy re-attachment recovery path. Asserting
    // "relRange intact" here would drive an implementer the wrong way.
    expect(refreshed.annotation.relRange).toBeUndefined();
  });
});

describe("the pending durable write is flushed, and the flush's own window is closed (#1813)", () => {
  /** Read the envelope JSON off disk. */
  async function readEnvelope(filePath: string) {
    return JSON.parse(await fs.readFile(envelopePath(docHash(filePath)), "utf-8")) as {
      annotations: unknown[];
      tombstones: { id: string }[];
    };
  }

  it("a write queued BEFORE the reload lands non-empty AND keeps the seeded tombstone", async () => {
    // (b) is what pins the ORDER rather than leaving it incidental: flushing
    // AFTER `clearFileSyncContext`'s "close" phase reads an emptied ledger and
    // writes `tombstones: []` — a full clobber that erases every historical
    // tombstone and re-opens the Word-comment resurrection window. (a) alone
    // cannot see that.
    const filePath = path.join(tmpDir, "doc.md");
    await fs.writeFile(filePath, CONTENT, "utf-8");
    await writeEnvelopeToDisk(
      makeAnnotationDoc(docHash(filePath), filePath, {
        tombstones: [{ id: "ann_deleted_word_comment", rev: 3, deletedAt: Date.now() }],
      }),
    );
    await openFromDisk(filePath);
    const id = docIdFromPath(filePath);
    const doc = getOrCreateDocument(id);
    const existing = getOpenDocs().get(id);
    if (!existing) throw new Error("document not registered");

    // Freeze the debounce so the queued write is still PENDING when the reload
    // runs — the whole point of the flush. Real fs I/O does not need timers.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      seed(doc, "brown fox", "comment", "claude");
      await clearAndReload(id, doc, filePath, "md", existing, CONTENT);
      vi.advanceTimersByTime(500);
      await vi.runOnlyPendingTimersAsync();
    } finally {
      vi.useRealTimers();
    }
    await new Promise((r) => setTimeout(r, 50));

    const envelope = await readEnvelope(filePath);
    expect(envelope.annotations).toHaveLength(1);
    expect(envelope.tombstones.map((t) => t.id)).toContain("ann_deleted_word_comment");
  });

  it("a write queued from INSIDE the flush's await is cancelled, not left to clobber", async () => {
    // The case the first cannot see, and the one that fails against a
    // flush-only fix: `flushOne` awaits real disk I/O with the annotation
    // observer STILL ATTACHED, so a mutation landing mid-flush arms a fresh
    // DEBOUNCE_MS timer. `clearFileSyncContext` never touches `pending`, and
    // the only canceller used to be the `store.clear()` this fix removes — so
    // that timer would fire after `clearDocMaps`, snapshot the emptied
    // `Y.Map('annotations')` and clobber the envelope to zero annotations.
    const filePath = path.join(tmpDir, "doc.md");
    await fs.writeFile(filePath, CONTENT, "utf-8");
    await openFromDisk(filePath);
    const id = docIdFromPath(filePath);
    const doc = getOrCreateDocument(id);
    const existing = getOpenDocs().get(id);
    if (!existing) throw new Error("document not registered");

    const annId = seed(doc, "brown fox", "comment", "claude");
    await settleEnvelope(filePath);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Mutate from inside the flush's write, exactly once.
      let fired = false;
      const realWrite = fs.writeFile;
      const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        if (!fired) {
          fired = true;
          const map = doc.getMap<Annotation>(Y_MAP_ANNOTATIONS);
          const ann = map.get(annId) as Annotation;
          doc.transact(() => map.set(annId, { ...ann, content: "mutated mid-flush" }), MCP_ORIGIN);
        }
        return realWrite.apply(fs, args as never);
      });

      // A fresh mutation so there IS a pending write for the flush to run.
      const map = doc.getMap<Annotation>(Y_MAP_ANNOTATIONS);
      const seeded = map.get(annId) as Annotation;
      doc.transact(() => map.set(annId, { ...seeded, content: "pre-reload" }), MCP_ORIGIN);

      await clearAndReload(id, doc, filePath, "md", existing, CONTENT);
      spy.mockRestore();
      // The document is now in the window the hazard lives in: Y.Maps cleared,
      // `wireAnnotationStore` not yet called. Let any surviving timer fire.
      vi.advanceTimersByTime(500);
      await vi.runOnlyPendingTimersAsync();
    } finally {
      vi.useRealTimers();
    }
    await new Promise((r) => setTimeout(r, 50));

    expect((await readEnvelope(filePath)).annotations).toHaveLength(1);
  });
});
