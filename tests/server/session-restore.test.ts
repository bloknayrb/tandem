import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CTRL_ROOM } from "../../src/shared/constants";

// Isolate session tests in a unique temp directory to avoid races with other test files
vi.mock("../../src/server/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  return {
    ...original,
    SESSION_DIR: pathMod.join(osMod.tmpdir(), `tandem-test-restore-${cryptoMod.randomUUID()}`),
  };
});

// Real fs.watch leaks handles and races the tests' own writes. The open paths
// only need this to be callable.
vi.mock("../../src/server/file-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
}));

// Failure-isolation twin (#1800): the open-path recovery must survive a
// throwing eviction. Flag-gated so every other case gets the real helper.
let evictShouldThrow = false;
vi.mock("../../src/server/documents/populate.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/documents/populate.js")>();
  return {
    ...original,
    evictPartialDocState: (doc: Y.Doc, docId: string | undefined) => {
      if (evictShouldThrow) throw new Error("evict boom (test)");
      return original.evictPartialDocState(doc, docId);
    },
  };
});

import { docHash } from "../../src/server/annotations/doc-hash.js";
import {
  closeStore,
  createStore,
  getAnnotationsDir,
  resetForTesting as storeReset,
} from "../../src/server/annotations/store.js";
import { resetForTesting as dirtyReset, isDirty } from "../../src/server/documents/dirty.js";
import { openFromDisk } from "../../src/server/documents/open.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { loadMarkdown } from "../../src/server/file-io/markdown.js";
import { docIdFromPath, extractText } from "../../src/server/mcp/document-model.js";
import { getOpenDocs, restoreOpenDocuments } from "../../src/server/mcp/document-service.js";
import {
  getBuffer,
  resetForTesting as notificationsReset,
} from "../../src/server/notifications.js";
import { SESSION_DIR } from "../../src/server/platform";
import {
  anchoredRange,
  flatOffsetToRelPos,
  refreshRange,
  relPosToFlatOffset,
} from "../../src/server/positions.js";
import {
  cleanupSessions,
  deleteSession,
  legacySessionKey,
  listSessionFilePaths,
  listSessionsMetadata,
  loadSession,
  quarantineSession,
  saveCtrlSession,
  saveSession,
  sessionKey,
} from "../../src/server/session/manager";
import { getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import {
  SESSION_MAX_AGE,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_AUTHORSHIP,
  Y_MAP_AWARENESS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_FIDELITY_REPORT,
  Y_MAP_FOOTNOTE_BODIES,
  Y_MAP_LINE_ENDING,
  Y_MAP_SAVED_AT_VERSION,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";
import type { AuthorshipRange } from "../../src/shared/types.js";
import { useTmpAnnotationsEnvWithFlag } from "../helpers/annotation-store-env.js";
import { buildDocxWithComments } from "../helpers/docx-fixtures.js";

// Unique paths to avoid collisions with other tests
const TEST_FILES = [
  path.resolve("tests/fixtures/restore-a.md"),
  path.resolve("tests/fixtures/restore-b.md"),
  path.resolve("tests/fixtures/restore-c.md"),
];

function createMinimalDoc(): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("default");
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText("test")]);
  fragment.insert(0, [p]);
  return doc;
}

