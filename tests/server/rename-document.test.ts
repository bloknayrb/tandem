import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS, Y_MAP_DOCUMENT_META } from "../../src/shared/constants.js";
import { withBrowser, withInternal } from "../../src/shared/origins.js";

// Mock the session manager — saveSession/deleteSession touch disk for the
// .tandem session sidecar, which is orthogonal to what these tests exercise.
vi.mock("../../src/server/session/manager.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    saveSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    stopAutoSave: vi.fn(),
  };
});

// Mock the file watcher — real fs.watch on temp files leaks handles and races
// the rename's own delete/create events. The rename logic only needs these to
// be callable; their fs side effects are not under test.
vi.mock("../../src/server/file-watcher.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    watchFile: vi.fn(),
    unwatchFile: vi.fn(),
    suppressNextChange: vi.fn(),
  };
});

// Mock notifications — the error path calls pushNotification; assert via the spy.
vi.mock("../../src/server/notifications.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    pushNotification: vi.fn(),
  };
});

// Real modules (NOT mocked) — the durable-annotation envelope round-trip + the
// tombstone observer must actually run on disk for the regression tests.
const fsReal = await import("node:fs/promises");
const { renameDocument, closeDocumentById } = await import(
  "../../src/server/mcp/document-service.js"
);
const { addDoc, removeDoc } = await import("../../src/server/documents/registry.js");
const { getOpenDocs, setActiveDocId } = await import("../../src/server/mcp/document-service.js");
const { getOrCreateDocument } = await import("../../src/server/yjs/provider.js");
const { docHash } = await import("../../src/server/annotations/doc-hash.js");
const {
  createStore,
  envelopePath,
  resetForTesting: storeReset,
} = await import("../../src/server/annotations/store.js");
const { getTombstones, resetForTesting: syncReset } = await import(
  "../../src/server/annotations/sync.js"
);
const {
  attachObservers,
  clearFileSyncContext,
  detachObservers,
  resetForTesting: queueReset,
} = await import("../../src/server/events/queue.js");
const { wireAnnotationStore } = await import("../../src/server/mcp/file-opener.js");
const { getDocumentStore } = await import("../../src/server/mcp/document-store.js");
const { collectEvents } = await import("../helpers/event-collector.js");

let docDir = "";
let appData = "";
let prevAppData: string | undefined;
let counter = 0;

beforeEach(async () => {
  prevAppData = process.env.TANDEM_APP_DATA_DIR;
  appData = await fsReal.mkdtemp(path.join(os.tmpdir(), "tandem-rename-appdata-"));
  docDir = await fsReal.mkdtemp(path.join(os.tmpdir(), "tandem-rename-docs-"));
  process.env.TANDEM_APP_DATA_DIR = appData;
  storeReset();
  syncReset();
  queueReset();
});

afterEach(async () => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  storeReset();
  syncReset();
  queueReset();
  if (prevAppData === undefined) delete process.env.TANDEM_APP_DATA_DIR;
  else process.env.TANDEM_APP_DATA_DIR = prevAppData;
  await fsReal.rm(appData, { recursive: true, force: true }).catch(() => {});
  await fsReal.rm(docDir, { recursive: true, force: true }).catch(() => {});
});

/** Create a real on-disk file + register + populate an open "file" doc for it. */
async function openFileDoc(
  basename: string,
  body: string,
  opts: { readOnly?: boolean; source?: "file" | "upload"; wire?: boolean } = {},
): Promise<{ docId: string; filePath: string; doc: Y.Doc }> {
  const filePath = path.join(docDir, basename);
  await fsReal.writeFile(filePath, body, "utf-8");
  const docId = `rename-doc-${counter++}`;
  addDoc(docId, {
    id: docId,
    filePath,
    format: "md",
    readOnly: opts.readOnly ?? false,
    source: opts.source ?? "file",
  });
  setActiveDocId(docId);

  const doc = getOrCreateDocument(docId);
  const frag = doc.getXmlFragment("default");
  const p = new Y.XmlElement("paragraph");
  frag.insert(frag.length, [p]);
  p.insert(0, [new Y.XmlText(body)]);

  if (opts.wire !== false) {
    await wireAnnotationStore(docId, doc, filePath, { allowRecovery: false });
  }
  return { docId, filePath, doc };
}

function makeAnnotation(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: "comment",
    author: "user",
    content: `content for ${id}`,
    range: { from: 0, to: 4 },
    status: "pending",
    timestamp: 1_700_000_000_000,
    rev: 1,
    ...overrides,
  };
}

const fileExists = (p: string) =>
  fsReal
    .access(p)
    .then(() => true)
    .catch(() => false);

