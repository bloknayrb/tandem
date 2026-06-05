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
const { createStore, resetForTesting: storeReset } = await import(
  "../../src/server/annotations/store.js"
);
const { getTombstones, resetForTesting: syncReset } = await import(
  "../../src/server/annotations/sync.js"
);
const {
  attachObservers,
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
  // precisely because closeStore re-converges the moved envelope to equal the
  // live Y.Map, so loadAndMerge's `withFileSync` block performs ZERO mutations.
  // This variant DEFEATS that convergence so the REAL merge branch runs a live-
  // note write:
  //
  //   1. Flush a note at rev 2 (the "file" body) — this lands in the envelope.
  //   2. Mutate the LIVE Y.Map note to rev 1 (a different "live" body) via
  //      `withInternal`. The durable-sync observer skips `internal` writes
  //      (DURABLE_SKIP = {file-sync, internal}), so NO debounced write is queued
  //      and closeStore(oldHash) flushes nothing new — the moved envelope keeps
  //      its rev-2 file body while the live Y.Map diverges to rev 1.
  //   3. At re-wire, loadAndMerge sees file.rev(2) > ymap.rev(1) → pickWinner
  //      returns "file" → `annMap.set("note-1", fileRec)` executes INSIDE the
  //      `withFileSync(ydoc, …)` transaction. That is a live-note mutation that
  //      *could* emit if the channel observer didn't gate on origin.
  //
  // Assert the gate holds on BOTH surfaces: no channel event leaks the note, and
  // getDocumentStore (what tandem_getAnnotations reads) still hides it from Claude.
  it("a withFileSync merge that mutates a live note post-flush emits no channel event and stays hidden from Claude", async () => {
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
    // observer skips `internal`, so this queues no debounced write — closeStore
    // re-converges nothing, and the moved envelope retains its rev-2 file body.
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
    // merge write (file rev 2 over live rev 1) is observed if it were to emit.
    attachObservers(docId, doc);
    const { events, cleanup } = collectEvents();

    const result = await renameDocument(docId, "private-renamed.md");
    expect(result.status).toBe("renamed");

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
    const store = getDocumentStore(docId);
    expect(store).not.toBeNull();
    const claudeVisible = store!.listAnnotationsRefreshed().filter((a) => a.type !== "note");
    expect(claudeVisible).toHaveLength(0);
    // And the note is still present in the doc (private, not deleted).
    expect(store!.listAnnotationsRefreshed().some((a) => a.id === "note-1")).toBe(true);
  });
});
