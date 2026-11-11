/**
 * Tests for `reloadDocumentFromMarkdown` — the server side of the raw-markdown
 * source view/edit feature (#1021).
 *
 * Verifies the round-trip (markdown string → Y.Doc body → disk), annotation
 * survival (envelope re-merge for files, kept map for scratchpads), the per-document guards (NO_DOCUMENT / UNSUPPORTED_FORMAT /
 * READ_ONLY), and that the doc is left dirty-then-persisted (not silently
 * marked clean against the new content).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

vi.mock(import("../../src/server/platform"), async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const cryptoMod = await import("node:crypto");
  const appDataDir = pathMod.join(osMod.tmpdir(), `tandem-test-mdreload-${cryptoMod.randomUUID()}`);
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return {
    ...original,
    SESSION_DIR: pathMod.join(appDataDir, "sessions"),
  };
});

const watcherMocks = vi.hoisted(() => ({ watchFile: vi.fn() }));
vi.mock(import("../../src/server/file-watcher"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: watcherMocks.watchFile,
}));

// The tail of `reloadDocumentFromMarkdown` calls `broadcastOpenDocs()` and
// `ensureAutoSave()` and nothing asserted either: replacing both with
// `void 0;` left 27 specs green across this file, `documents-open` and
// `documents-boundary`. They are intra-`documents/` edges, so the import
// inventories cannot see them either — the only thing that could notice was
// a test, and there wasn't one.
//
// `importOriginal` is spread so the real implementation still runs for every
// other spec here; this is an observation point, not a stub.
//
// `ensureAutoSave` is deliberately NOT spied the same way. `autosave.ts` sits
// inside the documented cycle `open.ts → autosave.ts →
// mcp/document-service.ts → open.ts` (header of `documents/open.ts`), and
// mocking a module in that cycle yields TWO instances. Measured, not
// assumed: with the spy in place the test's own binding reported as a mock
// while the binding `reload-family.ts` had already captured reported as the
// real function, so the spy recorded nothing and the spec failed against
// working code. That half is asserted through the observable effect instead.
vi.mock(import("../../src/server/documents/registry.js"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/documents/registry.js")>();
  return { ...actual, broadcastOpenDocs: vi.fn(actual.broadcastOpenDocs) };
});

// Observation point for the #2219 ordering spec: `clearAndReload` must
// re-anchor kept records before it awaits the session delete. Spread like the
// registry mock above, so every other spec runs the real function.
vi.mock(import("../../src/server/session/manager.js"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/session/manager.js")>();
  return { ...actual, deleteSession: vi.fn(actual.deleteSession) };
});

vi.mock(import("../../src/server/notifications.js"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/notifications.js")>();
  return { ...actual, pushNotification: vi.fn() };
});

import { openFromDisk, openScratchpad } from "../../src/server/documents/open.js";
import { broadcastOpenDocs } from "../../src/server/documents/registry.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { reloadDocumentFromMarkdown } from "../../src/server/documents/reload-family.js";
import {
  acquireReloadGuard,
  isReloadInProgress,
  releaseReloadGuard,
} from "../../src/server/documents/watcher.js";
import { docIdFromPath, extractText } from "../../src/server/mcp/document-model.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { handleGetDocumentRaw } from "../../src/server/mcp/routes/document-raw.js";
import { anchoredRange } from "../../src/server/positions.js";
import {
  deleteSession,
  isAutoSaveRunning,
  stopAutoSave,
} from "../../src/server/session/manager.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { MCP_ORIGIN, withBrowser } from "../../src/shared/origins.js";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import type { Annotation, AnnotationReply } from "../../src/shared/types.js";
import { teardownFileAppDataDir } from "../helpers/app-data-teardown.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { collectEvents } from "../helpers/event-collector.js";

let tmpDir: string;

beforeEach(async () => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-mdreload-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  await teardownFileAppDataDir();
});

async function openMdFile(initial: string): Promise<{ filePath: string; id: string; doc: Y.Doc }> {
  const filePath = path.join(tmpDir, "doc.md");
  await fs.writeFile(filePath, initial, "utf-8");
  await openFromDisk(filePath);
  const id = docIdFromPath(filePath);
  return { filePath, id, doc: getOrCreateDocument(id) };
}

function seedAnnotation(
  doc: Y.Doc,
  snapshot: string,
  extra: { type?: "comment" | "note"; audience?: Annotation["audience"] } = {},
): string {
  const text = extractText(doc);
  const idx = text.indexOf(snapshot);
  if (idx < 0) throw new Error(`snapshot "${snapshot}" not found`);
  const result = anchoredRange(
    doc,
    toFlatOffset(idx),
    toFlatOffset(idx + snapshot.length),
    snapshot,
  );
  if (!result.ok) throw new Error("anchoredRange failed");
  const id = `ann_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ann: Annotation = {
    id,
    author: "user",
    type: "comment",
    range: result.range,
    ...(result.fullyAnchored ? { relRange: result.relRange } : {}),
    content: "seeded",
    status: "pending",
    timestamp: Date.now(),
    textSnapshot: snapshot,
    rev: 1,
    ...extra,
  };
  doc.transact(() => doc.getMap<Annotation>(Y_MAP_ANNOTATIONS).set(id, ann), MCP_ORIGIN);
  return id;
}

describe("reloadDocumentFromMarkdown — round-trip + disk persistence", () => {
  it("re-broadcasts the tab list and re-arms autosave on the way out", async () => {
    // The last two statements in the function, and nothing asserted either:
    // replacing both with `void 0;` left 27 specs green across this file,
    // `documents-open` and `documents-boundary`. They are intra-`documents/`
    // calls, so no import inventory can see them — a test was the only thing
    // that could, and there wasn't one.
    //
    // What each loss costs, since "it isn't called" is not by itself a defect:
    // without `broadcastOpenDocs` the client's tab list keeps the pre-reload
    // title and dirty state; without `ensureAutoSave` a document edited through
    // the raw-markdown view silently stops autosaving until something else
    // re-arms the timer.
    const broadcastMock = vi.mocked(broadcastOpenDocs);
    const { id } = await openMdFile("# Title\n\nOriginal paragraph.\n");
    broadcastMock.mockClear();

    // The open above armed the timer, so asserting it is running after the
    // reload would pass with `ensureAutoSave()` deleted. Disarm it first, so
    // re-arming is the only thing that can turn it back on — and pin the
    // disarm, because a control that silently stops controlling is the whole
    // failure mode this spec exists to close.
    stopAutoSave();
    expect(isAutoSaveRunning(), "control: the timer is genuinely disarmed").toBe(false);

    await reloadDocumentFromMarkdown(id, "# Changed\n\nBrand new body.\n");

    expect(broadcastMock, "the tab list would keep the pre-reload state").toHaveBeenCalled();
    expect(isAutoSaveRunning(), "a raw-markdown edit would stop autosaving").toBe(true);
  });

  it("replaces the Y.Doc body from the supplied markdown", async () => {
    const { id, doc } = await openMdFile("# Title\n\nOriginal paragraph.\n");
    expect(extractText(doc)).toContain("Original paragraph");

    await reloadDocumentFromMarkdown(id, "# Changed\n\nBrand new body text.\n");

    const text = extractText(doc);
    expect(text).toContain("Brand new body text");
    expect(text).not.toContain("Original paragraph");
  });

  it("writes the new markdown to disk", async () => {
    const { id, filePath } = await openMdFile("# Title\n\nOriginal.\n");

    await reloadDocumentFromMarkdown(id, "# Title\n\nEdited on disk.\n");

    const onDisk = await fs.readFile(filePath, "utf-8");
    expect(onDisk).toContain("Edited on disk.");
    expect(onDisk).not.toContain("Original.");
  });

  it("an annotation survives the source-view commit, re-merged from the envelope (#1813)", async () => {
    // Inverted by decision C and RESTATED rather than deleted: a reload path
    // silently losing annotations is still worth a spec, now stated the other
    // way round. `clearAndReload` empties the Y.Map but FLUSHES the durable
    // envelope instead of unlinking it, and `reload-family.ts` re-wires the
    // store immediately — so `loadAndMerge` brings the record back. Here the
    // annotated span is gone from the new content, so it comes back
    // `degraded` (see force-open-envelope.test.ts) rather than re-anchored.
    const { id, doc } = await openMdFile("# Title\n\nThe quick brown fox.\n");
    seedAnnotation(doc, "brown");
    expect(doc.getMap(Y_MAP_ANNOTATIONS).size).toBe(1);

    await reloadDocumentFromMarkdown(id, "# Title\n\nA different sentence.\n");

    expect(doc.getMap(Y_MAP_ANNOTATIONS).size).toBe(1);
  });

  it("re-anchors a surviving annotation whose text MOVED (#1813 review round 1)", async () => {
    // Surviving the commit is only half of #1813. `loadAndMerge` re-inserts the
    // record VERBATIM — its pre-commit flat range and a relRange anchored into
    // the XmlFragment `clearAndReload` destroyed — and the durable observer then
    // persists exactly that. Without the re-anchor pass the annotation comes
    // back durably pinned to whatever text now sits at [from, to), and every
    // reader (the client's decorations, `.docx` comment export,
    // `tandem_getAnnotations`) reports the wrong span. Deleting a paragraph
    // ABOVE the annotated one is the minimal shape that moves it.
    //
    // The sibling spec above asserts `size`, which passes with no re-anchor at
    // all; this one asserts the resolved TEXT, which is the property that was
    // silently wrong.
    const { id, doc } = await openMdFile("# Title\n\nAlpha beta gamma.\n\nDelta epsilon.\n");
    seedAnnotation(doc, "Delta epsilon");
    const before = doc.getMap<Annotation>(Y_MAP_ANNOTATIONS).values().next().value as Annotation;
    expect(extractText(doc).slice(before.range.from, before.range.to)).toBe("Delta epsilon");

    await reloadDocumentFromMarkdown(id, "# Title\n\nDelta epsilon.\n");

    const after = doc.getMap<Annotation>(Y_MAP_ANNOTATIONS).values().next().value as Annotation;
    expect(after).toBeDefined();
    // The control: the span really did move, so a spec that merely re-read the
    // stored offsets could not pass by accident.
    expect(after.range.from).not.toBe(before.range.from);
    expect(extractText(doc).slice(after.range.from, after.range.to)).toBe(after.textSnapshot);
  });

  it("keeps the file's UTF-8 BOM across a source-view round trip (#1823 review round 1)", async () => {
    // `saveMarkdown` re-attaches the BOM, and `GET /api/document/raw` used to
    // serve it — invisible in the textarea, so a caret at offset 0 lands in
    // FRONT of it. The committed string then no longer starts with a BOM,
    // `stripAndRecordBom` records `false`, and the next save writes the file
    // without the BOM it had, leaving a stray U+FEFF inside the body.
    const BOM = "\uFEFF";
    const { id, filePath } = await openMdFile(`${BOM}# Title\n\nBody.\n`);

    const res = {
      _json: undefined as unknown,
      status() {
        return this;
      },
      json(body: unknown) {
        this._json = body;
        return this;
      },
    };
    handleGetDocumentRaw(
      { socket: { remoteAddress: "127.0.0.1" }, query: { documentId: id } } as never,
      res as never,
    );
    const served = (res._json as { markdown: string }).markdown;
    expect(served.startsWith(BOM), "the source view was handed an invisible BOM").toBe(false);

    await reloadDocumentFromMarkdown(id, `X${served}`);

    const onDisk = await fs.readFile(filePath, "utf-8");
    expect(onDisk.startsWith(BOM), "the commit dropped the file's BOM").toBe(true);
    expect(onDisk.slice(1)).not.toContain(BOM);
    expect(onDisk).toContain("X# Title");
  });
});

describe("reloadDocumentFromMarkdown — guards", () => {
  it("rejects an unopened document with NO_DOCUMENT", async () => {
    await expect(reloadDocumentFromMarkdown("not-open", "# x")).rejects.toMatchObject({
      code: "NO_DOCUMENT",
    });
  });

  it("rejects a non-.md document with UNSUPPORTED_FORMAT", async () => {
    const filePath = path.join(tmpDir, "notes.txt");
    await fs.writeFile(filePath, "plain text\n", "utf-8");
    await openFromDisk(filePath);
    const id = docIdFromPath(filePath);

    await expect(reloadDocumentFromMarkdown(id, "# x")).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
  });

  it("rejects a read-only .md document with READ_ONLY", async () => {
    const filePath = path.join(tmpDir, "ro.md");
    await fs.writeFile(filePath, "# Read only\n", "utf-8");
    await openFromDisk(filePath, { readOnly: true });
    const id = docIdFromPath(filePath);

    await expect(reloadDocumentFromMarkdown(id, "# hacked")).rejects.toMatchObject({
      code: "READ_ONLY",
    });
  });
});

describe("reloadDocumentFromMarkdown — scratchpad (editable upload source)", () => {
  it("reloads an editable upload://-backed .md scratchpad without touching disk", async () => {
    const opened = await openScratchpad("# Scratch\n\nfirst\n");
    const id = opened.documentId;
    const doc = getOrCreateDocument(id);

    await reloadDocumentFromMarkdown(id, "# Scratch\n\nsecond\n");

    expect(extractText(doc)).toContain("second");
    expect(extractText(doc)).not.toContain("first");
  });

  // #2219: a scratchpad has no durable envelope, so the #1813 re-merge that
  // brings a file doc's annotations back never runs for it. Before the fix the
  // commit emptied the maps and every annotation on the scratchpad — personal
  // notes included — was gone for the rest of its life.
  async function openScratchDoc(initial: string): Promise<{ id: string; doc: Y.Doc }> {
    const opened = await openScratchpad(initial);
    return { id: opened.documentId, doc: getOrCreateDocument(opened.documentId) };
  }

  function onlyAnnotation(doc: Y.Doc): Annotation {
    const map = doc.getMap<Annotation>(Y_MAP_ANNOTATIONS);
    expect(map.size).toBe(1);
    return map.values().next().value as Annotation;
  }

  it("a personal note survives the commit, over the text it annotated (#2219)", async () => {
    const { id, doc } = await openScratchDoc("# Scratch\n\nKeep this note.\n\nTail.\n");
    seedAnnotation(doc, "this note", { type: "note", audience: "private" });

    await reloadDocumentFromMarkdown(id, "# Scratch\n\nKeep this note.\n\nTail, edited.\n");

    const after = onlyAnnotation(doc);
    expect(after.type).toBe("note");
    expect(extractText(doc).slice(after.range.from, after.range.to)).toBe("this note");
  });

  it("a record whose text MOVED is re-anchored, not left on its old offsets (#2219)", async () => {
    // The `size`-only form of this spec passes with no re-anchor at all; the
    // resolved TEXT is the property (#1813 review round 1, same shape).
    const { id, doc } = await openScratchDoc("# Scratch\n\nAlpha beta gamma.\n\nDelta epsilon.\n");
    seedAnnotation(doc, "Delta epsilon");
    const before = onlyAnnotation(doc);

    await reloadDocumentFromMarkdown(id, "# Scratch\n\nDelta epsilon.\n");

    const after = onlyAnnotation(doc);
    expect(after.range.from).not.toBe(before.range.from);
    expect(extractText(doc).slice(after.range.from, after.range.to)).toBe("Delta epsilon");
  });

  it("the note's reply thread survives (#2219)", async () => {
    const { id, doc } = await openScratchDoc("# Scratch\n\nKeep this note.\n");
    const annId = seedAnnotation(doc, "this note", { type: "note", audience: "private" });
    const reply: AnnotationReply = {
      id: "rep_1",
      annotationId: annId,
      author: "user",
      text: "a reply to myself",
      timestamp: Date.now(),
      private: true,
    };
    doc.transact(
      () => doc.getMap<AnnotationReply>(Y_MAP_ANNOTATION_REPLIES).set(reply.id, reply),
      MCP_ORIGIN,
    );

    await reloadDocumentFromMarkdown(id, "# Scratch\n\nKeep this note, edited.\n");

    expect(doc.getMap<AnnotationReply>(Y_MAP_ANNOTATION_REPLIES).get("rep_1")).toEqual(reply);
  });

  it("the record is never deleted mid-commit, and comes back otherwise unchanged (#2219)", async () => {
    const { id, doc } = await openScratchDoc("# Scratch\n\nKeep this note.\n");
    const annId = seedAnnotation(doc, "this note", { type: "note", audience: "private" });
    const before = onlyAnnotation(doc);
    const actions: string[] = [];
    const map = doc.getMap<Annotation>(Y_MAP_ANNOTATIONS);
    const observer = (e: Y.YMapEvent<Annotation>): void => {
      const change = e.changes.keys.get(annId);
      if (change) actions.push(change.action);
    };
    map.observe(observer);

    try {
      await reloadDocumentFromMarkdown(id, "# Scratch\n\nKeep this note, edited.\n");
    } finally {
      map.unobserve(observer);
    }

    expect(actions).not.toContain("delete");
    // Positive anchor: the observer did see the commit — the re-anchor pass
    // writes the record back — so the line above is not zero-of-zero.
    expect(actions).toContain("update");
    const after = onlyAnnotation(doc);
    const { range: _r1, relRange: _rr1, ...restBefore } = before;
    const { range: _r2, relRange: _rr2, ...restAfter } = after;
    expect(restAfter).toEqual(restBefore);
  });

  it("kept records are re-anchored BEFORE the session-delete await (#2219 review)", async () => {
    // Inside that I/O window any MCP read sees the map; a record still holding
    // its pre-commit offsets there would be served (or re-minted) at stale text.
    const { id, doc } = await openScratchDoc("# Scratch\n\nAlpha beta gamma.\n\nDelta epsilon.\n");
    seedAnnotation(doc, "Delta epsilon");
    let textAtDelete: string | undefined;
    vi.mocked(deleteSession).mockImplementationOnce(async () => {
      const ann = onlyAnnotation(doc);
      textAtDelete = extractText(doc).slice(ann.range.from, ann.range.to);
    });

    await reloadDocumentFromMarkdown(id, "# Scratch\n\nDelta epsilon.\n");

    expect(vi.mocked(deleteSession)).toHaveBeenCalled();
    expect(textAtDelete).toBe("Delta epsilon");
  });

  // `clearAndReload` re-attaches the event observers; it must not give a
  // scratchpad the annotation/reply channel observers an upload never carries.
  function annotationEventsAfterBrowserComment(doc: Y.Doc): string[] {
    // Without Tandem mode `pushEvent` drops user events and both specs pass vacuously.
    setCtrlMode("tandem");
    const { events, cleanup } = collectEvents("internal");
    try {
      const ann: Annotation = {
        id: `ann_browser_${Math.random().toString(36).slice(2, 8)}`,
        author: "user",
        type: "comment",
        audience: "outbound",
        range: { from: toFlatOffset(0), to: toFlatOffset(3) },
        content: "for Claude",
        status: "pending",
        timestamp: Date.now(),
      };
      withBrowser(doc, () => doc.getMap<Annotation>(Y_MAP_ANNOTATIONS).set(ann.id, ann));
    } finally {
      cleanup();
      setCtrlMode(null);
    }
    return events.filter((e) => e.type.startsWith("annotation:")).map((e) => e.type);
  }

  it("a scratchpad pushes no annotation events after a commit", async () => {
    const { id, doc } = await openScratchDoc("# Scratch\n\nbody\n");
    await reloadDocumentFromMarkdown(id, "# Scratch\n\nbody, edited\n");
    expect(annotationEventsAfterBrowserComment(doc)).toEqual([]);
  });

  it("control: a file doc does push them after a commit, so the probe can see one", async () => {
    const { id, doc } = await openMdFile("# Doc\n\nbody\n");
    await reloadDocumentFromMarkdown(id, "# Doc\n\nbody, edited\n");
    expect(annotationEventsAfterBrowserComment(doc)).not.toEqual([]);
  });
});

/**
 * The concurrent-reload guard spans two modules (#ADR-034 Unit 7a):
 * `reloadFromDisk` owns the Set in `documents/watcher.ts`, and
 * `reloadDocumentFromMarkdown` takes the SAME guard from `mcp/file-opener.ts`
 * so two clear+repopulate transactions never interleave on one Y.Doc.
 *
 * Before the split that was structural — one module-private Set — and so
 * nothing tested it. It is now a contract between modules, and the way it
 * breaks is silent: a second module declaring its own Set leaves both halves
 * green, every existing spec passing, and the serialization simply gone. Both
 * directions are asserted because a duplicate on either side is invisible from
 * the other.
 */