describe("renameDocument — validation rejections (no mutation)", () => {
  it("rejects an unknown documentId with NOT_FOUND", async () => {
    const result = await renameDocument("ghost", "x.md");
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("NOT_FOUND");
  });

  it("rejects a read-only doc with READ_ONLY", async () => {
    const { docId, filePath } = await openFileDoc("ro.md", "hello", {
      readOnly: true,
      wire: false,
    });
    const result = await renameDocument(docId, "renamed.md");
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("READ_ONLY");
    expect(await fileExists(filePath)).toBe(true); // untouched
  });

  it("rejects a non-file (upload/scratchpad) doc with NOT_RENAMABLE", async () => {
    const { docId } = await openFileDoc("scratch.md", "hello", {
      source: "upload",
      wire: false,
    });
    const result = await renameDocument(docId, "renamed.md");
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("NOT_RENAMABLE");
  });

  it("rejects an invalid filename (NTFS ADS bypass) with INVALID_NAME", async () => {
    const { docId } = await openFileDoc("note.md", "hello");
    const result = await renameDocument(docId, "evil:stream.md");
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("INVALID_NAME");
  });

  it("rejects an extension change with EXTENSION_MISMATCH", async () => {
    const { docId } = await openFileDoc("note.md", "hello");
    const result = await renameDocument(docId, "note.txt");
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("EXTENSION_MISMATCH");
  });

  it("accepts a case-only extension change (note.md → note.MD passes ext-equality)", async () => {
    // The extension check is case-insensitive; this must NOT be EXTENSION_MISMATCH.
    // (On a case-insensitive FS the same-inode exists-guard then rejects it as
    // ALREADY_EXISTS — the point here is the extension gate doesn't fire.)
    const { docId } = await openFileDoc("note.md", "hello");
    const result = await renameDocument(docId, "NOTE.MD");
    expect(result.errorCode).not.toBe("EXTENSION_MISMATCH");
  });

  it("rejects renaming onto an existing file with ALREADY_EXISTS", async () => {
    const { docId } = await openFileDoc("note.md", "hello");
    await fsReal.writeFile(path.join(docDir, "taken.md"), "other", "utf-8");
    const result = await renameDocument(docId, "taken.md");
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("ALREADY_EXISTS");
  });
});

describe("renameDocument — happy path", () => {
  it("renames the file on disk, keeps the documentId, updates meta.fileName", async () => {
    const { docId, filePath } = await openFileDoc("original.md", "the body text");
    const newPath = path.join(docDir, "renamed.md");

    const result = await renameDocument(docId, "renamed.md");

    expect(result.status).toBe("renamed");
    expect(result.oldPath).toBe(filePath);
    expect(result.newPath).toBe(newPath);
    expect(result.fileName).toBe("renamed.md");

    // Disk: old gone, new present.
    expect(await fileExists(filePath)).toBe(false);
    expect(await fileExists(newPath)).toBe(true);

    // Registry: same id/room, new path.
    const state = getOpenDocs().get(docId);
    expect(state?.filePath).toBe(newPath);
    expect(state?.source).toBe("file");

    // Tab metadata reflects the new basename.
    const doc = getOrCreateDocument(docId);
    expect(doc.getMap(Y_MAP_DOCUMENT_META).get("fileName")).toBe("renamed.md");
  });

  it("moves the durable annotation envelope from oldHash to newHash", async () => {
    const { docId, filePath, doc } = await openFileDoc("annotated.md", "body");
    const annMap = doc.getMap(Y_MAP_ANNOTATIONS);
    withBrowser(doc, () => annMap.set("ann-1", makeAnnotation("ann-1")));
    await createStore(docHash(filePath), { filePath }).flush();

    const newPath = path.join(docDir, "annotated-renamed.md");
    await renameDocument(docId, "annotated-renamed.md");

    // Old envelope gone; new envelope carries the annotation.
    const oldEnvelope = await createStore(docHash(filePath), { filePath }).load();
    const newEnvelope = await createStore(docHash(newPath), { filePath: newPath }).load();
    expect(oldEnvelope.annotations).toHaveLength(0);
    expect(newEnvelope.annotations.map((a) => a.id)).toContain("ann-1");
    // Finding A heal-write: envelope meta now points at the NEW path.
    expect(newEnvelope.meta.filePath).toBe(newPath);
  });
});

describe("renameDocument — tombstone survival (data-loss regression)", () => {
  // The load-bearing ordering test for Phase-1 steps 8/9 (closeStore BEFORE
  // clearFileSyncContext). A DELETE leaves a PENDING (un-flushed) debounced
  // write at rename time; the correct order flushes it while the ledger is
  // intact, so the moved envelope keeps the tombstone. Swapping the two steps
  // drops the ledger before the flush → the envelope loses the tombstone →
  // the deleted annotation resurrects. Verified red by hand during impl.
  it("a DELETED annotation stays deleted after rename + reopen (no resurrection)", async () => {
    const { docId, filePath, doc } = await openFileDoc("doc.md", "body content");
    const annMap = doc.getMap(Y_MAP_ANNOTATIONS);

    // Create + persist annotation A (rev 1).
    withBrowser(doc, () => annMap.set("A", makeAnnotation("A")));
    await createStore(docHash(filePath), { filePath }).flush();

    // DELETE A — the observer records a tombstone (rev 2) AND queues a debounced
    // write. Deliberately DO NOT flush: the pending write is what closeStore must
    // flush (ledger intact) during the rename.
    withBrowser(doc, () => annMap.delete("A"));
    expect(getTombstones(docHash(filePath)).map((t) => t.id)).toContain("A");

    const newPath = path.join(docDir, "doc-renamed.md");
    const result = await renameDocument(docId, "doc-renamed.md");
    expect(result.status).toBe("renamed");

    // The moved envelope MUST carry the tombstone (this is what swapping breaks).
    const newEnvelope = await createStore(docHash(newPath), { filePath: newPath }).load();
    expect(newEnvelope.tombstones.map((t) => t.id)).toContain("A");
    expect(newEnvelope.annotations.map((a) => a.id)).not.toContain("A");

    // Resurrection vector: a stale tab re-introduces A, then the doc reopens.
    // Detach the live observer (close drops the ledger; the file is authoritative),
    // re-insert A as a stale-merge would, then reopen via wireAnnotationStore.
    const { clearFileSyncContext } = await import("../../src/server/events/queue.js");
    clearFileSyncContext(docId);
    withBrowser(doc, () => annMap.set("A", makeAnnotation("A", { rev: 1 })));
    await wireAnnotationStore(docId, doc, newPath, { allowRecovery: false });

    // loadAndMerge applies the file tombstone (rev 2 > A.rev 1) → A is dropped.
    expect(annMap.has("A")).toBe(false);
  });
});

