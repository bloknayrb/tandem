import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withBrowser } from "../../src/shared/origins.js";

// #1057: wireAnnotationStore must SIGNAL a genuine internal failure (a
// loadAndMerge throw) via `{ wired: false }` instead of swallowing it and
// returning normally. Without that signal renameDocument's `rewired` flag would
// stay true on an internal throw and its `!rewired` steal-vector guard would
// never fire — leaving the stale oldHash observer live to re-create the cleared
// envelope. These tests pin BOTH the helper-level contract and the rename-level
// guard.
//
// We mock ONLY `loadAndMerge` in the sync module and let it FALL THROUGH to the
// real impl unless a test installs an override. This keeps the rest of the sync
// module (mergeEnvelopeForward / migrateTombstoneLedger / persistSnapshot, all
// used by the real rename flow) genuinely running on disk. The override fires a
// throw scoped to a single re-wire by matching on `ctx.meta.filePath`, so the
// initial open's wiring at the OLD path is unaffected.
const syncOverride = vi.hoisted(() => ({
  loadAndMergeImpl: null as
    | null
    | ((
        ctx: { meta: { filePath: string }; docHash: string },
        opts?: unknown,
      ) => Promise<unknown> | unknown),
}));

vi.mock("../../src/server/annotations/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/annotations/sync.js")>();
  return {
    ...actual,
    loadAndMerge: (
      ctx: Parameters<typeof actual.loadAndMerge>[0],
      opts?: Parameters<typeof actual.loadAndMerge>[1],
    ) => {
      // Thread `opts` (carries migrateTombstonesFrom) through to the override so
      // the seam matches the real loadAndMerge signature; current overrides only
      // throw/reject and ignore it, but a future partial-delegating override won't
      // silently lose it.
      if (syncOverride.loadAndMergeImpl) return syncOverride.loadAndMergeImpl(ctx, opts);
      return actual.loadAndMerge(ctx, opts);
    },
  };
});

// Mock the session manager — saveSession/deleteSession touch disk for the
// .tandem session sidecar, orthogonal to what these tests exercise.
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
// the rename's own delete/create events.
vi.mock("../../src/server/file-watcher.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    watchFile: vi.fn(),
    unwatchFile: vi.fn(),
    suppressNextChange: vi.fn(),
  };
});

// Mock notifications — the failure path calls pushNotification; assert via spy.
vi.mock("../../src/server/notifications.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    pushNotification: vi.fn(),
  };
});

const fsReal = await import("node:fs/promises");
const { renameDocument } = await import("../../src/server/mcp/document-service.js");
const { addDoc, removeDoc } = await import("../../src/server/documents/registry.js");
const { getOpenDocs, setActiveDocId } = await import("../../src/server/mcp/document-service.js");
const { getOrCreateDocument } = await import("../../src/server/yjs/provider.js");
const { docHash } = await import("../../src/server/annotations/doc-hash.js");
const {
  createStore,
  envelopePath,
  resetForTesting: storeReset,
} = await import("../../src/server/annotations/store.js");
const { resetForTesting: syncReset } = await import("../../src/server/annotations/sync.js");
const { clearFileSyncContext, resetForTesting: queueReset } = await import(
  "../../src/server/events/queue.js"
);
const { wireAnnotationStore } = await import("../../src/server/mcp/file-opener.js");
const { pushNotification } = await import("../../src/server/notifications.js");

let docDir = "";
let appData = "";
let prevAppData: string | undefined;
let counter = 0;

beforeEach(async () => {
  prevAppData = process.env.TANDEM_APP_DATA_DIR;
  appData = await fsReal.mkdtemp(path.join(os.tmpdir(), "tandem-wire-fail-appdata-"));
  docDir = await fsReal.mkdtemp(path.join(os.tmpdir(), "tandem-wire-fail-docs-"));
  process.env.TANDEM_APP_DATA_DIR = appData;
  syncOverride.loadAndMergeImpl = null;
  vi.clearAllMocks();
  storeReset();
  syncReset();
  queueReset();
});

afterEach(async () => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  syncOverride.loadAndMergeImpl = null;
  storeReset();
  syncReset();
  queueReset();
  if (prevAppData === undefined) delete process.env.TANDEM_APP_DATA_DIR;
  else process.env.TANDEM_APP_DATA_DIR = prevAppData;
  await fsReal.rm(appData, { recursive: true, force: true }).catch(() => {});
  await fsReal.rm(docDir, { recursive: true, force: true }).catch(() => {});
});