describe("reloadDocumentFromMarkdown — shares the watcher's reload guard", () => {
  it("refuses while the watcher's guard is held", async () => {
    const filePath = path.join(tmpDir, "guarded.md");
    await fs.writeFile(filePath, "# Doc\n\nbody\n", "utf-8");
    await openFromDisk(filePath);
    const id = docIdFromPath(filePath);

    // Taken through the watcher's own contract — the point is that this is the
    // guard file-opener consults, not a same-named one it declares itself.
    expect(acquireReloadGuard(id), "control: the guard was free to take").toBe(true);
    try {
      await expect(reloadDocumentFromMarkdown(id, "# hacked")).rejects.toMatchObject({
        code: "RELOAD_IN_PROGRESS",
      });
    } finally {
      releaseReloadGuard(id);
    }

    // Control: with the guard released the same call succeeds, so the rejection
    // above is the guard and not some other precondition of this fixture.
    await reloadDocumentFromMarkdown(id, "# after\n\nreleased\n");
    expect(extractText(getOrCreateDocument(id))).toContain("released");
  });

  it("is visible to the watcher while it holds the guard", async () => {
    const filePath = path.join(tmpDir, "observed.md");
    await fs.writeFile(filePath, "# Doc\n\nbody\n", "utf-8");
    await openFromDisk(filePath);
    const id = docIdFromPath(filePath);

    expect(isReloadInProgress(id), "control: not held before the call").toBe(false);

    let heldDuringReload: boolean | undefined;
    const populate = await import("../../src/server/documents/populate.js");
    const realClearAndReload = populate.clearAndReload;
    const spy = vi.spyOn(populate, "clearAndReload").mockImplementation(async (...args) => {
      // Read through the watcher's own probe: a duplicated Set in file-opener
      // would leave this false while the reload is genuinely in flight.
      heldDuringReload = isReloadInProgress(id);
      return await realClearAndReload(...args);
    });
    try {
      await reloadDocumentFromMarkdown(id, "# mid\n\nflight\n");
    } finally {
      spy.mockRestore();
    }

    expect(heldDuringReload, "the reload body ran at all").toBe(true);
    expect(isReloadInProgress(id), "released once the reload finished").toBe(false);
  });
});