describe("renameDocument — file-newer annotation survival (#1040 × #1041 regression)", () => {
  // The data-loss regression the #1041 note-privacy test surfaced, asserted here
  // on a NON-note (Claude-visible) annotation so the guard is independent of the
  // ADR-027 privacy framing.
  //
  // #1051's rename RMW writes the new-hash envelope from a pure LIVE snapshot.
  // When a durable annotation is NEWER in the OLD file envelope than in the live
  // Y.Doc — e.g. flushed at rev 2, then diverged to rev 1 in the live map via a
  // `withInternal` write the durable-sync observer SKIPS (so no debounced write
  // re-converges the envelope) — that pure-live snapshot DROPS the rev-2 record,
  // and the re-wire's loadAndMerge (reading the just-clobbered envelope) finds
  // nothing newer than live. Result before the fix: the file-newer record is LOST
  // on rename. The old-envelope fold-forward (Fold 0) restores file-wins.
  it("a comment that is newer in the OLD file than in the live doc wins the rename merge", async () => {
    const { docId, filePath, doc } = await openFileDoc("doc.md", "body content");
    const annMap = doc.getMap(Y_MAP_ANNOTATIONS);

    // Flush comment C at rev 2 (the FILE body — this lands in the envelope).
    withBrowser(doc, () => annMap.set("C", makeAnnotation("C", { content: "FILE BODY", rev: 2 })));
    await createStore(docHash(filePath), { filePath }).flush();

    // Diverge the LIVE map to rev 1 via withInternal — the durable-sync observer
    // skips internal writes, so NO debounced write is queued; the envelope keeps
    // rev 2 while the live map sits at rev 1.
    withInternal(doc, () => annMap.set("C", makeAnnotation("C", { content: "LIVE BODY", rev: 1 })));

    const newPath = path.join(docDir, "doc-renamed.md");
    const result = await renameDocument(docId, "doc-renamed.md");
    expect(result.status).toBe("renamed");

    // The file-wins merge applied: the live map now carries the rev-2 FILE body.
    const live = annMap.get("C") as { rev?: number; content?: string } | undefined;
    expect(live?.rev).toBe(2);
    expect(live?.content).toBe("FILE BODY");

    // And it survived durably under the new path-hash (no data loss on rename).
    const newEnvelope = await createStore(docHash(newPath), { filePath: newPath }).load();
    const moved = newEnvelope.annotations.find((a) => a.id === "C");
    expect(moved?.rev).toBe(2);
    expect(moved?.content).toBe("FILE BODY");
  });
});

describe("renameDocument — concurrent-DELETE resurrection window (#1040, window a)", () => {
  // A DELETE arriving DURING the rename's async span (after the Phase-1 flush,
  // while the old-hash observer is still attached) must not resurrect. The old
  // observer records a tombstone into the oldHash ledger; renameDocument must
  // migrate that ledger forward into the newHash envelope before the re-wire
  // disposes the old observer. We inject the concurrent delete by spying on
  // fs.rename (document-service imports `fs from "fs/promises"`): the delete
  // fires from inside the rename call, exactly in the observer-attached gap.
  it("a DELETE concurrent with the rename stays deleted (no resurrection)", async () => {
    const { docId, filePath, doc } = await openFileDoc("concurrent.md", "body content");
    const annMap = doc.getMap(Y_MAP_ANNOTATIONS);

    // Create + persist annotation A (rev 1).
    withBrowser(doc, () => annMap.set("A", makeAnnotation("A")));
    await createStore(docHash(filePath), { filePath }).flush();

    const newPath = path.join(docDir, "concurrent-renamed.md");

    // Spy on the actual fs.rename used by document-service. On the FIRST call
    // (the primary file rename), delete A via the live (still-attached) observer
    // BEFORE delegating to the real rename — simulating a concurrent DELETE in
    // the rename's observer span. The observer records A's tombstone (rev 2)
    // into the oldHash ledger.
    const fsModule = await import("node:fs/promises");
    const realRename = fsModule.default.rename.bind(fsModule.default);
    let fired = false;
    const renameSpy = vi
      .spyOn(fsModule.default, "rename")
      .mockImplementation(async (from: Parameters<typeof realRename>[0], to) => {
        if (!fired) {
          fired = true;
          withBrowser(doc, () => annMap.delete("A"));
        }
        return realRename(from, to);
      });

    try {
      const result = await renameDocument(docId, "concurrent-renamed.md");
      expect(result.status).toBe("renamed");
    } finally {
      renameSpy.mockRestore();
    }

    // The migrated tombstone must land in the newHash envelope.
    const newEnvelope = await createStore(docHash(newPath), { filePath: newPath }).load();
    expect(newEnvelope.tombstones.map((t) => t.id)).toContain("A");
    expect(newEnvelope.annotations.map((a) => a.id)).not.toContain("A");

    // Resurrection vector: a stale tab re-introduces A at the pre-deletion rev,
    // then the doc reopens. The migrated tombstone (rev 2 > A.rev 1) drops it.
    const { clearFileSyncContext } = await import("../../src/server/events/queue.js");
    clearFileSyncContext(docId);
    withBrowser(doc, () => annMap.set("A", makeAnnotation("A", { rev: 1 })));
    await wireAnnotationStore(docId, doc, newPath, { allowRecovery: false });
    expect(annMap.has("A")).toBe(false);
  });
});