describe("listSessionFilePaths", () => {
  beforeAll(async () => {
    await fs.mkdir(SESSION_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(SESSION_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    // Clean up all test session files
    for (const fp of TEST_FILES) {
      await deleteSession(fp).catch(() => {});
    }
    // Also clean up upload and ctrl sessions we may have created
    const uploadKey = sessionKey("upload://test-upload.md");
    const uploadPath = path.join(SESSION_DIR, `${uploadKey}.json`);
    await fs.unlink(uploadPath).catch(() => {});

    const ctrlKey = CTRL_ROOM;
    const ctrlPath = path.join(SESSION_DIR, `${ctrlKey}.json`);
    await fs.unlink(ctrlPath).catch(() => {});
  });

  it("returns empty array when no sessions exist", async () => {
    // Delete all test sessions first (afterEach already ran, but be safe)
    for (const fp of TEST_FILES) {
      await deleteSession(fp).catch(() => {});
    }
    // listSessionFilePaths may return other sessions from the real session dir,
    // so just check the function doesn't throw and returns an array
    const result = await listSessionFilePaths();
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns saved document sessions", async () => {
    const doc = createMinimalDoc();
    await saveSession(TEST_FILES[0], "md", doc);

    const result = await listSessionFilePaths();
    const match = result.find((r) => r.filePath === TEST_FILES[0]);
    expect(match).toBeDefined();
    expect(match!.lastAccessed).toBeGreaterThan(0);
  });

  it("skips ctrl session", async () => {
    // Save a ctrl session
    const ctrlDoc = new Y.Doc();
    await saveCtrlSession(ctrlDoc);

    const result = await listSessionFilePaths();
    // CTRL_ROOM should never appear in the results
    const ctrlMatch = result.find((r) => r.filePath === CTRL_ROOM);
    expect(ctrlMatch).toBeUndefined();
  });

  it("skips upload:// sessions", async () => {
    const doc = createMinimalDoc();
    await saveSession("upload://test-upload.md", "md", doc);

    const result = await listSessionFilePaths();
    const match = result.find((r) => r.filePath.startsWith("upload://"));
    expect(match).toBeUndefined();
  });

  it("sorts by lastAccessed descending (most recent first)", async () => {
    const doc = createMinimalDoc();

    // Save sessions with slight time gaps
    await saveSession(TEST_FILES[0], "md", doc);
    // Small delay to ensure distinct timestamps
    await new Promise((r) => setTimeout(r, 20));
    await saveSession(TEST_FILES[1], "md", doc);
    await new Promise((r) => setTimeout(r, 20));
    await saveSession(TEST_FILES[2], "md", doc);

    const result = await listSessionFilePaths();
    const testResults = result.filter((r) => TEST_FILES.includes(r.filePath));
    expect(testResults.length).toBe(3);

    // Most recently saved (TEST_FILES[2]) should be first
    expect(testResults[0].filePath).toBe(TEST_FILES[2]);
    expect(testResults[1].filePath).toBe(TEST_FILES[1]);
    expect(testResults[2].filePath).toBe(TEST_FILES[0]);
  });

  it("quarantines corrupt JSON files without throwing", async () => {
    // Write a corrupt session file directly
    await fs.mkdir(SESSION_DIR, { recursive: true });
    const corruptPath = path.join(SESSION_DIR, "corrupt-test-file.json");
    await fs.writeFile(corruptPath, "not valid json{{{", "utf-8");

    // Should not throw. Since #1800 the boot sweep quarantines (not skips):
    // the file is renamed to `<name>.json.corrupt.<ts>` and one file-keyed
    // notification fires. That notification accumulates in the module-level
    // buffer, so every getBuffer() assertion later in this file filters by
    // dedupKey rather than asserting the unfiltered length.
    const result = await listSessionFilePaths();
    expect(Array.isArray(result)).toBe(true);

    const files = await fs.readdir(SESSION_DIR);
    expect(files).not.toContain("corrupt-test-file.json");
    const quarantined = files.filter((f) => f.startsWith("corrupt-test-file.json.corrupt."));
    expect(quarantined).toHaveLength(1);

    // Clean up (the pre-#1800 unlink is gone, so this is a rename target now).
    await fs.unlink(path.join(SESSION_DIR, quarantined[0])).catch(() => {});
  });

  it("ignores non-JSON files", async () => {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    const nonJsonPath = path.join(SESSION_DIR, "readme.txt");
    await fs.writeFile(nonJsonPath, "not a session", "utf-8");

    const result = await listSessionFilePaths();
    // Just verify it didn't crash and doesn't include the txt file
    const match = result.find((r) => r.filePath.includes("readme.txt"));
    expect(match).toBeUndefined();

    await fs.unlink(nonJsonPath).catch(() => {});
  });
});

/**
 * #1800: a corrupt `ydocState` in a session file must not make the document
 * unopenable. The open catches the `restoreYDoc` throw, quarantines the file
 * to `<name>.json.corrupt.<ts>`, evicts the partial Y.Doc state, optionally
 * restores the migration-loser fallback, and falls back to disk — with one
 * `session-corrupt` notification per quarantined file.
 *
 * Fixture rule (Fix 4): every corrupt record is built by `saveSession` (which
 * stamps the current `modelRevision`) with `dirty: true`, and only then is
 * `ydocState` rewritten. A hand-written record omitting `modelRevision` is
 * stale, returns before `restoreYDoc`, never throws, and would make the
 * quarantine assertions fail looking like a bug in the fix.
 */
describe("corrupt ydocState quarantine (#1800)", () => {
  // Inside this describe only: registers module-scope beforeEach/afterEach
  // that retarget TANDEM_APP_DATA_DIR (so durable-envelope assertions never
  // touch the developer's real app-data dir) and default the annotation store
  // to on. NOT at file top, where it would retarget every case in the file.
  useTmpAnnotationsEnvWithFlag("tandem-1800-");

  let docRoot = "";

  beforeEach(async () => {
    // Without the registry reset a second openFromDisk of the same path takes
    // the already-open branch (open.ts) and never reaches maybeRestoreSession,
    // making every quarantine and notification assertion vacuous.
    for (const id of [...getOpenDocs().keys()]) {
      removeDoc(id);
      removeDocument(id);
    }
    setActiveDocId(null);
    storeReset();
    notificationsReset();
    dirtyReset();
    docRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-1800-"));
    // SESSION_DIR is shared across this file while docRoot is per-test, so a
    // session written by one case would be restored by the next. saveSession's
    // mkdir latch fires once per worker, so recreate the dir by hand after rm.
    await fs.rm(SESSION_DIR, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(SESSION_DIR, { recursive: true });
  });

  afterEach(async () => {
    evictShouldThrow = false;
    await fs.rm(docRoot, { recursive: true, force: true }).catch(() => {});
  });

  const DISK_TEXT = "# Disk\n\nThe content that is actually on disk.\n";
  const SESSION_TEXT = "# Session\n\nUnsaved edits that live only in the session file.\n";

  /** Same pipeline the .md adapter uses (file-io/index.ts), so pipeline-equality holds. */
  function textDoc(text: string): Y.Doc {
    const doc = new Y.Doc();
    doc.transact(() => loadMarkdown(doc, text), "internal");
    return doc;
  }

  /** Realpath first: openFromDisk realpaths before docIdFromPath/sessionKey. */
  async function writeDocFile(
    name: string,
    text: string,
  ): Promise<{ docPath: string; resolved: string }> {
    const docPath = path.join(docRoot, name);
    await fs.writeFile(docPath, text, "utf-8");
    return { docPath, resolved: await fs.realpath(docPath) };
  }

  type CorruptShape = "len-1" | "half" | "bitflip" | "deleted" | "empty-object";

  /** The exp3.ts corruption shapes (len-1 / half / bitflip) plus the
   * Buffer.from TypeError class (deleted / {}). */
  function corruptYdocState(full: Buffer, shape: CorruptShape): unknown {
    switch (shape) {
      case "len-1":
        return full.subarray(0, full.length - 1).toString("base64");
      case "half":
        return full.subarray(0, Math.floor(full.length / 2)).toString("base64");
      case "bitflip": {
        const f = Buffer.from(full);
        f[Math.floor(full.length / 2)] ^= 0xff;
        return f.toString("base64");
      }
      case "deleted":
        return undefined;
      case "empty-object":
        return {};
    }
  }

  async function writeSessionFile(
    resolved: string,
    format: string,
    seed: Y.Doc,
    dirty: boolean,
  ): Promise<string> {
    await saveSession(resolved, format, seed, dirty ? { dirty: true } : {});
    return path.join(SESSION_DIR, `${sessionKey(resolved)}.json`);
  }

  async function corruptSessionFile(
    sessionPath: string,
    seed: Y.Doc,
    shape: CorruptShape,
  ): Promise<void> {
    const rec = JSON.parse(await fs.readFile(sessionPath, "utf-8")) as Record<string, unknown>;
    const bad = corruptYdocState(Buffer.from(Y.encodeStateAsUpdate(seed)), shape);
    if (bad === undefined) delete rec.ydocState;
    else rec.ydocState = bad;
    await fs.writeFile(sessionPath, JSON.stringify(rec), "utf-8");
  }

  function sessionNotifications(dedupKey: string) {
    return getBuffer().filter((n) => n.dedupKey === dedupKey);
  }

  /** Scope "exactly one quarantine sibling" assertions by NAME: other cases'
   * quarantines share SESSION_DIR (bounded by the file's afterAll rm). */
  function quarantineNames(key: string, files: string[]) {
    return files.filter((f) => f.startsWith(`${key}.json.corrupt.`));
  }

  function seedHighlight(
    map: Y.Map<unknown>,
    id: string,
    from: number,
    to: number,
    extra?: Record<string, unknown>,
  ): void {
    map.set(id, {
      id,
      author: "user",
      type: "highlight",
      range: { from, to },
      content: "",
      status: "pending",
      timestamp: 1700000000000,
      textSnapshot: "",
      color: "yellow",
      rev: 1,
      ...extra,
    });
  }

  async function seedEnvelope(filePath: string, annotations: unknown[]): Promise<void> {
    const hash = docHash(filePath);
    const store = createStore(hash, { filePath });
    store.queueWrite(() => ({
      schemaVersion: 1,
      docHash: hash,
      meta: { filePath, lastUpdated: Date.now() },
      annotations,
      tombstones: [],
      replies: [],
    }));
    await store.flush();
  }

  async function readEnvelopeAnnotations(
    filePath: string,
  ): Promise<Array<Record<string, unknown>>> {
    const raw = await fs.readFile(
      path.join(getAnnotationsDir(), `${docHash(filePath)}.json`),
      "utf-8",
    );
    return (JSON.parse(raw) as { annotations: Array<Record<string, unknown>> }).annotations;
  }

  function insertTextPrefix(doc: Y.Doc, s: string): void {
    const frag = doc.getXmlFragment("default");
    const first = frag.get(0) as Y.XmlElement;
    const txt = first.get(0) as Y.XmlText;
    doc.transact(() => {
      txt.insert(0, s);
    }, "internal");
  }

  function appendParagraph(doc: Y.Doc, text: string): void {
    const frag = doc.getXmlFragment("default");
    const p = new Y.XmlElement("paragraph");
    frag.insert(frag.length, [p]);
    p.insert(0, [new Y.XmlText(text)]);
  }

  it.each([
    "len-1",
    "half",
    "bitflip",
    "deleted",
    "empty-object",
  ] as CorruptShape[])("corrupt ydocState (%s) opens from disk with a quarantine file and one toast", async (shape) => {
    const { resolved } = await writeDocFile("note.md", DISK_TEXT);
    const seed = textDoc(SESSION_TEXT);
    const sessionPath = await writeSessionFile(resolved, "md", seed, true);
    await corruptSessionFile(sessionPath, seed, shape);

    const res = await openFromDisk(resolved);
    expect(res.kind).toBe("fresh");
    const doc = getOrCreateDocument(res.documentId);
    // Disk content wins — pipeline-equality plus guards against a silent swap.
    expect(extractText(doc)).toBe(extractText(textDoc(DISK_TEXT)));
    expect(extractText(doc)).toContain("actually on disk");
    expect(extractText(doc)).not.toContain("live only in the session");
    expect(getOpenDocs().has(res.documentId)).toBe(true);

    const files = await fs.readdir(SESSION_DIR);
    expect(files).not.toContain(path.basename(sessionPath));
    expect(quarantineNames(sessionKey(resolved), files)).toHaveLength(1);

    const notes = sessionNotifications(`session-corrupt:${res.documentId}`);
    expect(notes).toHaveLength(1);
    const n = notes[0];
    expect(n.type).toBe("general-error");
    expect(n.severity).toBe("warning");
    expect(n.message).toContain("set aside");
    // The open-path message names the DOCUMENT, not the 64-hex session file.
    expect(n.message).toContain("note.md");
    expect(n.documentId).toBe(res.documentId);
    expect(n.dedupKey).toBe(`session-corrupt:${res.documentId}`);
    expect(typeof n.id).toBe("string");
    expect(n.id.length).toBeGreaterThan(0);
    expect(typeof n.timestamp).toBe("number");
  });

  it("quarantine refreshes the mtime so a back-dated session survives the next GC", async () => {
    const { resolved } = await writeDocFile("aging.md", DISK_TEXT);
    const seed = textDoc(SESSION_TEXT);
    const sessionPath = await writeSessionFile(resolved, "md", seed, true);
    await corruptSessionFile(sessionPath, seed, "len-1");
    const old = new Date(Date.now() - (SESSION_MAX_AGE + 86_400_000));
    await fs.utimes(sessionPath, old, old);

    const testStart = Date.now();
    await openFromDisk(resolved);

    const files = await fs.readdir(SESSION_DIR);
    const q = quarantineNames(sessionKey(resolved), files);
    expect(q).toHaveLength(1);
    const qStat = await fs.stat(path.join(SESSION_DIR, q[0]));
    // rename preserves mtime: without the touch this is still `old` and the
    // very next boot GCs the evidence. Date objects, not epoch millis —
    // numeric utimes args are SECONDS (EINVAL on Windows, year ~57000 on POSIX).
    expect(qStat.mtimeMs).toBeGreaterThanOrEqual(testStart - 10_000);

    await cleanupSessions();
    const after = await fs.readdir(SESSION_DIR);
    expect(quarantineNames(sessionKey(resolved), after)).toHaveLength(1);
  });

  it("an old .corrupt file from a real quarantine is still reaped by GC", async () => {
    const { resolved } = await writeDocFile("reaped.md", DISK_TEXT);
    const seed = textDoc(SESSION_TEXT);
    const sessionPath = await writeSessionFile(resolved, "md", seed, true);
    // Produced by a real quarantineSession call then back-dated — not
    // hand-named — so an implementation reading the age from the embedded
    // <ts> instead of the mtime goes red here.
    await quarantineSession(sessionPath);
    const files = await fs.readdir(SESSION_DIR);
    const q = quarantineNames(sessionKey(resolved), files);
    expect(q).toHaveLength(1);
    const old = new Date(Date.now() - (SESSION_MAX_AGE + 86_400_000));
    await fs.utimes(path.join(SESSION_DIR, q[0]), old, old);

    await cleanupSessions();
    const after = await fs.readdir(SESSION_DIR);
    expect(quarantineNames(sessionKey(resolved), after)).toHaveLength(0);
  });

  it("intact dirty session still restores the session content and its maps", async () => {
    const { resolved } = await writeDocFile("dirty.md", DISK_TEXT);
    const seed = textDoc(SESSION_TEXT);
    const flat = extractText(seed);
    const from = flat.indexOf("Unsaved edits");
    seedHighlight(seed.getMap(Y_MAP_ANNOTATIONS), "sess-ann", from, from + "Unsaved edits".length);
    seed.getMap(Y_MAP_ANNOTATION_REPLIES).set("sess-reply", {
      id: "sess-reply",
      author: "user",
      content: "reply",
      timestamp: 1700000000000,
    });
    await writeSessionFile(resolved, "md", seed, true);

    // Discriminating twin: an always-fall-back implementation restores DISK
    // here and fails the content assertion below.
    const res = await openFromDisk(resolved);
    expect(res.kind).toBe("restored");
    const doc = getOrCreateDocument(res.documentId);
    expect(extractText(doc)).toBe(extractText(seed));
    // A clear placed BEFORE restoreYDoc passes the content assertion above —
    // the update repopulates the fragment — while the local deletes out-clock
    // the incoming entries: the map assertions are what pin the placement.
    expect(doc.getMap(Y_MAP_ANNOTATIONS).size).toBe(1);
    expect(doc.getMap(Y_MAP_ANNOTATIONS).has("sess-ann")).toBe(true);
    expect(doc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(1);
    // .md over an unchanged file raises no banner; do not assert one.
  });

  it("partial state is evicted: ghost maps are cleared and the envelope keeps only the seed", async () => {
    const { resolved } = await writeDocFile("ghosts.md", DISK_TEXT);
    // The probe shape: annotations, replies, awareness, user-awareness and
    // authorship entries integrated before the throw. extractText does NOT
    // discriminate (every adapter clears the fragment itself) — the maps do.
    const seed = textDoc(SESSION_TEXT);
    const flat = extractText(seed);
    const annFrom = flat.indexOf("Unsaved edits");
    seedHighlight(seed.getMap(Y_MAP_ANNOTATIONS), "ghost-ann", annFrom, annFrom + 5);
    seed.getMap(Y_MAP_ANNOTATION_REPLIES).set("ghost-reply", {
      id: "ghost-reply",
      author: "user",
      content: "r",
      timestamp: 1700000000000,
    });
    seed.getMap(Y_MAP_AWARENESS).set("ghost-aw", { state: 1 });
    seed.getMap(Y_MAP_USER_AWARENESS).set("ghost-uaw", { state: 1 });
    // The fifth per-document map. Flat-only here is enough: the clear-path
    // assertion is size-based, and without the authorship seed it is vacuous.
    const authFrom = flat.indexOf("session file");
    seed.getMap(Y_MAP_AUTHORSHIP).set("ghost-auth", {
      id: "ghost-auth",
      author: "claude",
      range: { from: authFrom, to: authFrom + 5 },
      timestamp: 1700000000000,
    });
    const sessionPath = await writeSessionFile(resolved, "md", seed, true);
    await corruptSessionFile(sessionPath, seed, "len-1");

    // Durable half: one annotation in the on-disk envelope for the same doc.
    const diskFlat = extractText(textDoc(DISK_TEXT));
    const seedFrom = diskFlat.indexOf("actually on disk");
    await seedEnvelope(resolved, [
      {
        id: "seed-1",
        author: "user",
        type: "highlight",
        range: { from: seedFrom, to: seedFrom + 5 },
        content: "",
        status: "pending",
        timestamp: 1700000000000,
        textSnapshot: "",
        color: "yellow",
        rev: 1,
      },
    ]);

    const res = await openFromDisk(resolved);
    const doc = getOrCreateDocument(res.documentId);
    expect(extractText(doc)).toBe(extractText(textDoc(DISK_TEXT)));
    // Ghosts are gone; the maps hold only what the open put there (the
    // envelope seed re-hydrated via wireAnnotationStore — authorship has no
    // envelope merge, so it reads exactly what the recovery left: nothing).
    const annMap = doc.getMap(Y_MAP_ANNOTATIONS);
    expect(annMap.has("ghost-ann")).toBe(false);
    expect(annMap.has("seed-1")).toBe(true);
    expect(annMap.size).toBe(1);
    expect(doc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(0);
    expect(doc.getMap(Y_MAP_AWARENESS).size).toBe(0);
    expect(doc.getMap(Y_MAP_USER_AWARENESS).size).toBe(0);
    expect(doc.getMap(Y_MAP_AUTHORSHIP).size).toBe(0);

    // On a first open no observer is attached, so this discriminates
    // maps-cleared vs not — it says nothing about the clearFileSyncContext
    // order, which only the live-observer path could observe.
    await closeStore(docHash(resolved));
    const ids = (await readEnvelopeAnnotations(resolved)).map((a) => a["id"]);
    expect(ids).toEqual(["seed-1"]);
  });

  it("empty-fragment fall-through clears authorship ghosts and keeps the envelope clean", async () => {
    const { resolved } = await writeDocFile("emptyfrag.md", DISK_TEXT);
    // A legitimately-empty session (fragment empty, maps populated) restores
    // through the fall-through below the `fragment.length > 0` check.
    const seed = new Y.Doc();
    seed.getMap(Y_MAP_ANNOTATIONS).set("frag-ghost", {
      id: "frag-ghost",
      author: "user",
      type: "highlight",
      range: { from: 0, to: 1 },
      content: "",
      status: "pending",
      timestamp: 1700000000000,
      textSnapshot: "",
      color: "yellow",
      rev: 1,
    });
    seed.getMap(Y_MAP_AUTHORSHIP).set("frag-auth", {
      id: "frag-auth",
      author: "claude",
      range: { from: 0, to: 1 },
      timestamp: 1700000000000,
    });
    await writeSessionFile(resolved, "md", seed, true);

    const diskFlat = extractText(textDoc(DISK_TEXT));
    const seedFrom = diskFlat.indexOf("actually on disk");
    await seedEnvelope(resolved, [
      {
        id: "seed-2",
        author: "user",
        type: "highlight",
        range: { from: seedFrom, to: seedFrom + 5 },
        content: "",
        status: "pending",
        timestamp: 1700000000000,
        textSnapshot: "",
        color: "yellow",
        rev: 1,
      },
    ]);

    const res = await openFromDisk(resolved);
    const doc = getOrCreateDocument(res.documentId);
    expect(extractText(doc)).toBe(extractText(textDoc(DISK_TEXT)));
    expect(doc.getMap(Y_MAP_AUTHORSHIP).size).toBe(0);
    await closeStore(docHash(resolved));
    const ids = (await readEnvelopeAnnotations(resolved)).map((a) => a["id"]);
    expect(ids).toEqual(["seed-2"]);
  });

  it("EPERM on the quarantine rename still opens from disk with a failure toast", async () => {
    const { resolved } = await writeDocFile("eperm.md", DISK_TEXT);
    const seed = textDoc(SESSION_TEXT);
    const sessionPath = await writeSessionFile(resolved, "md", seed, true);
    await corruptSessionFile(sessionPath, seed, "len-1");

    // Installed AFTER fixture construction and scoped to the quarantine
    // target: saveSession and the annotation store flush both go through
    // atomicWrite, which renames — a module-level rejection breaks fixture
    // construction and the in-open store flush instead of only the quarantine.
    const origRename = fs.rename;
    const eperm = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    const renameSpy = vi.spyOn(fs, "rename");
    renameSpy.mockImplementation((async (src: string, dest: string) => {
      if (dest.includes(".corrupt.")) throw eperm;
      return origRename(src, dest);
    }) as unknown as typeof fs.rename);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const beforeMtime = (await fs.stat(sessionPath)).mtimeMs;
      const res = await openFromDisk(resolved);
      const doc = getOrCreateDocument(res.documentId);
      expect(extractText(doc)).toBe(extractText(textDoc(DISK_TEXT)));

      // The corrupt file remains and its mtime is untouched: utimes targets
      // the quarantine path, not the session — re-touching the session before
      // a rename that then fails would make a corrupt session immortal (never
      // GC'd) while passing both mtime cases.
      expect((await fs.stat(sessionPath)).mtimeMs).toBe(beforeMtime);
      const files = await fs.readdir(SESSION_DIR);
      expect(quarantineNames(sessionKey(resolved), files)).toHaveLength(0);

      expect(errSpy).toHaveBeenCalled();
      const notes = sessionNotifications(`session-corrupt:${res.documentId}`);
      expect(notes).toHaveLength(1);
      expect(notes[0].message).toContain("could not be read");
      expect(notes[0].message).not.toContain("set aside");
      expect(notes[0].type).toBe("general-error");
      expect(notes[0].severity).toBe("warning");
    } finally {
      renameSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("evict failure still opens from disk with a failure toast", async () => {
    const { resolved } = await writeDocFile("evictfail.md", DISK_TEXT);
    const seed = textDoc(SESSION_TEXT);
    const sessionPath = await writeSessionFile(resolved, "md", seed, true);
    await corruptSessionFile(sessionPath, seed, "len-1");

    evictShouldThrow = true;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await openFromDisk(resolved);
      const doc = getOrCreateDocument(res.documentId);
      expect(extractText(doc)).toBe(extractText(textDoc(DISK_TEXT)));

      // Nothing was set aside and the file re-throws on every later open, so
      // the toast carries the failure wording, not the past-tense contract.
      expect(
        await fs.stat(sessionPath).then(
          () => true,
          () => false,
        ),
      ).toBe(true);
      const files = await fs.readdir(SESSION_DIR);
      expect(quarantineNames(sessionKey(resolved), files)).toHaveLength(0);

      expect(errSpy).toHaveBeenCalled();
      const notes = sessionNotifications(`session-corrupt:${res.documentId}`);
      expect(notes).toHaveLength(1);
      expect(notes[0].message).toContain("could not be read");
      expect(notes[0].message).not.toContain("set aside");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("seeded durable annotation survives a corrupt-session open", async () => {
    const { resolved } = await writeDocFile("survive.md", DISK_TEXT);
    const seed = textDoc(SESSION_TEXT);
    const sessionPath = await writeSessionFile(resolved, "md", seed, true);
    await corruptSessionFile(sessionPath, seed, "half");

    const diskFlat = extractText(textDoc(DISK_TEXT));
    const seedFrom = diskFlat.indexOf("actually on disk");
    await seedEnvelope(resolved, [
      {
        id: "survivor",
        author: "user",
        type: "highlight",
        range: { from: seedFrom, to: seedFrom + 5 },
        content: "",
        status: "pending",
        timestamp: 1700000000000,
        textSnapshot: "",
        color: "yellow",
        rev: 1,
      },
    ]);

    const res = await openFromDisk(resolved);
    const doc = getOrCreateDocument(res.documentId);
    // Presence after wireAnnotationStore — anchor kind is pinned by the
    // fallback re-anchor cases below, not here.
    expect(doc.getMap(Y_MAP_ANNOTATIONS).get("survivor")).toBeDefined();
  });

  // ------------------------------------------------------------------
  // Post-A2 dual-name cases: legacy + hashed records for one document.
  // ------------------------------------------------------------------

  /** Branch one base doc twice so the two records share an ancestor (same
   * client/clock lineage for the shared structs).
   *
   * Under the clone design nothing applies an update to the live doc, so no
   * defect in this code needs the shared ancestor. It is kept because it is
   * the ONLY fixture that turns red if a future change reverts to
   * `applyUpdate` for the fallback: applying a shared-lineage update onto the
   * poisoned doc re-integrates the shared structs dead (measured: truncated
   * children/annotations with `restored: true`), while a disjoint-lineage
   * fixture yields the correct counts either way and cannot catch it. Do not
   * "simplify" this into two independently-constructed docs. */
  function branchFrom(base: Y.Doc, edit: (b: Y.Doc) => void): Y.Doc {
    const b = new Y.Doc();
    b.transact(() => {
      Y.applyUpdate(b, Y.encodeStateAsUpdate(base));
    }, "internal");
    b.transact(() => {
      edit(b);
    }, "internal");
    return b;
  }

  function liveRelRange(doc: Y.Doc, from: number, to: number) {
    const anchored = anchoredRange(doc, from, to);
    if (!anchored.ok || !anchored.fullyAnchored || !anchored.relRange) {
      throw new Error(`fixture range [${from}, ${to}] did not fully anchor`);
    }
    return anchored.relRange;
  }

  /**
   * Write the legacy + hashed records directly: the hashed (current) key is
   * the mtime winner, the legacy key the fallback. saveSession only writes
   * the current key (and removes the legacy one after), so the legacy record
   * is composed by hand from the same metadata envelope.
   */
  async function writeDualSessions(opts: {
    resolved: string;
    format: string;
    older: Y.Doc;
    newer: Y.Doc;
    olderDirty: boolean;
    newerDirty: boolean;
    corruptWinner: CorruptShape | null;
    corruptFallback: CorruptShape | null;
    olderSourceFileMtime?: number;
    newerSourceFileMtime?: number;
    plantUploadFilePathOnFallback?: boolean;
    omitModelRevisionOnFallback?: boolean;
  }): Promise<{ winnerPath: string; fallbackPath: string }> {
    await saveSession(
      opts.resolved,
      opts.format,
      opts.newer,
      opts.newerDirty ? { dirty: true } : {},
    );
    const winnerPath = path.join(SESSION_DIR, `${sessionKey(opts.resolved)}.json`);
    const fallbackPath = path.join(SESSION_DIR, `${legacySessionKey(opts.resolved)}.json`);
    const winnerRec = JSON.parse(await fs.readFile(winnerPath, "utf-8")) as Record<string, unknown>;
    const newerState = Buffer.from(Y.encodeStateAsUpdate(opts.newer)).toString("base64");
    if (opts.corruptWinner) {
      const bad = corruptYdocState(Buffer.from(newerState, "base64"), opts.corruptWinner);
      if (bad === undefined) delete winnerRec.ydocState;
      else winnerRec.ydocState = bad;
    } else {
      winnerRec.ydocState = newerState;
    }
    if (opts.newerSourceFileMtime !== undefined)
      winnerRec.sourceFileMtime = opts.newerSourceFileMtime;
    if (!opts.newerDirty) delete winnerRec.dirty;
    await fs.writeFile(winnerPath, JSON.stringify(winnerRec), "utf-8");

    const fallbackRec: Record<string, unknown> = {
      ...winnerRec,
      ydocState: Buffer.from(Y.encodeStateAsUpdate(opts.older)).toString("base64"),
    };
    if (opts.olderDirty) fallbackRec.dirty = true;
    else delete fallbackRec.dirty;
    if (opts.corruptFallback) {
      const bad = corruptYdocState(
        Buffer.from(Y.encodeStateAsUpdate(opts.older)),
        opts.corruptFallback,
      );
      if (bad === undefined) delete fallbackRec.ydocState;
      else fallbackRec.ydocState = bad;
    }
    if (opts.olderSourceFileMtime !== undefined)
      fallbackRec.sourceFileMtime = opts.olderSourceFileMtime;
    if (opts.plantUploadFilePathOnFallback) fallbackRec.filePath = "upload://planted.md";
    if (opts.omitModelRevisionOnFallback) delete fallbackRec.modelRevision;
    await fs.writeFile(fallbackPath, JSON.stringify(fallbackRec), "utf-8");

    // A2 defines no tie-break for equal mtimes (two writes in one tick can
    // tie on Windows granularity): the winner file is explicitly newer.
    const now = Date.now();
    await fs.utimes(fallbackPath, new Date(now - 20_000), new Date(now - 20_000));
    await fs.utimes(winnerPath, new Date(now - 10_000), new Date(now - 10_000));
    return { winnerPath, fallbackPath };
  }

  function buildDualBranches() {
    const base = textDoc("Shared opener paragraph.\n");
    const older = branchFrom(base, (b) => {
      appendParagraph(b, "Older divergent paragraph.\n");
      appendParagraph(b, "Third paragraph here.\n");
    });
    const newer = branchFrom(base, (b) => {
      appendParagraph(b, "Newer divergent paragraph.\n");
    });
    return { base, older, newer };
  }

  it("dual-name fallback restores the older session in full, not disk", async () => {
    const { resolved } = await writeDocFile("dual.md", DISK_TEXT);
    const { older, newer } = buildDualBranches();

    const olderFlat = extractText(older);
    const oAnn1 = olderFlat.indexOf("Shared opener");
    const oAnn2 = olderFlat.indexOf("divergent");
    const oAuth = olderFlat.indexOf("Third paragraph");
    older.transact(() => {
      seedHighlight(older.getMap(Y_MAP_ANNOTATIONS), "old-1", oAnn1, oAnn1 + 6, {
        relRange: liveRelRange(older, oAnn1, oAnn1 + 6),
      });
      seedHighlight(older.getMap(Y_MAP_ANNOTATIONS), "old-2", oAnn2, oAnn2 + 6, {
        relRange: liveRelRange(older, oAnn2, oAnn2 + 6),
      });
      older.getMap(Y_MAP_AUTHORSHIP).set("claude-old", {
        id: "claude-old",
        author: "claude",
        range: { from: oAuth, to: oAuth + 6 },
        relRange: liveRelRange(older, oAuth, oAuth + 6),
        timestamp: 1700000000000,
      });
      const meta = older.getMap(Y_MAP_DOCUMENT_META);
      meta.set(Y_MAP_LINE_ENDING, "\r\n");
      meta.set(Y_MAP_FOOTNOTE_BODIES, { v: "old" });
      // No fidelityReport on the fallback: exercises the mirror's delete half.
    }, "internal");
    newer.transact(() => {
      const meta = newer.getMap(Y_MAP_DOCUMENT_META);
      meta.set(Y_MAP_LINE_ENDING, "\r");
      meta.set(Y_MAP_FOOTNOTE_BODIES, { v: "new" });
      meta.set(Y_MAP_FIDELITY_REPORT, { r: "new" });
    }, "internal");

    const { winnerPath } = await writeDualSessions({
      resolved,
      format: "md",
      older,
      newer,
      olderDirty: false,
      newerDirty: false,
      corruptWinner: "len-1",
      corruptFallback: null,
    });

    const res = await openFromDisk(resolved);
    expect(res.kind).toBe("restored");
    const doc = getOrCreateDocument(res.documentId);
    // The fallback was taken, not disk: every fragment child of the older
    // branch present — child count, not just a substring.
    expect(older.getXmlFragment("default").length).toBe(3);
    expect(doc.getXmlFragment("default").length).toBe(3);
    expect(extractText(doc)).toBe(extractText(older));
    expect(extractText(doc)).toContain("Older divergent paragraph.");
    expect(extractText(doc)).not.toContain("actually on disk");
    // The annotation map holds every entry the older branch had.
    const annMap = doc.getMap(Y_MAP_ANNOTATIONS);
    expect(annMap.size).toBe(2);
    expect(annMap.has("old-1")).toBe(true);
    expect(annMap.has("old-2")).toBe(true);

    // Authorship: (i) the copied relRange RESOLVES on the live doc — red on
    // both copy-with-dead-relRange (resolves null) and strip (no relRange).
    const auth = doc.getMap(Y_MAP_AUTHORSHIP).get("claude-old") as unknown as AuthorshipRange;
    expect(auth?.relRange).toBeDefined();
    const r0 = relPosToFlatOffset(doc, auth.relRange!.fromRel);
    expect(r0).not.toBeNull();
    // (ii) A 5-char prefix insert shifts the resolved offset by 5 — pins the
    // claimed benefit (surviving edits), not merely anchor presence.
    insertTextPrefix(doc, "XXXX ");
    const authAfter = doc.getMap(Y_MAP_AUTHORSHIP).get("claude-old") as unknown as AuthorshipRange;
    expect(relPosToFlatOffset(doc, authAfter.relRange!.fromRel)).toBe((r0 as number) + 5);

    // documentMeta mirror: set-path on both differing keys, delete-path on
    // the winner-only key.
    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    expect(meta.get(Y_MAP_LINE_ENDING)).toBe("\r\n");
    expect(meta.get(Y_MAP_FOOTNOTE_BODIES)).toEqual({ v: "old" });
    expect(meta.has(Y_MAP_FIDELITY_REPORT)).toBe(false);

    // Quarantine pinned against the WINNER's key — "a .corrupt sibling
    // exists" would be satisfied by quarantining the loser instead.
    const files = await fs.readdir(SESSION_DIR);
    expect(files).not.toContain(path.basename(winnerPath));
    expect(quarantineNames(sessionKey(resolved), files)).toHaveLength(1);
    const dualNotes = sessionNotifications(`session-corrupt:${res.documentId}`);
    expect(dualNotes).toHaveLength(1);
    expect(dualNotes[0].message).toContain("dual.md");

    // A2 pin (passes whatever the fallback did — NOT evidence the recovered
    // edits survived; the content assertions above are): one saveSession
    // writes the hashed key and removes the legacy file.
    await saveSession(resolved, "md", doc);
    const afterSave = await fs.readdir(SESSION_DIR);
    expect(afterSave).toContain(`${sessionKey(resolved)}.json`);
    expect(afterSave).not.toContain(`${legacySessionKey(resolved)}.json`);
  });

  it("both-corrupt twin quarantines twice under one dedupKey and restores disk", async () => {
    const { resolved } = await writeDocFile("bothbad.md", DISK_TEXT);
    const { older, newer } = buildDualBranches();
    for (const [branch, tag] of [
      [older, "o"],
      [newer, "n"],
    ] as Array<[Y.Doc, string]>) {
      branch.transact(() => {
        seedHighlight(branch.getMap(Y_MAP_ANNOTATIONS), `${tag}-ghost`, 0, 5);
        branch.getMap(Y_MAP_AWARENESS).set(`${tag}-aw`, { state: 1 });
        branch.getMap(Y_MAP_AUTHORSHIP).set(`${tag}-auth`, {
          id: `${tag}-auth`,
          author: "claude",
          range: { from: 0, to: 5 },
          timestamp: 1700000000000,
        });
      }, "internal");
    }
    await writeDualSessions({
      resolved,
      format: "md",
      older,
      newer,
      olderDirty: true,
      newerDirty: true,
      corruptWinner: "len-1",
      corruptFallback: "half",
    });

    const res = await openFromDisk(resolved);
    expect(res.kind).toBe("fresh");
    const doc = getOrCreateDocument(res.documentId);
    expect(extractText(doc)).toBe(extractText(textDoc(DISK_TEXT)));
    // Fragment, annotation, awareness and authorship maps equal the
    // disk-loaded values: no ghost from either session.
    expect(doc.getXmlFragment("default").length).toBe(
      textDoc(DISK_TEXT).getXmlFragment("default").length,
    );
    expect(doc.getMap(Y_MAP_ANNOTATIONS).size).toBe(0);
    expect(doc.getMap(Y_MAP_AWARENESS).size).toBe(0);
    expect(doc.getMap(Y_MAP_AUTHORSHIP).size).toBe(0);

    const files = await fs.readdir(SESSION_DIR);
    expect(quarantineNames(sessionKey(resolved), files)).toHaveLength(1);
    expect(quarantineNames(legacySessionKey(resolved), files)).toHaveLength(1);
    // pushNotification has no server-side dedup (the client replaces by
    // dedupKey): TWO notifications with the same key. No twice-quarantining
    // case asserts a filtered length of 1.
    const bothNotes = sessionNotifications(`session-corrupt:${res.documentId}`);
    expect(bothNotes).toHaveLength(2);
    for (const note of bothNotes) expect(note.message).toContain("bothbad.md");

    // The durable envelope holds no annotation from either session.
    await closeStore(docHash(resolved));
    const envPath = path.join(getAnnotationsDir(), `${docHash(resolved)}.json`);
    if (
      await fs.stat(envPath).then(
        () => true,
        () => false,
      )
    ) {
      expect((await readEnvelopeAnnotations(resolved)).map((a) => a["id"])).toEqual([]);
    }
  });

  it("changed-clean fallback is discarded in favour of disk", async () => {
    const { resolved } = await writeDocFile("discard.md", DISK_TEXT);
    const { older, newer } = buildDualBranches();
    const mDisk = (await fs.stat(resolved)).mtimeMs;
    await writeDualSessions({
      resolved,
      format: "md",
      older,
      newer,
      olderDirty: false,
      newerDirty: true,
      corruptWinner: "len-1",
      corruptFallback: null,
      // The fallback's mtime predates a later external edit and it is not
      // dirty: today this record is refused and loaded from disk. Cloning it
      // in with restored:true would be the #1448 class on the recovery path.
      olderSourceFileMtime: mDisk + 50_000,
    });

    const res = await openFromDisk(resolved);
    const doc = getOrCreateDocument(res.documentId);
    expect(extractText(doc)).toBe(extractText(textDoc(DISK_TEXT)));
    expect(extractText(doc)).not.toContain("Older divergent");
    // The healthy fallback is NOT quarantined — only the corrupt winner is.
    expect(
      await fs.stat(path.join(SESSION_DIR, `${legacySessionKey(resolved)}.json`)).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    const discardNotes = sessionNotifications(`session-corrupt:${res.documentId}`);
    expect(discardNotes).toHaveLength(1);
    expect(discardNotes[0].message).toContain("discard.md");
  });

  it("upload-stamped fallback is sanitized to the caller path and discarded", async () => {
    const { resolved } = await writeDocFile("sanitize.md", DISK_TEXT);
    const { older, newer } = buildDualBranches();
    await writeDualSessions({
      resolved,
      format: "md",
      older,
      newer,
      olderDirty: false,
      newerDirty: true,
      corruptWinner: "len-1",
      corruptFallback: null,
      // A stored upload:// path short-circuits BOTH gates (staleness exempts
      // uploads; sourceFileChanged returns false for them), so without the
      // load-time filePath overwrite this fallback would be cloned over the
      // user's disk content. The omitted revision makes it stale once
      // sanitized to the real path.
      plantUploadFilePathOnFallback: true,
      omitModelRevisionOnFallback: true,
    });

    const res = await openFromDisk(resolved);
    const doc = getOrCreateDocument(res.documentId);
    expect(extractText(doc)).toBe(extractText(textDoc(DISK_TEXT)));
    expect(extractText(doc)).not.toContain("Older divergent");
  });

  it("three-mtime fixture re-derives savedAtVersion from the fallback and re-arms dirty", async () => {
    const { resolved } = await writeDocFile("mtimes.md", DISK_TEXT);
    const { older, newer } = buildDualBranches();
    const mDisk = (await fs.stat(resolved)).mtimeMs;
    // Three DISTINCT mtimes. Both records dirty (otherwise the winner fails
    // `if (!changed || dirtySession)` and restoreYDoc never throws). The
    // plain dual-name fixture cannot reach the :437 write: both records carry
    // the current disk mtime, changed is false, and savedAtVersion stays at
    // initSavedBaseline's value — which equals both records' mtime, so the
    // assertion below passes with the re-derivation deleted.
    const mWin = mDisk + 100_000;
    const mOld = mDisk + 200_000;
    await writeDualSessions({
      resolved,
      format: "md",
      older,
      newer,
      olderDirty: true,
      newerDirty: true,
      corruptWinner: "len-1",
      corruptFallback: null,
      olderSourceFileMtime: mOld,
      newerSourceFileMtime: mWin,
    });

    const res = await openFromDisk(resolved);
    const doc = getOrCreateDocument(res.documentId);
    expect(extractText(doc)).toBe(extractText(older));
    // Taken from the FALLBACK record: the winner's value here would prove the
    // re-derivation was skipped. The explicit session-file utimes above are
    // what make the CORRUPT record the winner — if the healthy one won,
    // restoreYDoc would never throw and this would pass with the fix absent.
    expect(doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_SAVED_AT_VERSION)).toBe(mOld);
    // A fallback that is dirty when the winner was not must yield
    // sessionDirty, or markDirty never fires and autosave treats
    // restored-but-unpersisted edits as clean.
    expect(isDirty(res.documentId)).toBe(true);
    // flagExternalConflict fired on the same open: filter by dedupKey, never
    // by severity, and do not assert documentMeta holds no conflict.
    const mtimeNotes = sessionNotifications(`session-corrupt:${res.documentId}`);
    expect(mtimeNotes).toHaveLength(1);
    expect(mtimeNotes[0].message).toContain("mtimes.md");
    expect(sessionNotifications(`external-conflict:${res.documentId}`)).toHaveLength(1);
  });

  it("unanchorable fallback authorship range is dropped with a warn", async () => {
    const { resolved } = await writeDocFile("authdrop.md", DISK_TEXT);
    const { older, newer } = buildDualBranches();
    const olderFlat = extractText(older);
    const okAt = olderFlat.indexOf("divergent");
    older.transact(() => {
      const auth = older.getMap(Y_MAP_AUTHORSHIP);
      auth.set("auth-ok", {
        id: "auth-ok",
        author: "claude",
        range: { from: okAt, to: okAt + 6 },
        relRange: liveRelRange(older, okAt, okAt + 6),
        timestamp: 1700000000000,
      });
      // Flat range beyond the recovered content: a re-rendered text would
      // shift it silently, so the honest state is unattributed, not kept.
      auth.set("auth-far", {
        id: "auth-far",
        author: "claude",
        range: { from: 500, to: 510 },
        timestamp: 1700000000000,
      });
    }, "internal");
    await writeDualSessions({
      resolved,
      format: "md",
      older,
      newer,
      olderDirty: false,
      newerDirty: false,
      corruptWinner: "len-1",
      corruptFallback: null,
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await openFromDisk(resolved);
      const doc = getOrCreateDocument(res.documentId);
      expect(doc.getMap(Y_MAP_AUTHORSHIP).has("auth-far")).toBe(false);
      expect(doc.getMap(Y_MAP_AUTHORSHIP).has("auth-ok")).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("docx fallback restores the mirror keys from the fallback branch", async () => {
    const buf = await buildDocxWithComments(1);
    const docPath = path.join(docRoot, "note.docx");
    await fs.writeFile(docPath, buf);
    const resolved = await fs.realpath(docPath);
    // The disk bytes are never parsed on the taken path (the clone replaces
    // the fragment with no adapter import running); they only need to exist
    // and stat. Both branches seed DIFFERENT footnote bodies and fidelity
    // reports so the assertions exercise the mirror, not a copy-when-present.
    const older = textDoc("Docx fallback body.\n");
    const newer = textDoc("Docx winner body.\n");
    older.transact(() => {
      const meta = older.getMap(Y_MAP_DOCUMENT_META);
      meta.set(Y_MAP_FOOTNOTE_BODIES, { fb: "old" });
      meta.set(Y_MAP_FIDELITY_REPORT, { r: "old" });
    }, "internal");
    newer.transact(() => {
      const meta = newer.getMap(Y_MAP_DOCUMENT_META);
      meta.set(Y_MAP_FOOTNOTE_BODIES, { fb: "new" });
      meta.set(Y_MAP_FIDELITY_REPORT, { r: "new" });
    }, "internal");
    await writeDualSessions({
      resolved,
      format: "docx",
      older,
      newer,
      olderDirty: false,
      newerDirty: false,
      corruptWinner: "half",
      corruptFallback: null,
    });

    const res = await openFromDisk(resolved);
    const doc = getOrCreateDocument(res.documentId);
    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    expect(meta.get(Y_MAP_FOOTNOTE_BODIES)).toEqual({ fb: "old" });
    expect(meta.get(Y_MAP_FIDELITY_REPORT)).toEqual({ r: "old" });
  });

  it("fallback annotations re-anchor after an edit (session-only and merged)", async () => {
    const { resolved } = await writeDocFile("reanchor.md", DISK_TEXT);
    // Exact layout "alpha beta gamma": the annotation over "beta" sits at
    // {6,10}, so after a 5-char prefix insert the arms read {11,15}/"beta"
    // (repaired) vs {6,10}/"lpha" (dead anchor re-minted from stale flats).
    const older = textDoc("alpha beta gamma\n");
    const newer = textDoc("alpha beta WINNER gamma\n");
    older.transact(() => {
      seedHighlight(older.getMap(Y_MAP_ANNOTATIONS), "ann-S", 11, 16, {
        relRange: liveRelRange(older, 11, 16),
      });
      // Same id in session and envelope: the envelope wins the merge and puts
      // its dead relRange straight back, so only the post-merge repair (site
      // b) can save it. Session records lack editedAt, so on a rev tie the
      // file wins (pickWinner heuristic) — seed exactly that shape.
      seedHighlight(older.getMap(Y_MAP_ANNOTATIONS), "ann-E", 6, 10, {
        relRange: liveRelRange(older, 6, 10),
      });
    }, "internal");
    await writeDualSessions({
      resolved,
      format: "md",
      older,
      newer,
      olderDirty: false,
      newerDirty: false,
      corruptWinner: "len-1",
      corruptFallback: null,
    });

    // The envelope carries the same id with a DEAD relRange: minted on a
    // different doc (unknown client/clock), so it resolves null on the live
    // doc while staying shape-valid through schema normalization.
    const otherDoc = textDoc("alpha beta gamma\n");
    const deadFrom = flatOffsetToRelPos(otherDoc, 6, 0);
    const deadTo = flatOffsetToRelPos(otherDoc, 10, -1);
    if (!deadFrom || !deadTo) throw new Error("dead-relRange fixture failed to mint");
    await seedEnvelope(resolved, [
      {
        id: "ann-E",
        author: "user",
        type: "highlight",
        range: { from: 6, to: 10 },
        content: "",
        status: "pending",
        timestamp: 1700000000000,
        textSnapshot: "beta",
        color: "yellow",
        rev: 1,
        editedAt: 1700000000001,
        relRange: { fromRel: deadFrom, toRel: deadTo },
      },
    ]);

    const res = await openFromDisk(resolved);
    const doc = getOrCreateDocument(res.documentId);
    const liveMap = doc.getMap(Y_MAP_ANNOTATIONS);
    insertTextPrefix(doc, "XXXX ");

    // Resolution reads the STORED record, so call refreshRange the way a
    // later action would: repaired means the clone-time repair ran, "ok" or
    // "attached" would be vacuous here, and reading .range directly is red on
    // the fix (nothing refreshes a stored record on edit).
    const storedS = liveMap.get("ann-S") as unknown as Parameters<typeof refreshRange>[0];
    const rS = refreshRange(storedS, doc, liveMap);
    expect(rS.kind).toBe("updated");
    expect(rS.annotation.range).toEqual({ from: 16, to: 21 });
    expect(extractText(doc).slice(rS.annotation.range.from, rS.annotation.range.to)).toBe("gamma");

    const storedE = liveMap.get("ann-E") as unknown as Parameters<typeof refreshRange>[0];
    const rE = refreshRange(storedE, doc, liveMap);
    expect(rE.kind).toBe("updated");
    expect(rE.annotation.range).toEqual({ from: 11, to: 15 });
    expect(extractText(doc).slice(rE.annotation.range.from, rE.annotation.range.to)).toBe("beta");
  });

  it("post-merge repair reaches the on-disk envelope", async () => {
    // Durability twin of the case above with NO session-only ids: mergeMap
    // then sets needsWrite false (file wins every comparison), so the merge
    // queues NOTHING and the envelope can only change via the site-(b)
    // observer write. (With a session-only id present the lazy post-merge
    // thunk would capture the repaired in-memory state at flush and this
    // case would pass with the origin wrong.)
    const { resolved } = await writeDocFile("reanchor-disk.md", DISK_TEXT);
    const older = textDoc("alpha beta gamma\n");
    const newer = textDoc("alpha beta WINNER gamma\n");
    older.transact(() => {
      seedHighlight(older.getMap(Y_MAP_ANNOTATIONS), "ann-E", 6, 10, {
        relRange: liveRelRange(older, 6, 10),
      });
    }, "internal");
    await writeDualSessions({
      resolved,
      format: "md",
      older,
      newer,
      olderDirty: false,
      newerDirty: false,
      corruptWinner: "len-1",
      corruptFallback: null,
    });

    const otherDoc = textDoc("alpha beta gamma\n");
    const deadFrom = flatOffsetToRelPos(otherDoc, 6, 0);
    const deadTo = flatOffsetToRelPos(otherDoc, 10, -1);
    if (!deadFrom || !deadTo) throw new Error("dead-relRange fixture failed to mint");
    await seedEnvelope(resolved, [
      {
        id: "ann-E",
        author: "user",
        type: "highlight",
        range: { from: 6, to: 10 },
        content: "",
        status: "pending",
        timestamp: 1700000000000,
        textSnapshot: "beta",
        color: "yellow",
        rev: 1,
        editedAt: 1700000000001,
        relRange: { fromRel: deadFrom, toRel: deadTo },
      },
    ]);

    const res = await openFromDisk(resolved);
    const doc = getOrCreateDocument(res.documentId);
    // No test-side map writes before the flush: the envelope must reflect
    // only open-path writes. The site-(b) repair runs under the default
    // (withMcp) transact, so the attached observer queues the repaired state
    // and the flush persists a relRange that resolves. A withFileSync repair
    // would queue nothing and the envelope would keep the dead anchor.
    await closeStore(docHash(resolved));
    const envE = (await readEnvelopeAnnotations(resolved)).find((a) => a["id"] === "ann-E");
    expect(envE).toBeDefined();
    const envRel = envE!["relRange"] as { fromRel: never; toRel: never };
    expect(relPosToFlatOffset(doc, envRel.fromRel)).toBe(6);
    expect(relPosToFlatOffset(doc, envRel.toRel)).toBe(10);
    expect(extractText(doc).slice(6, 10)).toBe("beta");
  });

  it("live-room maps survive an open with no session file", async () => {
    const { resolved } = await writeDocFile("liveroom.md", DISK_TEXT);
    // Derive the room id from the RESOLVED path: openFromDisk realpaths
    // before docIdFromPath, so seeding under the raw tmp path seeds a
    // different room wherever the tmpdir realpath differs, and "entries
    // survive" is then vacuously true.
    const id = docIdFromPath(resolved);
    const room = getOrCreateDocument(id);
    room.transact(() => {
      seedHighlight(room.getMap(Y_MAP_ANNOTATIONS), "room-ann", 0, 4);
      room.getMap(Y_MAP_AUTHORSHIP).set("room-auth", {
        id: "room-auth",
        author: "claude",
        range: { from: 0, to: 4 },
        timestamp: 1700000000000,
      });
    }, "internal");

    const res = await openFromDisk(resolved);
    expect(res.documentId).toBe(id);
    // Identity: the open used the pre-seeded room, not a fresh doc.
    expect(getOrCreateDocument(res.documentId)).toBe(room);
    expect(room.getMap(Y_MAP_ANNOTATIONS).has("room-ann")).toBe(true);
    expect(room.getMap(Y_MAP_AUTHORSHIP).has("room-auth")).toBe(true);
  });

  it("live-room maps survive an open whose clean session loses to disk", async () => {
    const { resolved } = await writeDocFile("livedisk.md", DISK_TEXT);
    // Clean session, then the source changes on disk: changed && !dirty, so
    // restoreYDoc never runs. A clear placed at the shared return (even
    // under `if (session)`) would wipe the room's maps on every open of an
    // externally-edited file; the no-session negative above would still pass.
    const seed = textDoc(SESSION_TEXT);
    const sessionPath = await writeSessionFile(resolved, "md", seed, false);
    // Force changed=true deterministically: same-millisecond stat/write
    // granularity can otherwise tie the mtimes and restore the session.
    const rec = JSON.parse(await fs.readFile(sessionPath, "utf-8")) as Record<string, unknown>;
    rec.sourceFileMtime = 1;
    await fs.writeFile(sessionPath, JSON.stringify(rec), "utf-8");
    await fs.writeFile(resolved, `${DISK_TEXT}\nAn external edit.\n`, "utf-8");

    const id = docIdFromPath(resolved);
    const room = getOrCreateDocument(id);
    room.transact(() => {
      seedHighlight(room.getMap(Y_MAP_ANNOTATIONS), "room-ann-2", 0, 4);
    }, "internal");

    const res = await openFromDisk(resolved);
    expect(res.documentId).toBe(id);
    expect(getOrCreateDocument(res.documentId)).toBe(room);
    expect(room.getMap(Y_MAP_ANNOTATIONS).has("room-ann-2")).toBe(true);
    expect(extractText(room)).toContain("An external edit.");
  });

  it("restoreOpenDocuments restores a corrupt-ydocState tab from disk", async () => {
    const a = await writeDocFile("restore-a.md", DISK_TEXT);
    const b = await writeDocFile("restore-b.md", DISK_TEXT);
    const seedA = textDoc(SESSION_TEXT);
    const spA = await writeSessionFile(a.resolved, "md", seedA, true);
    await corruptSessionFile(spA, seedA, "len-1");
    const seedB = textDoc(SESSION_TEXT);
    await writeSessionFile(b.resolved, "md", seedB, true);

    const count = await restoreOpenDocuments(null);
    expect(count).toBe(2);
    // Both tabs open: the corrupt one came back from disk, the healthy one
    // from its session.
    const openIds = new Set(getOpenDocs().keys());
    expect(openIds.has(docIdFromPath(a.resolved))).toBe(true);
    expect(openIds.has(docIdFromPath(b.resolved))).toBe(true);
    const files = await fs.readdir(SESSION_DIR);
    expect(quarantineNames(sessionKey(a.resolved), files)).toHaveLength(1);
    expect(quarantineNames(sessionKey(b.resolved), files)).toHaveLength(0);
  });

  it("unparseable-JSON session is quarantined by the boot sweep, healthy restores", async () => {
    const a = await writeDocFile("restore-c.md", DISK_TEXT);
    const b = await writeDocFile("restore-d.md", DISK_TEXT);
    await fs.writeFile(path.join(SESSION_DIR, `${sessionKey(a.resolved)}.json`), "{", "utf-8");
    const seedB = textDoc(SESSION_TEXT);
    await writeSessionFile(b.resolved, "md", seedB, true);

    // Red before the fix: the unparseable file was only "skipped" and the tab
    // silently did not come back.
    const count = await restoreOpenDocuments(null);
    expect(count).toBe(1);
    const files = await fs.readdir(SESSION_DIR);
    expect(quarantineNames(sessionKey(a.resolved), files)).toHaveLength(1);
    expect(
      sessionNotifications(`session-corrupt-file:${sessionKey(a.resolved)}.json`),
    ).toHaveLength(1);
  });

  it("loadSession with unparseable JSON returns null and quarantines instead of unlinking", async () => {
    const { resolved } = await writeDocFile("unparsable.md", DISK_TEXT);
    // No test asserts the old unlink today (session-restore.test.ts only
    // checks the listing does not throw) — stated, not hunted.
    await fs.writeFile(path.join(SESSION_DIR, `${sessionKey(resolved)}.json`), "{", "utf-8");

    expect(await loadSession(resolved)).toBeNull();
    const files = await fs.readdir(SESSION_DIR);
    expect(files).not.toContain(`${sessionKey(resolved)}.json`);
    expect(quarantineNames(sessionKey(resolved), files)).toHaveLength(1);
    // The loadSessionWithPath SyntaxError branch names the DOCUMENT: full
    // file-keyed dedup key on the document basename (prefix-only assertions
    // would pass either way).
    const notes = sessionNotifications("session-corrupt-file:unparsable.md");
    expect(notes).toHaveLength(1);
    expect(notes[0].documentId).toBeUndefined();
    expect(notes[0].message).toContain("unparsable.md");
  });

  it("listSessionFilePaths ignores .corrupt siblings; quarantine output is not .json", async () => {
    const { resolved } = await writeDocFile("suffix.md", DISK_TEXT);
    const seed = textDoc(SESSION_TEXT);
    const sessionPath = await writeSessionFile(resolved, "md", seed, true);

    await quarantineSession(sessionPath);
    // Assert on the DISK name, not a returned string: the name's suffix order
    // is the exclusion mechanism (only `.endsWith(".json")` is filtered), so
    // `<key>.corrupt.<ts>.json` would be listed, parsed, and restored as a
    // duplicate. No positive assertion pins that bug as behaviour.
    const files = await fs.readdir(SESSION_DIR);
    const produced = files.filter((f) => f.includes(".corrupt."));
    expect(produced).toHaveLength(1);
    expect(produced[0].endsWith(".json")).toBe(false);

    const listed = await listSessionFilePaths();
    expect(listed.find((r) => r.filePath === resolved)).toBeUndefined();
  });

  it("Recents quarantines an unparseable record mid-session with a file-keyed toast", async () => {
    const { resolved } = await writeDocFile("recent-ok.md", DISK_TEXT);
    const seed = textDoc(SESSION_TEXT);
    await writeSessionFile(resolved, "md", seed, true);
    await fs.writeFile(path.join(SESSION_DIR, "orphan-broken.json"), "{", "utf-8");

    // listSessionsMetadata is the Recents/UI listing: a refresh can
    // quarantine mid-session, which IS a live, deliverable toast path.
    const metas = await listSessionsMetadata();
    expect(metas.find((m) => m.filePath === resolved)).toBeDefined();
    const files = await fs.readdir(SESSION_DIR);
    expect(files).not.toContain("orphan-broken.json");
    expect(files.filter((f) => f.startsWith("orphan-broken.json.corrupt."))).toHaveLength(1);

    const notes = sessionNotifications("session-corrupt-file:orphan-broken.json");
    expect(notes).toHaveLength(1);
    expect(notes[0].documentId).toBeUndefined();
    expect(notes[0].message).toContain("orphan-broken.json");
  });
});