async function openFileDoc(
  basename: string,
  body: string,
  opts: { wire?: boolean } = {},
): Promise<{ docId: string; filePath: string; doc: Y.Doc }> {
  const filePath = path.join(docDir, basename);
  await fsReal.writeFile(filePath, body, "utf-8");
  const docId = `wire-fail-doc-${counter++}`;
  addDoc(docId, { id: docId, filePath, format: "md", readOnly: false, source: "file" });
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

describe("wireAnnotationStore — internal-failure signalling (#1057)", () => {
  it("returns { wired: true } on a successful wire", async () => {
    const { docId, filePath, doc } = await openFileDoc("ok.md", "body", { wire: false });
    const result = await wireAnnotationStore(docId, doc, filePath, { allowRecovery: false });
    expect(result).toEqual({ wired: true });
    // The context was registered: clearFileSyncContext returns the dropped entry.
    expect(clearFileSyncContext(docId)).toBeDefined();
  });

  it("SWALLOWS an internal loadAndMerge throw but reports { wired: false }", async () => {
    const { docId, filePath, doc } = await openFileDoc("boom.md", "body", { wire: false });
    syncOverride.loadAndMergeImpl = () => {
      throw new Error("simulated internal loadAndMerge failure");
    };

    // Does NOT throw — the open/save must never fail on an annotation-wire error.
    const result = await wireAnnotationStore(docId, doc, filePath, { allowRecovery: false });
    expect(result).toEqual({ wired: false });

    // setFileSyncContext never ran, so no context is registered for this doc.
    expect(clearFileSyncContext(docId)).toBeUndefined();

    // The failure was surfaced to the user via the notification bus.
    expect(vi.mocked(pushNotification)).toHaveBeenCalledWith(
      expect.objectContaining({ type: "save-error", dedupKey: `annotation-wire:${docId}` }),
    );
  });

  it("reports { wired: false } when loadAndMerge REJECTS asynchronously", async () => {
    const { docId, filePath, doc } = await openFileDoc("reject.md", "body", { wire: false });
    syncOverride.loadAndMergeImpl = () =>
      Promise.reject(new Error("simulated async loadAndMerge rejection"));

    const result = await wireAnnotationStore(docId, doc, filePath, { allowRecovery: false });
    expect(result).toEqual({ wired: false });
    expect(clearFileSyncContext(docId)).toBeUndefined();
  });
});

describe("renameDocument — internal re-wire failure disposes the stale observer (#1057)", () => {
  // The gap #1057 closes: an INTERNAL loadAndMerge throw during the Phase-3
  // re-wire. wireAnnotationStore swallows it (so the committed rename stays
  // "renamed") but now reports { wired: false }, so renameDocument's `rewired`
  // flag stays false and the `!rewired` guard fires — disposing the still-live
  // oldHash observer before RMW step-2's clear(). Without the fix, `rewired`
  // would be true, the guard would be skipped, and a post-rename DELETE would
  // re-create <oldHash>.json (the steal vector).
  it("a DELETE after an INTERNAL re-wire failure does not re-create <oldHash>.json", async () => {
    const { docId, filePath, doc } = await openFileDoc("internal-fail.md", "body content");
    const annMap = doc.getMap(Y_MAP_ANNOTATIONS);

    withBrowser(doc, () => annMap.set("A", makeAnnotation("A")));
    const oldHash = docHash(filePath);
    await createStore(oldHash, { filePath }).flush();
    expect(await fileExists(envelopePath(oldHash))).toBe(true);

    const newPath = path.join(docDir, "internal-fail-renamed.md");

    // Throw ONLY for the Phase-3 re-wire at the NEW path. The initial open wired
    // at the OLD path (already done above), so this leaves that untouched and
    // exercises the internal-throw branch of wireAnnotationStore — which now
    // returns { wired: false } rather than throwing at the call boundary.
    syncOverride.loadAndMergeImpl = (ctx) => {
      if (ctx.meta.filePath === newPath) {
        throw new Error("simulated internal loadAndMerge failure at new path");
      }
      // Defensive: any other call (none expected here) falls back to a no-op
      // cleanup so it never accidentally throws.
      return () => {};
    };

    const result = await renameDocument(docId, "internal-fail-renamed.md");
    // The disk rename committed; an internal re-wire failure must NOT flip it.
    expect(result.status).toBe("renamed");

    // Disk renamed; the old envelope was cleared by RMW step-2.
    expect(await fileExists(newPath)).toBe(true);
    expect(await fileExists(envelopePath(oldHash))).toBe(false);

    // A concurrent DELETE arriving AFTER the rename returned. The !rewired guard
    // (fired because wired:false) disposed the stale oldHash observer, so this
    // mutation schedules NO write under oldHash — the steal vector stays closed.
    withBrowser(doc, () => annMap.delete("A"));
    // NOTE: this fixed sleep proves a write does NOT happen, so it is coupled to
    // the durable-store debounce interval — it must exceed it for the would-be
    // erroneous write to have fired. The store debounce is well under 400ms today
    // (DEBOUNCE_MS = 100 in annotations/store.ts); if that constant is ever raised
    // at/above 400ms, raise this sleep in lockstep or this
    // regression will go green for the wrong reason (the bad write simply hasn't
    // fired yet). The load-bearing guarantee remains "verified red without the fix".
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(await fileExists(envelopePath(oldHash))).toBe(false);
  });
});