describe("renameDocument — residual concurrent-DELETE windows (#1040, a2/a3)", () => {
  // Window a3: a DELETE that fires DURING the RMW step-1 envelope WRITE — after
  // the snapshot thunk already captured A as alive (so the written envelope's
  // annotations include A), but before the re-wire. The old observer (still
  // attached) records A's tombstone into the oldHash ledger. The just-written
  // newHash envelope does NOT carry the tombstone, so the fix's UNION-not-clobber
  // seed in loadAndMerge + the fold inside loadAndMerge + the post-re-wire flush must
  // cooperate to land the tombstone in the newHash envelope and apply it.
  //
  // RED without the fix: loadAndMerge clobbered the newHash ledger with the
  // file seed (no tombstone) at sync.ts:538, and there was no fold after the RMW
  // write, so the migrated-forward tombstone was discarded → A resurrects.
  it("a DELETE during the RMW envelope write stays deleted (no resurrection)", async () => {
    const { docId, filePath, doc } = await openFileDoc("rmw-write.md", "body content");
    const annMap = doc.getMap(Y_MAP_ANNOTATIONS);

    withBrowser(doc, () => annMap.set("A", makeAnnotation("A")));
    await createStore(docHash(filePath), { filePath }).flush();

    const newPath = path.join(docDir, "rmw-write-renamed.md");

    // Spy on the atomic-write temp-file write (store.ts → atomicWrite →
    // fs.writeFile). Fire the DELETE exactly when the RMW step-1 content (which
    // still lists A alive, with meta.filePath === newPath) is being written —
    // i.e. mid-flush, after the thunk captured A as alive. The old observer
    // records A's tombstone into the oldHash ledger.
    const fsModule = await import("node:fs/promises");
    const realWriteFile = fsModule.default.writeFile.bind(fsModule.default);
    let fired = false;
    const writeSpy = vi
      .spyOn(fsModule.default, "writeFile")
      .mockImplementation(async (target, content, ...rest) => {
        const text = typeof content === "string" ? content : "";
        if (!fired && text.includes('"A"') && text.includes(JSON.stringify(newPath))) {
          fired = true;
          // The envelope JSON listing A alive is about to land on disk; fire the
          // concurrent delete before the bytes are written.
          withBrowser(doc, () => annMap.delete("A"));
        }
        // @ts-expect-error — forward through to the real impl with original args.
        return realWriteFile(target, content, ...rest);
      });

    try {
      const result = await renameDocument(docId, "rmw-write-renamed.md");
      expect(result.status).toBe("renamed");
    } finally {
      writeSpy.mockRestore();
    }

    expect(fired).toBe(true); // the injected delete actually ran

    // The migrated-forward tombstone must land in the newHash envelope.
    const newEnvelope = await createStore(docHash(newPath), { filePath: newPath }).load();
    expect(newEnvelope.tombstones.map((t) => t.id)).toContain("A");
    expect(newEnvelope.annotations.map((a) => a.id)).not.toContain("A");

    // Resurrection vector: a stale tab re-introduces A at the pre-deletion rev,
    // then the doc reopens. The persisted tombstone (rev 2 > A.rev 1) drops it.
    const { clearFileSyncContext } = await import("../../src/server/events/queue.js");
    clearFileSyncContext(docId);
    withBrowser(doc, () => annMap.set("A", makeAnnotation("A", { rev: 1 })));
    await wireAnnotationStore(docId, doc, newPath, { allowRecovery: false });
    expect(annMap.has("A")).toBe(false);
  });

  // Window a2: a DELETE that fires DURING the re-wire's loadAndMerge `store.load()`
  // read of the newHash envelope. The old observer is STILL attached at that
  // moment (disposed only inside setFileSyncContext, after loadAndMerge resolves),
  // so the delete records A's tombstone into the oldHash ledger. The newHash
  // envelope was already written (RMW step 1) WITHOUT the tombstone, and the file
  // seed loadAndMerge reads back also lacks it. The rename-gated fold runs
  // INSIDE loadAndMerge (its `migrateTombstonesFrom` opt — after store.load(),
  // before the merge) and must carry it forward, and the post-re-wire flush
  // must persist it.
  //
  // RED without the fix: there was no fold inside loadAndMerge, and the prior
  // "close" cleanup deleted the oldHash ledger before any later fold → tombstone
  // lost → A resurrects.
  it("a DELETE during the re-wire loadAndMerge read stays deleted (no resurrection)", async () => {
    const { docId, filePath, doc } = await openFileDoc("loadmerge.md", "body content");
    const annMap = doc.getMap(Y_MAP_ANNOTATIONS);

    withBrowser(doc, () => annMap.set("A", makeAnnotation("A")));
    await createStore(docHash(filePath), { filePath }).flush();

    const newPath = path.join(docDir, "loadmerge-renamed.md");
    const newEnvFile = envelopePath(docHash(newPath));

    // Spy on fs.readFile. Fire the DELETE when loadAndMerge's store.load() reads
    // the NEWLY-written newHash envelope (the RMW step-1 output). At that instant
    // the old observer is still attached → it records A's tombstone into oldHash.
    const fsModule = await import("node:fs/promises");
    const realReadFile = fsModule.default.readFile.bind(fsModule.default);
    let fired = false;
    const readSpy = vi
      .spyOn(fsModule.default, "readFile")
      .mockImplementation(async (target, ...rest) => {
        if (!fired && typeof target === "string" && target === newEnvFile) {
          fired = true;
          withBrowser(doc, () => annMap.delete("A"));
        }
        // @ts-expect-error — forward through to the real impl with original args.
        return realReadFile(target, ...rest);
      });

    try {
      const result = await renameDocument(docId, "loadmerge-renamed.md");
      expect(result.status).toBe("renamed");
    } finally {
      readSpy.mockRestore();
    }

    expect(fired).toBe(true); // the injected delete actually ran

    const newEnvelope = await createStore(docHash(newPath), { filePath: newPath }).load();
    expect(newEnvelope.tombstones.map((t) => t.id)).toContain("A");
    expect(newEnvelope.annotations.map((a) => a.id)).not.toContain("A");

    const { clearFileSyncContext } = await import("../../src/server/events/queue.js");
    clearFileSyncContext(docId);
    withBrowser(doc, () => annMap.set("A", makeAnnotation("A", { rev: 1 })));
    await wireAnnotationStore(docId, doc, newPath, { allowRecovery: false });
    expect(annMap.has("A")).toBe(false);
  });
});

describe("renameDocument — cross-doc envelope steal (Finding A)", () => {
  it("a byte-identical doc opened after rename does NOT steal the renamed doc's envelope", async () => {
    const SHARED_BODY = "identical body shared across two documents";
    const { docId, filePath, doc } = await openFileDoc("a.md", SHARED_BODY);
    const annMapA = doc.getMap(Y_MAP_ANNOTATIONS);
    withBrowser(doc, () => annMapA.set("ann-a", makeAnnotation("ann-a")));
    await createStore(docHash(filePath), { filePath }).flush();

    const newPathA = path.join(docDir, "a-renamed.md");
    await renameDocument(docId, "a-renamed.md");

    // Open doc B at a DIFFERENT path with byte-identical content and NO envelope,
    // WITH recovery enabled (the normal-open default). Without the step-13b
    // heal-write, A's envelope meta.filePath would still be the vanished `a.md`,
    // and B would match + STEAL it. The heal-write set it to a-renamed.md (exists)
    // → the vanished-path gate refuses the match.
    const { docId: docIdB, doc: docB } = await openFileDoc("b.md", SHARED_BODY, {
      wire: false,
    });
    const filePathB = path.join(docDir, "b.md");
    await wireAnnotationStore(docIdB, docB, filePathB, { allowRecovery: true });

    // B did not steal; A's envelope is intact.
    expect(docB.getMap(Y_MAP_ANNOTATIONS).has("ann-a")).toBe(false);
    const envelopeA = await createStore(docHash(newPathA), { filePath: newPathA }).load();
    expect(envelopeA.annotations.map((a) => a.id)).toContain("ann-a");
  });
});

describe("closeDocumentById — tombstone flush order (Finding C)", () => {
  // The same flush-before-teardown ordering rename established, applied to the
  // pre-existing close path. A delete-then-close within the debounce window must
  // flush the tombstone (ledger intact) before clearFileSyncContext drops it.
  it("a DELETE then close within the debounce window persists the tombstone", async () => {
    const { docId, filePath, doc } = await openFileDoc("closing.md", "body content");
    const annMap = doc.getMap(Y_MAP_ANNOTATIONS);

    withBrowser(doc, () => annMap.set("A", makeAnnotation("A")));
    await createStore(docHash(filePath), { filePath }).flush();

    // DELETE A — pending debounced write, deliberately NOT flushed.
    withBrowser(doc, () => annMap.delete("A"));

    const result = await closeDocumentById(docId);
    expect(result.success).toBe(true);

    // closeStore flushed the tombstone (ledger intact) before the context drop.
    const envelope = await createStore(docHash(filePath), { filePath }).load();
    expect(envelope.tombstones.map((t) => t.id)).toContain("A");
    expect(envelope.annotations.map((a) => a.id)).not.toContain("A");
  });
});

describe("renameDocument — fs.rename failure rollback (Phase 2)", () => {
  it("surfaces the original errno and re-wires the old context when fs.rename throws", async () => {
    const { docId, filePath, doc } = await openFileDoc("rollback.md", "body content");
    const newPath = path.join(docDir, "rollback-renamed.md");

    // Trigger a real fs.rename failure: delete the source file after validation
    // would pass (renameDocument never stats oldPath before the rename), so
    // fs.rename(oldPath, …) throws ENOENT → the Phase-2 rollback path runs.
    await fsReal.rm(filePath);

    const result = await renameDocument(docId, "rollback-renamed.md");

    // The ORIGINAL fs.rename error propagates (not a masked rollback error).
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("ENOENT");

    // New path never created; registry entry unchanged (still the old path).
    expect(await fileExists(newPath)).toBe(false);
    expect(getOpenDocs().get(docId)?.filePath).toBe(filePath);

    // The rollback re-wired the annotation observer to the OLD path: a fresh
    // annotation still serializes to the oldHash envelope.
    const annMap = doc.getMap(Y_MAP_ANNOTATIONS);
    withBrowser(doc, () => annMap.set("post-rollback", makeAnnotation("post-rollback")));
    await createStore(docHash(filePath), { filePath }).flush();
    const envelope = await createStore(docHash(filePath), { filePath }).load();
    expect(envelope.annotations.map((a) => a.id)).toContain("post-rollback");
  });

  // #1040 rollback regression: on rollback oldHash === the still-registered
  // context's hash. The rollback re-wire's loadAndMerge re-seeds the oldHash
  // tombstone ledger (UNION + tombstonesByDoc.set), and WITHOUT a pre-wire
  // clearFileSyncContext the trailing setFileSyncContext "close"-disposes the
  // still-present old oldHash context — deleting the just-re-seeded ledger. A
  // later stale-tab merge re-adding A then writes an empty tombstone list,
  // overwriting <oldHash>.json and resurrecting A. The fix restores the master
  // ordering (clearFileSyncContext BEFORE the re-wire) on the rollback path.
  //
  // RED without the fix: the rollback "close"-dispose deletes the re-seeded
  // ledger → the reopen's tombstone is gone → A resurrects (annMap.has("A") is
  // true and the envelope tombstone for A is lost). GREEN with it.
  it("a DELETED annotation stays deleted after a FAILED rename + rollback (no resurrection)", async () => {
    const { docId, filePath, doc } = await openFileDoc("rb-resurrect.md", "body content");
    const annMap = doc.getMap(Y_MAP_ANNOTATIONS);

    // Create + persist annotation A (rev 1).
    withBrowser(doc, () => annMap.set("A", makeAnnotation("A")));
    await createStore(docHash(filePath), { filePath }).flush();

    // DELETE A — tombstone rev 2 — and flush so <oldHash>.json durably carries it
    // (Phase 1's closeStore would flush it anyway; flushing here makes the
    // pre-condition explicit).
    withBrowser(doc, () => annMap.delete("A"));
    await createStore(docHash(filePath), { filePath }).flush();
    expect(getTombstones(docHash(filePath)).map((t) => t.id)).toContain("A");

    // Force fs.rename to fail so the Phase-2 rollback path runs. Deleting the
    // source file makes fs.rename(oldPath, …) throw ENOENT (renameDocument never
    // stats oldPath before the rename). Re-create it afterward so the post-
    // rollback reopen still has a real file at oldPath.
    await fsReal.rm(filePath);
    const oldHash = docHash(filePath);
    const result = await renameDocument(docId, "rb-resurrect-renamed.md");
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("ENOENT");
    await fsReal.writeFile(filePath, "body content", "utf-8");

    // DIRECT DISCRIMINATOR: after the rollback re-wire, the in-memory oldHash
    // ledger MUST still carry A's tombstone. WITH the fix the pre-wire
    // clearFileSyncContext drops the stale same-hash context first, so nothing
    // "close"-disposes the ledger loadAndMerge re-seeds. WITHOUT it, the trailing
    // setFileSyncContext "close"-disposes the still-present old context →
    // tombstonesByDoc.delete(oldHash) → this ledger is empty (RED).
    expect(getTombstones(oldHash).map((t) => t.id)).toContain("A");

    // Resurrection vector: a stale tab re-introduces A (rev 1). The live
    // rollback-wired observer serializes on the mutation and snapshots the
    // in-memory ledger. WITH the fix the ledger still has A → the snapshot keeps
    // the tombstone. WITHOUT it the empty ledger would write `tombstones: []`,
    // overwriting durable <oldHash>.json and resurrecting A on reopen.
    withBrowser(doc, () => annMap.set("A", makeAnnotation("A", { rev: 1 })));
    await createStore(oldHash, { filePath }).flush();

    // The durable envelope must still carry A's tombstone (not an empty list).
    const overwritten = await createStore(oldHash, { filePath }).load();
    expect(overwritten.tombstones.map((t) => t.id)).toContain("A");

    // Reopen at the OLD path (rollback left the doc registered there): the file
    // tombstone (rev 2 > A.rev 1) must drop the stale-merged A → it stays deleted
    // in the Y.Map, and the ledger still carries the tombstone. (The on-disk
    // envelope may still list A under `annotations` from the contradictory
    // stale-merge snapshot; the tombstone is authoritative on load, which is why
    // loadAndMerge drops A from the Y.Map here.)
    clearFileSyncContext(docId);
    await wireAnnotationStore(docId, doc, filePath, { allowRecovery: false });
    expect(annMap.has("A")).toBe(false);
    expect(getTombstones(oldHash).map((t) => t.id)).toContain("A");
    const envelope = await createStore(oldHash, { filePath }).load();
    expect(envelope.tombstones.map((t) => t.id)).toContain("A");
  });
});

describe("renameDocument — post-commit best-effort (Phase 3)", () => {
  it("still reports renamed when a post-commit step throws (disk rename is the contract)", async () => {
    const { docId, filePath } = await openFileDoc("committed.md", "body content");
    const newPath = path.join(docDir, "committed-renamed.md");

    // Make the post-commit annotation-store re-wire throw. fs.rename has already
    // committed by then, so the rename MUST still report success rather than a
    // misleading "Rename failed" (which would revert the tab against on-disk truth).
    const fileOpener = await import("../../src/server/mcp/file-opener.js");
    const rewireSpy = vi
      .spyOn(fileOpener, "wireAnnotationStore")
      .mockRejectedValueOnce(new Error("simulated re-wire failure"));
    try {
      const result = await renameDocument(docId, "committed-renamed.md");
      expect(result.status).toBe("renamed");
      expect(result.fileName).toBe("committed-renamed.md");
    } finally {
      rewireSpy.mockRestore();
    }

    // The disk rename committed despite the bookkeeping failure.
    expect(await fileExists(filePath)).toBe(false);
    expect(await fileExists(newPath)).toBe(true);
    expect(getOpenDocs().get(docId)?.filePath).toBe(newPath);
  });
});

describe("renameDocument — re-wire-FAILURE stale observer disposal (#1040)", () => {
  // The residual on the SUCCESS-disk path: Phase-3 moves the envelope to newHash
  // and RMW step-2 clears <oldHash>.json. The re-wire is wrapped in a swallowing
  // try/catch. If `wireAnnotationStore(... newPath ...)` THROWS, `setFileSyncContext`
  // never ran, so the OLD oldHash observer stays REGISTERED and LIVE (still pointing
  // at the vanished oldPath) AFTER renameDocument returns. A concurrent DELETE that
  // arrives in that window schedules a fresh debounced write under oldHash — which
  // RE-CREATES <oldHash>.json with the vanished oldPath AFTER the step-2 clear().
  // That re-created envelope is a stale-envelope steal vector (a byte-identical open
  // could match its vanished meta.filePath and steal it via recoverRenamedEnvelope).
  //
  // step-2's own clearOne() drops only the SYNCHRONOUSLY-pending write, so a delete
  // arriving after the clear is NOT covered by it — the live observer schedules a
  // brand-new write. The fix disposes the stale oldHash observer (clearFileSyncContext,
  // gated on !rewired) so no such post-clear write can be scheduled at all. The guard
  // MUST be gated on !rewired: on the success path docId points at newHash, so an
  // unconditional clear would tear down the freshly-wired newHash observer.
  //
  // RED without the `!rewired` guard: the still-live oldHash observer serializes the
  // post-return DELETE -> <oldHash>.json is re-created (steal vector reopened). GREEN
  // with the guard: the observer was disposed, so the post-return DELETE writes
  // nothing under oldHash and the envelope stays absent.
  it("a DELETE after a FAILED re-wire does not re-create <oldHash>.json (steal vector closed)", async () => {
    const { docId, filePath, doc } = await openFileDoc("rewire-fail.md", "body content");
    const annMap = doc.getMap(Y_MAP_ANNOTATIONS);

    // Create + persist annotation A (rev 1) under oldHash. The live observer wired by
    // openFileDoc is what stays registered if the Phase-3 re-wire throws.
    withBrowser(doc, () => annMap.set("A", makeAnnotation("A")));
    const oldHash = docHash(filePath);
    await createStore(oldHash, { filePath }).flush();
    expect(await fileExists(envelopePath(oldHash))).toBe(true);

    const newPath = path.join(docDir, "rewire-fail-renamed.md");

    // Force the Phase-3 re-wire to THROW so `rewired` stays false and the !rewired
    // guard path runs. The OLD oldHash observer is never disposed by the (failed)
    // re-wire -- only the guard's clearFileSyncContext can dispose it.
    const fileOpener = await import("../../src/server/mcp/file-opener.js");
    const rewireSpy = vi
      .spyOn(fileOpener, "wireAnnotationStore")
      .mockRejectedValueOnce(new Error("simulated re-wire failure"));

    try {
      const result = await renameDocument(docId, "rewire-fail-renamed.md");
      // The disk rename committed; a re-wire failure must NOT flip the result.
      expect(result.status).toBe("renamed");
    } finally {
      rewireSpy.mockRestore();
    }

    // Disk renamed; the old envelope was cleared by RMW step-2.
    expect(await fileExists(newPath)).toBe(true);
    expect(await fileExists(envelopePath(oldHash))).toBe(false);

    // Concurrent DELETE arriving AFTER renameDocument returned. WITHOUT the guard the
    // stale oldHash observer is still registered and would serialize this mutation,
    // re-creating <oldHash>.json (the steal vector). WITH the guard the observer was
    // disposed, so this writes nothing under oldHash.
    withBrowser(doc, () => annMap.delete("A"));

    // Let the debounce window (DEBOUNCE_MS) elapse so any scheduled write fires.
    await new Promise((resolve) => setTimeout(resolve, 400));

    // GREEN assertion: the old envelope was NOT re-created -- the steal vector is
    // closed. (RED without the guard: the live observer's write re-creates it.)
    expect(await fileExists(envelopePath(oldHash))).toBe(false);
  });
});

describe("renameDocument — note privacy (ADR-027)", () => {
  it("a note annotation survives the envelope move and reloads under the new path-hash", async () => {
    const { docId, filePath, doc } = await openFileDoc("noted.md", "body");
    const annMap = doc.getMap(Y_MAP_ANNOTATIONS);
    withBrowser(doc, () =>
      annMap.set("note-1", makeAnnotation("note-1", { type: "note", author: "user" })),
    );
    await createStore(docHash(filePath), { filePath }).flush();

    // Attach the channel observer + start collecting BEFORE the rename so we can
    // assert the migration leaks nothing to Claude. What this proves: the note
    // SURVIVES the oldHash→newHash move and no event leaks during it. Note the
    // zero-events result is guaranteed structurally — closeStore re-converges the
    // moved envelope to equal the live Y.Map, so loadAndMerge performs no emitting
    // mutation at all (independent of origin). The withFileSync→CHANNEL_SKIP path
    // proper is proven directly in event-queue.test.ts ("FILE_SYNC_ORIGIN-tagged
    // annotation writes do not emit events"); this test is the rename-flow
    // survival + no-resurrection regression, not a second skip proof.
    attachObservers(docId, doc);
    const { events, cleanup } = collectEvents();

    const newPath = path.join(docDir, "noted-renamed.md");
    await renameDocument(docId, "noted-renamed.md");

    const annEvents = events.filter(
      (e) => e.type === "annotation:created" || e.type === "annotation:edited",
    );
    expect(annEvents).toHaveLength(0);
    cleanup();
    detachObservers(docId);

    const newEnvelope = await createStore(docHash(newPath), { filePath: newPath }).load();
    const moved = newEnvelope.annotations.find((a) => a.id === "note-1");
    expect(moved?.type).toBe("note");
  });

  // Companion to the survival test above, exercising the branch its comment
  // calls out as proven-elsewhere. The survival case is "guaranteed structurally"
  // precisely because the rename converges the moved envelope to equal the
  // live Y.Map, so the file-wins merge performs ZERO mutations. These two
  // variants DEFEAT that convergence so the REAL merge branch runs a live-note
  // write, through both production paths that can reach it:
  //
  //   1. Flush a note at rev 2 (the "file" body) — this lands in the envelope.
  //   2. Mutate the LIVE Y.Map note to rev 1 (a different "live" body) via
  //      `withInternal`. The durable-sync observer skips `internal` writes
  //      (DURABLE_SKIP = {file-sync, internal}), so NO debounced write is queued
  //      — the envelope keeps its rev-2 file body while the live Y.Map diverges
  //      to rev 1.
  //   3. Drive the file-wins merge: file.rev(2) > ymap.rev(1) → pickWinner
  //      returns "file" → `annMap.set("note-1", fileRec)` executes INSIDE a
  //      `withFileSync(ydoc, …)` transaction. That is a live-note mutation that
  //      *could* emit if the channel observer didn't gate on origin.
  //
  // Variant A drives it through renameDocument (Fold 0 / mergeEnvelopeForward —
  // #1040×#1041: the rename folds file-newer envelope records forward before
  // the RMW snapshot, so the file-wins contract holds across rename). Variant B
  // drives it through an explicit store re-wire, the open/reload path
  // (loadAndMerge on a doc whose envelope advanced past the live Y.Map).
  //
  // Assert the gate holds on BOTH surfaces: no channel event leaks the note, and
  // getDocumentStore (what tandem_getAnnotations reads) still hides it from Claude.
  it("a withFileSync merge during rename that mutates a live note emits no channel event and stays hidden from Claude", async () => {
    const { docId, filePath, doc } = await openFileDoc("private.md", "body");
    const annMap = doc.getMap(Y_MAP_ANNOTATIONS);

    withBrowser(doc, () =>
      annMap.set(
        "note-1",
        makeAnnotation("note-1", {
          type: "note",
          author: "user",
          content: "FILE BODY — must never leak",
          rev: 2,
        }),
      ),
    );
    await createStore(docHash(filePath), { filePath }).flush();

    withInternal(doc, () =>
      annMap.set(
        "note-1",
        makeAnnotation("note-1", {
          type: "note",
          author: "user",
          content: "LIVE BODY — also private",
          rev: 1,
        }),
      ),
    );

    // Start collecting channel events BEFORE the rename so the real withFileSync
    // merge write (file rev 2 over live rev 1, via Fold 0) is observed if it
    // were to emit.
    attachObservers(docId, doc);
    const { events, cleanup } = collectEvents();

    const result = await renameDocument(docId, "private-renamed.md");
    expect(result.status).toBe("renamed");

    // Fold 0 genuinely fired the file-wins branch: the live Y.Map note now
    // carries the rev-2 file body. If this fails, rename stopped honoring the
    // file-wins contract (the #1040×#1041 regression).
    const merged = annMap.get("note-1") as { rev?: number; content?: string } | undefined;
    expect(merged?.rev).toBe(2);
    expect(merged?.content).toBe("FILE BODY — must never leak");

    // ADR-027 surface 1: no channel event leaked the note.
    const annEvents = events.filter(
      (e) => e.type === "annotation:created" || e.type === "annotation:edited",
    );
    expect(annEvents).toHaveLength(0);
    cleanup();
    detachObservers(docId);

    // ADR-027 surface 2: Claude must see zero annotations here.
    const store = getDocumentStore(docId);
    expect(store).not.toBeNull();
    const claudeVisible = store!.listAnnotationsRefreshed().filter((a) => a.type !== "note");
    expect(claudeVisible).toHaveLength(0);
    expect(store!.listAnnotationsRefreshed().some((a) => a.id === "note-1")).toBe(true);
  });

  it("a withFileSync merge via open/reload re-wire that mutates a live note emits no channel event and stays hidden from Claude", async () => {
    const { docId, filePath, doc } = await openFileDoc("private.md", "body");
    const annMap = doc.getMap(Y_MAP_ANNOTATIONS);

    // Flush the note at rev 2 — this is the body that lands in the envelope and
    // will WIN the merge (higher rev).
    withBrowser(doc, () =>
      annMap.set(
        "note-1",
        makeAnnotation("note-1", {
          type: "note",
          author: "user",
          content: "FILE BODY — must never leak",
          rev: 2,
        }),
      ),
    );
    await createStore(docHash(filePath), { filePath }).flush();

    // Diverge the live Y.Map to rev 1 via `withInternal`. The durable-sync
    // observer skips `internal`, so this queues no debounced write — the
    // envelope retains its rev-2 file body.
    withInternal(doc, () =>
      annMap.set(
        "note-1",
        makeAnnotation("note-1", {
          type: "note",
          author: "user",
          content: "LIVE BODY — also private",
          rev: 1,
        }),
      ),
    );

    // Start collecting channel events BEFORE the re-wire so the real withFileSync
    // merge write (file rev 2 over live rev 1) is observed if it were to emit.
    attachObservers(docId, doc);
    const { events, cleanup } = collectEvents();

    // Force the re-wire: dispose the live context (dropping its in-memory
    // ledger), then wire the store again at the same path so loadAndMerge reads
    // the rev-2 envelope against the rev-1 live Y.Map and runs the file-wins
    // merge inside withFileSync.
    const { clearFileSyncContext } = await import("../../src/server/events/queue.js");
    clearFileSyncContext(docId);
    await wireAnnotationStore(docId, doc, filePath, { allowRecovery: false });

    // The merge genuinely fired the file-wins branch: the live Y.Map note now
    // carries the rev-2 file body (proving loadAndMerge ran annMap.set, not a
    // structural no-op). If this assertion fails the test is no longer covering
    // the intended branch.
    const merged = annMap.get("note-1") as { rev?: number; content?: string } | undefined;
    expect(merged?.rev).toBe(2);
    expect(merged?.content).toBe("FILE BODY — must never leak");

    // ADR-027 surface 1: no channel event leaked the note (the withFileSync
    // write was skipped by the channel observer's origin gate).
    const annEvents = events.filter(
      (e) => e.type === "annotation:created" || e.type === "annotation:edited",
    );
    expect(annEvents).toHaveLength(0);
    cleanup();
    detachObservers(docId);

    // ADR-027 surface 2: tandem_getAnnotations reads via getDocumentStore +
    // the `type !== "note"` filter. Claude must see zero annotations here.
    // (getDocumentStore reflects the re-wired context registered above.)
    const store = getDocumentStore(docId);
    expect(store).not.toBeNull();
    const claudeVisible = store!.listAnnotationsRefreshed().filter((a) => a.type !== "note");
    expect(claudeVisible).toHaveLength(0);
    // And the note is still present in the doc (private, not deleted).
    expect(store!.listAnnotationsRefreshed().some((a) => a.id === "note-1")).toBe(true);
  });
});
