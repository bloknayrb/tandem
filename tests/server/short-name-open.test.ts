/**
 * One file, one document, and the records stored under an 8.3 short spelling
 * (#2400, Requirements 1, 2 and 4), through the real open and restore paths.
 *
 * Runs on every host: the platform and the native realpath are injected
 * (`tests/helpers/short-name-fixture.ts`), and the alias is a hard link so
 * every real filesystem call resolves. That fixture can only alias a FILE
 * name; a short FOLDER component runs on a real Windows volume in
 * `short-name-documents.win.test.ts`.
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("../../src/server/platform"), async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  return {
    ...original,
    SESSION_DIR: pathMod.join(osMod.tmpdir(), `tandem-test-shortname-${cryptoMod.randomUUID()}`),
  };
});

vi.mock(import("../../src/server/file-watcher"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
}));

// The backup writer, made to fail on demand. Every other case gets the real one.
let backupShouldFail = false;
vi.mock(import("../../src/server/file-io/doc-backup.js"), async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/file-io/doc-backup.js")>();
  return {
    ...original,
    writeDocBackupContent: (...args: Parameters<typeof original.writeDocBackupContent>) =>
      backupShouldFail
        ? Promise.resolve("failed" as const)
        : original.writeDocBackupContent(...args),
  };
});

// The annotation store's wiring, made to fail on demand: the document then
// opens with no file-sync context ("the store is not wired for it").
let wiringShouldFail = false;
vi.mock(import("../../src/server/documents/annotation-wiring.js"), async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/server/documents/annotation-wiring.js")>();
  return {
    ...original,
    wireAnnotationStore: (...args: Parameters<typeof original.wireAnnotationStore>) =>
      wiringShouldFail ? Promise.resolve({ wired: false }) : original.wireAnnotationStore(...args),
  };
});

import * as Y from "yjs";
import { contentHash, docHash } from "../../src/server/annotations/doc-hash.js";
import { parseAnnotationDoc } from "../../src/server/annotations/schema.js";
import {
  acquireStoreLock,
  closeStore,
  envelopePath,
  getAnnotationsDir,
  quiesceForTesting,
  releaseStoreLock,
  resetForTesting as storeReset,
} from "../../src/server/annotations/store.js";
import { getTombstones, resetForTesting as syncReset } from "../../src/server/annotations/sync.js";
import { openFromDisk, openFromRestore } from "../../src/server/documents/open.js";
import { keepLegacySessionInWindow } from "../../src/server/documents/short-name-adoption.js";
import {
  attachObservers,
  detachObservers,
  getFileSyncContext,
} from "../../src/server/events/queue.js";
import {
  _resetDocBackupGateForTests,
  docBackupsRoot,
  listDocBackups,
} from "../../src/server/file-io/doc-backup.js";
import { watchFile } from "../../src/server/file-watcher.js";
import { docIdFromPath, extractText } from "../../src/server/mcp/document-model.js";
import {
  autoSaveAllToDisk,
  closeDocumentById,
  getOpenDocs,
  restoreOpenDocuments,
  saveCurrentSession,
} from "../../src/server/mcp/document-service.js";
import { resetForTesting as notificationsReset } from "../../src/server/notifications.js";
import { resolveAppDataDir, SESSION_DIR } from "../../src/server/platform";
import { anchoredRange, refreshRange, relPosToFlatOffset } from "../../src/server/positions.js";
import {
  cleanupSessions,
  legacySessionKey,
  listSessionFilePaths,
  saveSession,
  sessionKey,
  stopAutoSave,
} from "../../src/server/session/manager";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_READ_ONLY,
} from "../../src/shared/constants.js";
import { withBrowser, withInternal } from "../../src/shared/origins.js";
import type { Annotation, ExternalConflictState } from "../../src/shared/types.js";
import {
  annRecord,
  makeAnnotationDoc,
  replyRecord,
  writeEnvelopeToDisk,
} from "../helpers/annotation-fixtures.js";
import { useTmpAnnotationsEnvWithFlag } from "../helpers/annotation-store-env.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { collectEvents } from "../helpers/event-collector.js";
import { off } from "../helpers/positions.js";
import {
  ALIAS_NAME,
  type AliasFixture,
  docFromMarkdown,
  installAliasExpansion,
  LONG_NAME,
  makeAliasFixture,
  simulateRestart,
  uninstallAliasExpansion,
} from "../helpers/short-name-fixture.js";

useTmpAnnotationsEnvWithFlag("tandem-shortname-");

let fx: AliasFixture;
let spies: ReturnType<typeof installAliasExpansion>;

const DISK = "alpha beta gamma\n";

beforeAll(async () => {
  await fs.mkdir(SESSION_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(SESSION_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  // A connected client in Tandem mode, so channel events flow: "no event" in
  // these tests then means none was emitted, not that Solo held it.
  setCtrlMode("tandem");
  backupShouldFail = false;
  wiringShouldFail = false;
  fx = await makeAliasFixture(DISK);
  spies = installAliasExpansion();
  _resetDocBackupGateForTests();
});

afterEach(async () => {
  await simulateRestart();
  stopAutoSave();
  uninstallAliasExpansion();
  vi.restoreAllMocks();
  await quiesceForTesting();
  storeReset();
  syncReset();
  notificationsReset();
  for (const f of await fs.readdir(SESSION_DIR).catch(() => [])) {
    await fs.rm(path.join(SESSION_DIR, f), { force: true });
  }
  await fx.cleanup();
});

// --- small helpers ---------------------------------------------------------

const sessionFile = (p: string) => path.join(SESSION_DIR, `${sessionKey(p)}.json`);
const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );
const sessionFiles = async () =>
  (await fs.readdir(SESSION_DIR)).filter((f) => f.endsWith(".json")).sort();
const liveText = (id: string) => extractText(getOrCreateDocument(id));
const liveAnnotations = (id: string) =>
  new Map([...getOrCreateDocument(id).getMap(Y_MAP_ANNOTATIONS).entries()] as Array<
    [string, Annotation]
  >);

async function backupTexts(): Promise<string[]> {
  const dir = path.join(docBackupsRoot(resolveAppDataDir()), docHash(fx.longPath));
  const out: string[] = [];
  for (const b of await listDocBackups(fx.longPath, resolveAppDataDir())) {
    out.push(await fs.readFile(path.join(dir, b.name), "utf-8"));
  }
  return out;
}

/**
 * A saved session under `keyPath`'s key, holding `markdown` and optional
 * records. `annotate` builds records against the session's own document, so
 * their `relRange` resolves in it; the records it made are returned.
 */
async function storeSession(
  keyPath: string,
  markdown: string,
  opts: {
    dirty?: boolean;
    lastAccessed?: number;
    conflict?: ExternalConflictState;
    annotations?: Array<Record<string, unknown>>;
    annotate?: (doc: Y.Doc) => Array<Record<string, unknown>>;
  } = {},
): Promise<Array<Record<string, unknown>>> {
  const doc = await docFromMarkdown(markdown);
  const map = doc.getMap(Y_MAP_ANNOTATIONS);
  const made = opts.annotate?.(doc) ?? [];
  for (const a of [...(opts.annotations ?? []), ...made]) map.set(a.id as string, a);
  await saveSession(keyPath, "md", doc, {
    dirty: opts.dirty ?? true,
    ...(opts.lastAccessed !== undefined ? { lastAccessed: opts.lastAccessed } : {}),
    ...(opts.conflict ? { conflict: opts.conflict } : {}),
  });
  doc.destroy();
  return made;
}

/** A user comment on the first occurrence of `word`, anchored in `doc` (live relRange, no snapshot). */
function anchoredOn(
  doc: Y.Doc,
  id: string,
  word: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const from = extractText(doc).indexOf(word);
  if (from < 0) throw new Error(`fixture: "${word}" is not in the document`);
  const anchored = anchoredRange(doc, off(from), off(from + word.length));
  if (!anchored.ok || !anchored.relRange) throw new Error("fixture: could not anchor");
  return {
    ...annRecord({ id, author: "user", rev: 1, range: anchored.range }),
    relRange: anchored.relRange,
    ...extra,
  };
}

/** Rewrite one stored session file's JSON in place. */
async function editStoredSession(
  keyPath: string,
  edit: (stored: Record<string, unknown>) => void,
): Promise<void> {
  const file = sessionFile(keyPath);
  const stored = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
  edit(stored);
  await fs.writeFile(file, JSON.stringify(stored), "utf-8");
}

/** Make `fs.readFile` reject with `code` for one file until the returned function is called. */
function failReadsOf(file: string, code: string): () => void {
  const real = fs.readFile.bind(fs) as (...a: unknown[]) => Promise<unknown>;
  const spy = vi.spyOn(fs, "readFile").mockImplementation(((p: unknown, ...rest: unknown[]) =>
    p === file
      ? Promise.reject(Object.assign(new Error(code), { code }))
      : real(p, ...rest)) as never);
  return () => spy.mockRestore();
}

async function storeEnvelope(
  keyPath: string,
  overrides: Parameters<typeof makeAnnotationDoc>[2],
): Promise<void> {
  await writeEnvelopeToDisk(makeAnnotationDoc(docHash(keyPath), keyPath, overrides));
}

async function readEnvelope(keyPath: string) {
  const raw = await fs.readFile(envelopePath(docHash(keyPath)), "utf-8");
  const parsed = parseAnnotationDoc(raw);
  if (!parsed.ok) throw new Error("envelope did not parse");
  return parsed.doc;
}

const T0 = Date.now() - 60_000;

// ---------------------------------------------------------------------------

describe("Requirement 1: one file, one document", () => {
  it("long then alias: one registry entry, the second open reports already open", async () => {
    const first = await openFromDisk(fx.longPath);
    const second = await openFromDisk(fx.aliasPath);
    expect(second.kind).toBe("already-open");
    expect(second.documentId).toBe(first.documentId);
    expect(getOpenDocs().size).toBe(1);
  });

  it("alias then long: one registry entry, the second open reports already open", async () => {
    const first = await openFromDisk(fx.aliasPath);
    const second = await openFromDisk(fx.longPath);
    expect(second.kind).toBe("already-open");
    expect(second.documentId).toBe(first.documentId);
    expect(first.documentId).toBe(docIdFromPath(fx.longPath));
    expect(getOpenDocs().size).toBe(1);
  });

  it("stores and shows the long spelling, never the alias (R1.2)", async () => {
    const opened = await openFromDisk(fx.aliasPath);
    const entry = getOpenDocs().get(opened.documentId);
    expect(entry?.filePath).toBe(fx.longPath);
    expect(opened.filePath).toBe(fx.longPath);
    expect(opened.fileName).toBe(LONG_NAME);
    expect(opened.fileName).not.toBe(ALIAS_NAME);
  });

  it("arms the watcher with the string the document's saves use", async () => {
    vi.mocked(watchFile).mockClear();
    await openFromDisk(fx.aliasPath);
    expect(vi.mocked(watchFile).mock.calls.map((c) => c[0])).toEqual([fx.longPath]);
  });

  it.each([
    ["long then alias", () => [fx.longPath, fx.aliasPath]],
    ["alias then long", () => [fx.aliasPath, fx.longPath]],
  ] as const)(
    "a comment made through one spelling survives a restart and is found through the other (%s)",
    async (_label, order) => {
      const [firstSpelling, secondSpelling] = order();
      const opened = await openFromDisk(firstSpelling);
      const doc = getOrCreateDocument(opened.documentId);
      withBrowser(doc, () =>
        doc
          .getMap(Y_MAP_ANNOTATIONS)
          .set("ann_one", annRecord({ id: "ann_one", author: "user", rev: 1 })),
      );
      await closeDocumentById(opened.documentId);
      await simulateRestart();

      const again = await openFromDisk(secondSpelling);
      expect(again.kind).toBe("fresh");
      expect(liveAnnotations(again.documentId).has("ann_one")).toBe(true);
    },
  );

  it("both spellings use one session file, one envelope and one backup folder", async () => {
    // Unsaved text in a session, so the first disk save of each run takes its
    // pre-overwrite backup.
    await storeSession(fx.longPath, `${DISK}\nunsaved one\n`);
    const opened = await openFromDisk(fx.aliasPath);
    const doc = getOrCreateDocument(opened.documentId);
    withBrowser(doc, () =>
      doc.getMap(Y_MAP_ANNOTATIONS).set("ann_x", annRecord({ id: "ann_x", author: "user" })),
    );
    await saveCurrentSession();
    await autoSaveAllToDisk();
    await closeStore(docHash(fx.longPath));
    expect(await exists(sessionFile(fx.longPath))).toBe(true);
    expect(await exists(sessionFile(fx.aliasPath))).toBe(false);
    expect(await exists(envelopePath(docHash(fx.longPath)))).toBe(true);
    expect(await exists(envelopePath(docHash(fx.aliasPath)))).toBe(false);
    expect(await fs.readFile(fx.longPath, "utf-8")).toContain("unsaved one");

    // A later run, through the long spelling: its backup joins the same folder.
    await simulateRestart();
    _resetDocBackupGateForTests();
    await storeSession(fx.longPath, `${DISK}\nunsaved two\n`);
    await openFromDisk(fx.longPath);
    await autoSaveAllToDisk();
    expect(await fs.readFile(fx.longPath, "utf-8")).toContain("unsaved two");

    const root = docBackupsRoot(resolveAppDataDir());
    const folders = (await fs.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(folders).toEqual([docHash(fx.longPath)]);
    const texts = await backupTexts();
    expect(texts).toHaveLength(2);
    expect(texts.some((t) => t === DISK)).toBe(true);
    expect(texts.some((t) => t.includes("unsaved one"))).toBe(true);
    expect(await listDocBackups(fx.aliasPath, resolveAppDataDir())).toEqual([]);
  });

  // A restore entry's `readOnly` is a STORED flag of one session. Replayed onto
  // a document a short spelling was involved in this run, it belongs to a
  // session that did not become the document.
  it.each([
    ["the short-spelled entry first, then the long one", () => [fx.aliasPath, fx.longPath]],
    ["the long-spelled entry first, then the short one", () => [fx.longPath, fx.aliasPath]],
  ] as const)(
    "a replayed restore entry's read-only flag does not turn the open document read-only (%s)",
    async (_label, order) => {
      const [first, second] = order();
      const opened = await openFromRestore({ filePath: first, readOnly: false });
      const replayed = await openFromRestore({ filePath: second, readOnly: true });
      expect(replayed.kind).toBe("already-open");
      expect(replayed.documentId).toBe(opened.documentId);
      expect(replayed.readOnly).toBe(false);
      expect(getOpenDocs().get(opened.documentId)?.readOnly).toBe(false);
      expect(
        getOrCreateDocument(opened.documentId).getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_READ_ONLY),
      ).not.toBe(true);
    },
  );

  it("the same replay with no short spelling involved still upgrades the document to read-only", async () => {
    const opened = await openFromRestore({ filePath: fx.longPath, readOnly: false });
    const replayed = await openFromRestore({ filePath: fx.longPath, readOnly: true });
    expect(replayed.kind).toBe("already-open");
    expect(replayed.readOnly).toBe(true);
    expect(getOpenDocs().get(opened.documentId)?.readOnly).toBe(true);
  });

  it("a real long name with the alias shape opens under its own name, id and keys (R1.4)", async () => {
    const real = path.join(fx.dir, "notes~1.md");
    await fs.writeFile(real, "real name\n", "utf-8");
    const opened = await openFromDisk(real);
    expect(opened.filePath).toBe(real);
    expect(opened.documentId).toBe(docIdFromPath(real));
  });

  it("a path with no short component makes no expansion call at all (R1.5)", async () => {
    const opened = await openFromDisk(fx.longPath);
    expect(opened.filePath).toBe(fsSync.realpathSync(fx.longPath));
    expect(spies.realpathNative).not.toHaveBeenCalled();
    expect(spies.lstat).not.toHaveBeenCalled();
  });
});

describe("Requirement 4: no security check moves", () => {
  const BS = String.fromCharCode(92);

  // R4.1. Asserted on spies, never on the return value, and on every
  // filesystem function the resolver can reach: the injected expansion seam
  // AND the real ones behind it.
  it.each([
    ["a bare UNC path", `${BS}${BS}evil.example${BS}share${BS}${ALIAS_NAME}`, /UNC paths/],
    ["a forward-slash UNC path", `//evil.example/share/${ALIAS_NAME}`, /UNC paths/],
    ["an extended UNC path", `${BS}${BS}?${BS}UNC${BS}evil.example${BS}share${BS}x.md`, /Extended/],
    ["a device-namespace path", `//./C:/${ALIAS_NAME}`, /Extended/],
  ])("refuses %s before any filesystem call", async (_label, hostile, message) => {
    const real = [
      vi.spyOn(fsSync, "realpathSync"),
      vi.spyOn(fsSync, "lstatSync"),
      vi.spyOn(fsSync, "statSync"),
      vi.spyOn(fs, "realpath"),
      vi.spyOn(fs, "lstat"),
      vi.spyOn(fs, "stat"),
    ];
    await expect(openFromDisk(hostile)).rejects.toMatchObject({
      code: "INVALID_PATH",
      message: expect.stringMatching(message),
    });
    for (const spy of real) expect(spy).not.toHaveBeenCalled();
    expect(spies.realpathNative).not.toHaveBeenCalled();
    expect(spies.lstat).not.toHaveBeenCalled();
  });

  it("still refuses a path that canonicalises to a UNC target, before expanding it", async () => {
    vi.spyOn(fsSync, "realpathSync").mockReturnValue(
      `${BS}${BS}evil.example${BS}share${BS}${ALIAS_NAME}`,
    );
    await expect(openFromDisk(fx.aliasPath)).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(spies.realpathNative).not.toHaveBeenCalled();
    expect(spies.lstat).not.toHaveBeenCalled();
  });

  it("opening a path that does not exist still creates nothing (R4.3)", async () => {
    const missing = path.join(fx.dir, "NOFILE~1.MD");
    await expect(openFromDisk(missing)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await exists(missing)).toBe(false);
    expect((await fs.readdir(fx.dir)).sort()).toEqual([ALIAS_NAME, LONG_NAME].sort());
    expect(getOpenDocs().size).toBe(0);
  });

  it("an EPERM during expansion opens the file under master's string (R4.5)", async () => {
    uninstallAliasExpansion();
    installAliasExpansion({
      realpathError: Object.assign(new Error("EPERM"), { code: "EPERM" }),
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const opened = await openFromDisk(fx.aliasPath);
    expect(opened.filePath).toBe(fsSync.realpathSync(fx.aliasPath));
    expect(opened.documentId).toBe(docIdFromPath(fx.aliasPath));
    expect(opened.kind).toBe("fresh");
    expect(errors.mock.calls.some((c) => String(c[0]).includes("short name"))).toBe(true);
  });

  it("keeps the spelling that opens today when the long name's extension is not one Tandem opens", async () => {
    // An alias's extension is the long one cut to three characters.
    const long = path.join(fx.dir, "page long name.mdx");
    const alias = path.join(fx.dir, "PAGELO~1.MD");
    await fs.writeFile(long, "body\n", "utf-8");
    await fs.link(long, alias);
    uninstallAliasExpansion();
    const { _setShortNameDepsForTests } = await import("../../src/server/file-io/short-names.js");
    _setShortNameDepsForTests({
      platform: "win32",
      realpathNative: async () => long,
      lstat: (p) => fs.lstat(p, { bigint: true }),
    });
    const opened = await openFromDisk(alias);
    expect(opened.filePath).toBe(alias);
    expect(opened.format).toBe("md");
  });
});

describe("Requirement 2: records saved under the short spelling", () => {
  const comment = annRecord({ id: "ann_comment", author: "user", rev: 1 });
  const note = annRecord({
    id: "ann_note",
    author: "user",
    type: "note",
    audience: "private",
    rev: 1,
  } as Partial<Annotation> as never);

  async function storeOldRecords(): Promise<void> {
    await storeSession(fx.aliasPath, "alpha beta gamma\n\nunsaved line\n", {
      annotations: [comment, note],
    });
    await storeEnvelope(fx.aliasPath, {
      annotations: [comment, note],
      tombstones: [{ id: "ann_deleted", rev: 3, deletedAt: T0 }],
      replies: [replyRecord({ id: "rep_1", annotationId: "ann_comment" })],
    });
  }

  it("carries a session and an envelope over to the new key (R2.1)", async () => {
    await storeOldRecords();
    const opened = await openFromDisk(fx.aliasPath);
    expect(opened.kind).toBe("restored");
    expect(liveText(opened.documentId)).toContain("unsaved line");
    const anns = liveAnnotations(opened.documentId);
    expect(anns.get("ann_comment")?.type).toBe("comment");
    expect(anns.get("ann_note")?.type).toBe("note");
    expect(
      getOrCreateDocument(opened.documentId).getMap(Y_MAP_ANNOTATION_REPLIES).has("rep_1"),
    ).toBe(true);
    expect(getTombstones(docHash(fx.longPath)).map((t) => t.id)).toContain("ann_deleted");

    expect(await exists(sessionFile(fx.aliasPath))).toBe(false);
    expect(await exists(envelopePath(docHash(fx.aliasPath)))).toBe(false);
    expect(await exists(sessionFile(fx.longPath))).toBe(true);
    const envelope = await readEnvelope(fx.longPath);
    expect(envelope.annotations.map((a) => a.id).sort()).toEqual(["ann_comment", "ann_note"]);
    expect(envelope.annotations.find((a) => a.id === "ann_note")?.type).toBe("note");
    expect(envelope.tombstones.map((t) => t.id)).toEqual(["ann_deleted"]);
    expect(envelope.replies.map((r) => r.id)).toEqual(["rep_1"]);
  });

  it("after a carry-over, closing and restarting does not bring the document back (R2.5)", async () => {
    await storeOldRecords();
    const opened = await openFromDisk(fx.aliasPath);
    await autoSaveAllToDisk();
    await closeDocumentById(opened.documentId);
    await simulateRestart();

    expect(await sessionFiles()).toEqual([]);
    expect((await listSessionFilePaths()).map((s) => s.filePath)).toEqual([]);
    expect(await restoreOpenDocuments(null)).toBe(0);
    expect(getOpenDocs().size).toBe(0);
  });

  it("carries the stored lastAccessed, so an open-time write does not move the restore window", async () => {
    await storeSession(fx.aliasPath, DISK, { dirty: false, lastAccessed: T0 });
    await openFromDisk(fx.aliasPath);
    const stored = JSON.parse(await fs.readFile(sessionFile(fx.longPath), "utf-8"));
    expect(stored.lastAccessed).toBe(T0);
    expect(stored.filePath).toBe(fx.longPath);
  });

  it("adopts an envelope that has no session, on a normal open", async () => {
    await storeEnvelope(fx.aliasPath, {
      annotations: [comment],
      tombstones: [{ id: "ann_deleted", rev: 3, deletedAt: T0 }],
    });
    const opened = await openFromDisk(fx.aliasPath);
    expect(liveAnnotations(opened.documentId).has("ann_comment")).toBe(true);
    expect(await exists(envelopePath(docHash(fx.aliasPath)))).toBe(false);
    expect((await readEnvelope(fx.longPath)).tombstones.map((t) => t.id)).toEqual(["ann_deleted"]);
  });

  it("adopts an envelope that has no session, into an already-open document", async () => {
    const opened = await openFromDisk(fx.longPath);
    await storeEnvelope(fx.aliasPath, { annotations: [comment] });
    const again = await openFromDisk(fx.aliasPath);
    expect(again.kind).toBe("already-open");
    expect(liveAnnotations(opened.documentId).has("ann_comment")).toBe(true);
    expect(await exists(envelopePath(docHash(fx.aliasPath)))).toBe(false);
    expect((await readEnvelope(fx.longPath)).annotations.map((a) => a.id)).toEqual(["ann_comment"]);
  });

  it("a long-spelled open never looks at records under the old key (D2)", async () => {
    await storeOldRecords();
    const before = {
      session: await fs.readFile(sessionFile(fx.aliasPath)),
      envelope: await fs.readFile(envelopePath(docHash(fx.aliasPath))),
    };
    const opened = await openFromDisk(fx.longPath);
    expect(opened.kind).toBe("fresh");
    expect(liveAnnotations(opened.documentId).size).toBe(0);
    expect((await fs.readFile(sessionFile(fx.aliasPath))).equals(before.session)).toBe(true);
    expect((await fs.readFile(envelopePath(docHash(fx.aliasPath)))).equals(before.envelope)).toBe(
      true,
    );
  });

  describe("two stored sessions for one file, through startup restore (R2.2, R2.3)", () => {
    const OLD_TEXT = "alpha beta gamma\n\nfrom the short spelling\n";
    const NEW_TEXT = "alpha beta gamma\n\nfrom the long spelling\n";

    async function restoreBoth(
      newer: "old" | "new",
      olderOpts: Parameters<typeof storeSession>[2] = {},
    ) {
      const older = { lastAccessed: T0, ...olderOpts };
      const newerOpts = { lastAccessed: T0 + 5_000 };
      await storeSession(fx.aliasPath, OLD_TEXT, newer === "old" ? newerOpts : older);
      await storeSession(fx.longPath, NEW_TEXT, newer === "new" ? newerOpts : older);
      const count = await restoreOpenDocuments(null);
      return { count, id: docIdFromPath(fx.longPath) };
    }

    it.each([
      [
        "the newer one under the old key",
        "old",
        "from the short spelling",
        "from the long spelling",
      ],
      [
        "the newer one under the new key",
        "new",
        "from the long spelling",
        "from the short spelling",
      ],
    ] as const)(
      "%s: one document with the newer content, the older content in backups, one session left",
      async (_label, newer, kept, backedUp) => {
        const { id } = await restoreBoth(newer);
        expect(getOpenDocs().size).toBe(1);
        expect(liveText(id)).toContain(kept);
        expect(liveText(id)).not.toContain(backedUp);
        const backups = await backupTexts();
        expect(backups.some((t) => t.includes(backedUp))).toBe(true);
        expect(await sessionFiles()).toEqual([`${sessionKey(fx.longPath)}.json`]);
      },
    );

    it.each([
      ["unsaved work", { dirty: true }],
      [
        "an unresolved conflict",
        {
          dirty: true,
          conflict: { kind: "external-edit", diskChanged: true, detectedAt: T0 } as const,
        },
      ],
    ] as const)(
      "the older session holding %s is still converted to a backup (R2.4)",
      async (_label, olderOpts) => {
        for (const newer of ["old", "new"] as const) {
          const { id } = await restoreBoth(newer, olderOpts);
          const older = newer === "old" ? "from the long spelling" : "from the short spelling";
          expect(getOpenDocs().size).toBe(1);
          expect(liveText(id)).not.toContain(older);
          expect((await backupTexts()).some((t) => t.includes(older))).toBe(true);
          expect(await sessionFiles()).toEqual([`${sessionKey(fx.longPath)}.json`]);
          await simulateRestart();
          for (const f of await sessionFiles()) await fs.rm(path.join(SESSION_DIR, f));
          _resetDocBackupGateForTests();
        }
      },
    );

    it("a tie in lastAccessed picks the new-key session", async () => {
      await storeSession(fx.aliasPath, OLD_TEXT, { lastAccessed: T0 });
      await storeSession(fx.longPath, NEW_TEXT, { lastAccessed: T0 });
      const opened = await openFromDisk(fx.aliasPath);
      expect(liveText(opened.documentId)).toContain("from the long spelling");
      expect((await backupTexts()).some((t) => t.includes("from the short spelling"))).toBe(true);
      expect(await exists(sessionFile(fx.aliasPath))).toBe(false);
    });

    it.each(["old", "new"] as const)(
      "a failed backup (%s session newer) loses nothing through an autosave and a close",
      async (newer) => {
        backupShouldFail = true;
        vi.spyOn(console, "error").mockImplementation(() => {});
        await storeSession(fx.aliasPath, OLD_TEXT, {
          lastAccessed: newer === "old" ? T0 + 5_000 : T0,
        });
        await storeSession(fx.longPath, NEW_TEXT, {
          lastAccessed: newer === "new" ? T0 + 5_000 : T0,
        });
        const oldBytes = await fs.readFile(sessionFile(fx.aliasPath));

        await restoreOpenDocuments(null);
        const id = docIdFromPath(fx.longPath);
        // The new-key session is the document in BOTH orders: its file is the
        // one an autosave overwrites, so it can never be the one left behind.
        expect(getOpenDocs().size).toBe(1);
        expect(liveText(id)).toContain("from the long spelling");

        await autoSaveAllToDisk();
        await saveCurrentSession();
        await closeDocumentById(id);

        expect((await fs.readFile(sessionFile(fx.aliasPath))).equals(oldBytes)).toBe(true);
        expect(await fs.readFile(fx.longPath, "utf-8")).toContain("from the long spelling");
        // Nothing of the old session was stored (the only snapshot is the
        // ordinary pre-overwrite copy of the file the autosave replaced).
        expect((await backupTexts()).some((t) => t.includes("from the short spelling"))).toBe(
          false,
        );
      },
    );

    it("a second session whose state cannot be decoded is quarantined, not replayed", async () => {
      await storeSession(fx.longPath, NEW_TEXT, { lastAccessed: T0 + 5_000 });
      await storeSession(fx.aliasPath, OLD_TEXT, { lastAccessed: T0 });
      const file = sessionFile(fx.aliasPath);
      const stored = JSON.parse(await fs.readFile(file, "utf-8"));
      delete stored.ydocState;
      await fs.writeFile(file, JSON.stringify(stored), "utf-8");
      vi.spyOn(console, "error").mockImplementation(() => {});

      await restoreOpenDocuments(null);
      expect(getOpenDocs().size).toBe(1);
      expect(liveText(docIdFromPath(fx.longPath))).toContain("from the long spelling");
      expect(await exists(file)).toBe(false);
      expect((await fs.readdir(SESSION_DIR)).some((f) => f.includes(".corrupt."))).toBe(true);

      await simulateRestart();
      expect((await listSessionFilePaths()).map((s) => s.filePath)).toEqual([fx.longPath]);
    });

    it("a clean old-key session whose file changed on disk since does not win, however new it is", async () => {
      // Today's open path would not restore it (clean, and the file moved on),
      // so it must not be chosen over a session that would be.
      await storeSession(fx.aliasPath, OLD_TEXT, { dirty: false, lastAccessed: T0 + 5_000 });
      await storeSession(fx.longPath, NEW_TEXT, { lastAccessed: T0 });
      const earlier = new Date(T0 - 3_600_000);
      await fs.utimes(fx.longPath, earlier, earlier);

      const opened = await openFromDisk(fx.aliasPath);
      expect(liveText(opened.documentId)).toContain("from the long spelling");
      expect(liveText(opened.documentId)).not.toContain("from the short spelling");
      expect((await backupTexts()).some((t) => t.includes("from the short spelling"))).toBe(true);
      expect(await sessionFiles()).toEqual([`${sessionKey(fx.longPath)}.json`]);
    });

    it.each([
      ["missing", undefined],
      ["a word", '"yesterday"'],
      // Both of these compare as "newer" unless the stamp is checked first.
      ["a numeric string", `"${T0 + 5_000}"`],
      ["not finite", "1e999"],
    ] as const)(
      "an old-key session whose lastAccessed is %s does not win",
      async (_label, rawValue) => {
        await storeSession(fx.aliasPath, OLD_TEXT, { lastAccessed: 123_456_789 });
        await storeSession(fx.longPath, NEW_TEXT, { lastAccessed: T0 });
        const file = sessionFile(fx.aliasPath);
        const raw = await fs.readFile(file, "utf-8");
        const edited = raw.replace(
          '"lastAccessed":123456789,',
          rawValue === undefined ? "" : `"lastAccessed":${rawValue},`,
        );
        expect(edited).not.toBe(raw);
        await fs.writeFile(file, edited, "utf-8");
        vi.spyOn(console, "error").mockImplementation(() => {});

        const opened = await openFromDisk(fx.aliasPath);
        expect(liveText(opened.documentId)).toContain("from the long spelling");
        expect((await backupTexts()).some((t) => t.includes("from the short spelling"))).toBe(
          true,
        );
        expect(await sessionFiles()).toEqual([`${sessionKey(fx.longPath)}.json`]);
      },
    );

    it("a new-key session that cannot be decoded is quarantined and the old-key one carries over", async () => {
      await storeSession(fx.aliasPath, OLD_TEXT, { lastAccessed: T0 });
      await storeSession(fx.longPath, NEW_TEXT, { lastAccessed: T0 + 5_000 });
      await editStoredSession(fx.longPath, (stored) => {
        delete stored.ydocState;
      });
      vi.spyOn(console, "error").mockImplementation(() => {});

      const opened = await openFromDisk(fx.aliasPath);
      expect(opened.kind).toBe("restored");
      expect(liveText(opened.documentId)).toContain("from the short spelling");
      expect((await fs.readdir(SESSION_DIR)).some((f) => f.includes(".corrupt."))).toBe(true);
      expect(await sessionFiles()).toEqual([`${sessionKey(fx.longPath)}.json`]);
      const moved = JSON.parse(await fs.readFile(sessionFile(fx.longPath), "utf-8"));
      expect(moved.filePath).toBe(fx.longPath);
      expect(typeof moved.ydocState).toBe("string");
    });

    it("an old-key session that cannot be decoded is quarantined on a normal open, and the new-key one is used", async () => {
      await storeSession(fx.longPath, NEW_TEXT, { lastAccessed: T0 });
      await storeSession(fx.aliasPath, OLD_TEXT, { lastAccessed: T0 + 5_000 });
      await editStoredSession(fx.aliasPath, (stored) => {
        delete stored.ydocState;
      });
      const before = await fs.readFile(sessionFile(fx.longPath));
      vi.spyOn(console, "error").mockImplementation(() => {});

      const opened = await openFromDisk(fx.aliasPath);
      expect(opened.kind).toBe("restored");
      expect(liveText(opened.documentId)).toContain("from the long spelling");
      expect(await exists(sessionFile(fx.aliasPath))).toBe(false);
      expect((await fs.readdir(SESSION_DIR)).some((f) => f.includes(".corrupt."))).toBe(true);
      expect((await fs.readFile(sessionFile(fx.longPath))).equals(before)).toBe(true);
    });

    it("a new-key session that cannot be decoded but has a pre-#1750 copy: the old key is left alone for this open", async () => {
      await storeSession(fx.aliasPath, OLD_TEXT, { lastAccessed: T0 + 5_000 });
      await storeEnvelope(fx.aliasPath, {
        annotations: [annRecord({ id: "ann_old", author: "user", rev: 1 })],
      });
      await storeSession(fx.longPath, NEW_TEXT, { lastAccessed: T0 });
      // The same record under the pre-#1750 file name, older than the one
      // under the current name, which is then made undecodable.
      const preMigration = path.join(SESSION_DIR, `${legacySessionKey(fx.longPath)}.json`);
      await fs.copyFile(sessionFile(fx.longPath), preMigration);
      const earlier = new Date(T0 - 3_600_000);
      await fs.utimes(preMigration, earlier, earlier);
      await editStoredSession(fx.longPath, (stored) => {
        delete stored.ydocState;
      });
      const before = {
        session: await fs.readFile(sessionFile(fx.aliasPath)),
        envelope: await fs.readFile(envelopePath(docHash(fx.aliasPath))),
      };
      vi.spyOn(console, "error").mockImplementation(() => {});

      const opened = await openFromDisk(fx.aliasPath);
      expect(liveText(opened.documentId)).not.toContain("from the short spelling");
      expect(liveAnnotations(opened.documentId).has("ann_old")).toBe(false);
      expect((await fs.readFile(sessionFile(fx.aliasPath))).equals(before.session)).toBe(true);
      expect(
        (await fs.readFile(envelopePath(docHash(fx.aliasPath)))).equals(before.envelope),
      ).toBe(true);
    });

    it("comments that lived only in the losing session are folded into the surviving document", async () => {
      const only = annRecord({ id: "ann_session_only", author: "user", rev: 1 });
      await storeSession(fx.aliasPath, OLD_TEXT, { lastAccessed: T0, annotations: [only] });
      await storeSession(fx.longPath, NEW_TEXT, { lastAccessed: T0 + 5_000 });
      await restoreOpenDocuments(null);
      expect(liveAnnotations(docIdFromPath(fx.longPath)).has("ann_session_only")).toBe(true);
      expect((await readEnvelope(fx.longPath)).annotations.map((a) => a.id)).toContain(
        "ann_session_only",
      );
      expect(await exists(sessionFile(fx.aliasPath))).toBe(false);
    });

    it("a stale session copy of a record the old envelope tombstoned is not resurrected", async () => {
      const gone = annRecord({ id: "ann_gone", author: "user", rev: 1 });
      await storeSession(fx.aliasPath, OLD_TEXT, { lastAccessed: T0, annotations: [gone] });
      await storeEnvelope(fx.aliasPath, {
        tombstones: [{ id: "ann_gone", rev: 2, deletedAt: T0 }],
      });
      await storeSession(fx.longPath, NEW_TEXT, { lastAccessed: T0 + 5_000 });
      await restoreOpenDocuments(null);
      expect(liveAnnotations(docIdFromPath(fx.longPath)).has("ann_gone")).toBe(false);
    });
  });

  describe("two envelopes (R2.3a)", () => {
    it("merges both: the higher revision wins, tombstones of both are kept, a note stays a note, and the old file goes last", async () => {
      await storeEnvelope(fx.aliasPath, {
        annotations: [
          annRecord({ id: "shared", author: "user", content: "old copy", rev: 5 }),
          annRecord({ id: "shared_new_higher", author: "user", content: "old copy", rev: 1 }),
          annRecord({ id: "old_only", author: "user", rev: 1 }),
          note,
          annRecord({ id: "killed_by_new", author: "user", rev: 1 }),
        ],
        tombstones: [{ id: "old_stone", rev: 4, deletedAt: T0 }],
      });
      await storeEnvelope(fx.longPath, {
        annotations: [
          annRecord({ id: "shared", author: "user", content: "new copy", rev: 2 }),
          annRecord({ id: "shared_new_higher", author: "user", content: "new copy", rev: 4 }),
          annRecord({ id: "new_only", author: "user", rev: 1 }),
          annRecord({ id: "old_stone", author: "user", rev: 1 }),
        ],
        tombstones: [{ id: "killed_by_new", rev: 3, deletedAt: T0 }],
      });

      const opened = await openFromDisk(fx.aliasPath);
      const anns = liveAnnotations(opened.documentId);
      expect([...anns.keys()].sort()).toEqual([
        "ann_note",
        "new_only",
        "old_only",
        "shared",
        "shared_new_higher",
      ]);
      expect(anns.get("shared")?.content).toBe("old copy");
      expect(anns.get("shared_new_higher")?.content).toBe("new copy");
      expect(anns.get("ann_note")?.type).toBe("note");

      const envelope = await readEnvelope(fx.longPath);
      expect(envelope.annotations.map((a) => a.id).sort()).toEqual([
        "ann_note",
        "new_only",
        "old_only",
        "shared",
        "shared_new_higher",
      ]);
      expect(envelope.tombstones.map((t) => t.id).sort()).toEqual(["killed_by_new", "old_stone"]);
      expect(await exists(envelopePath(docHash(fx.aliasPath)))).toBe(false);
    });

    it("a tombstone held only by the old envelope still suppresses its record after a reopen", async () => {
      await storeEnvelope(fx.aliasPath, {
        tombstones: [{ id: "old_stone", rev: 4, deletedAt: T0 }],
      });
      await storeEnvelope(fx.longPath, {
        annotations: [annRecord({ id: "old_stone", author: "user", rev: 1 })],
      });
      const first = await openFromDisk(fx.aliasPath);
      expect(liveAnnotations(first.documentId).has("old_stone")).toBe(false);
      await closeDocumentById(first.documentId);
      await simulateRestart();

      const again = await openFromDisk(fx.longPath);
      expect(liveAnnotations(again.documentId).has("old_stone")).toBe(false);
      expect(getTombstones(docHash(fx.longPath)).map((t) => t.id)).toEqual(["old_stone"]);
    });

    it("emits no channel event for merged-in records, on a live document", async () => {
      const opened = await openFromDisk(fx.longPath);
      const doc = getOrCreateDocument(opened.documentId);
      attachObservers(opened.documentId, doc);
      const { events, cleanup } = collectEvents("external");
      try {
        await storeEnvelope(fx.aliasPath, { annotations: [comment] });
        await storeSession(fx.aliasPath, "other text entirely\n", {
          lastAccessed: T0,
          annotations: [annRecord({ id: "ann_from_session", author: "user", rev: 1 })],
        });
        await openFromDisk(fx.aliasPath);
        const anns = liveAnnotations(opened.documentId);
        expect(anns.has("ann_comment")).toBe(true);
        expect(anns.has("ann_from_session")).toBe(true);
        expect(events).toEqual([]);

        // Control: the same collector does see a browser-origin write, so an
        // empty list above is not a dead observer.
        withBrowser(doc, () =>
          doc
            .getMap(Y_MAP_ANNOTATIONS)
            .set(
              "ann_live",
              annRecord({ id: "ann_live", author: "user", rev: 1, textSnapshot: "alpha" }),
            ),
        );
        expect(events.length).toBeGreaterThan(0);
      } finally {
        cleanup();
        detachObservers(opened.documentId);
      }
    });

    it("leaves the old envelope in place when it is only partially readable", async () => {
      const file = envelopePath(docHash(fx.aliasPath));
      await storeEnvelope(fx.aliasPath, { annotations: [comment] });
      const stored = JSON.parse(await fs.readFile(file, "utf-8"));
      stored.annotations.push({ id: "broken", nonsense: true });
      await fs.writeFile(file, JSON.stringify(stored), "utf-8");
      vi.spyOn(console, "error").mockImplementation(() => {});

      const opened = await openFromDisk(fx.aliasPath);
      expect(liveAnnotations(opened.documentId).has("ann_comment")).toBe(true);
      expect(await exists(file)).toBe(true);
    });
  });

  describe("anchors of records that arrive from the other spelling", () => {
    // A browser-made record: no relRange, no textSnapshot.
    const onBeta = { id: "ann_beta", author: "user", type: "comment", range: { from: 6, to: 10 } };

    function outcome(id: string, annId: string): string {
      const doc = getOrCreateDocument(id);
      const map = doc.getMap(Y_MAP_ANNOTATIONS);
      return refreshRange(map.get(annId) as Annotation, doc, map).kind;
    }

    it("reads degraded when the surviving text differs at its range, and survives a clean close and reopen", async () => {
      // Old session: "alpha beta gamma". New (surviving) session: text shifted.
      await storeSession(fx.aliasPath, "alpha beta gamma\n", {
        lastAccessed: T0,
        annotations: [annRecord(onBeta as never)],
      });
      await storeEnvelope(fx.aliasPath, { annotations: [annRecord(onBeta as never)] });
      await storeSession(fx.longPath, "ZZZZ alpha beta gamma\n", { lastAccessed: T0 + 5_000 });

      const opened = await openFromDisk(fx.aliasPath);
      expect(liveAnnotations(opened.documentId).get("ann_beta")?.textSnapshot).toBe("beta");
      expect(outcome(opened.documentId, "ann_beta")).toBe("degraded");
      const stored = (await readEnvelope(fx.longPath)).annotations.find((a) => a.id === "ann_beta");
      expect((stored as { textSnapshot?: string }).textSnapshot).toBe("beta");

      await autoSaveAllToDisk();
      await closeDocumentById(opened.documentId);
      await simulateRestart();
      const again = await openFromDisk(fx.longPath);
      expect(outcome(again.documentId, "ann_beta")).toBe("degraded");
    });

    it("is anchored where the surviving text still holds the same words", async () => {
      await storeSession(fx.aliasPath, "alpha beta gamma\n", {
        lastAccessed: T0,
        annotations: [annRecord(onBeta as never)],
      });
      await storeSession(fx.longPath, "alpha beta gamma delta\n", { lastAccessed: T0 + 5_000 });
      const opened = await openFromDisk(fx.aliasPath);
      // Stamped (the texts differ), and the stamp is what lets it anchor.
      expect(liveAnnotations(opened.documentId).get("ann_beta")?.textSnapshot).toBe("beta");
      expect(outcome(opened.documentId, "ann_beta")).not.toBe("degraded");
      const after = liveAnnotations(opened.documentId).get("ann_beta");
      expect(after?.range).toEqual({ from: 6, to: 10 });
    });

    it("does not use the file on disk as a witness when it is not the text the envelope was written on", async () => {
      // No content hash on the envelope (or a stale one): the disk file proves
      // nothing, so the record is left exactly as master would leave it.
      await storeEnvelope(fx.longPath, { annotations: [annRecord(onBeta as never)] });
      await storeSession(fx.aliasPath, "ZZZZ alpha beta gamma\n", { lastAccessed: T0 });
      const opened = await openFromDisk(fx.aliasPath);
      expect(liveAnnotations(opened.documentId).get("ann_beta")?.textSnapshot).toBeUndefined();
    });

    it("uses the file on disk as the witness when the other side has an envelope and no session", async () => {
      // The long document's envelope was made on the disk text; the short
      // session holds different, unsaved text and becomes the document.
      // The envelope records the hash of the text it was last written against;
      // the disk file is trusted as the witness only when it still has it.
      await storeEnvelope(fx.longPath, {
        annotations: [annRecord(onBeta as never)],
        meta: {
          filePath: fx.longPath,
          lastUpdated: T0,
          contentHash: contentHash("alpha beta gamma"),
        },
      });
      await storeSession(fx.aliasPath, "ZZZZ alpha beta gamma\n", { lastAccessed: T0 });
      const opened = await openFromDisk(fx.aliasPath);
      expect(liveText(opened.documentId)).toContain("ZZZZ");
      expect(liveAnnotations(opened.documentId).get("ann_beta")?.textSnapshot).toBe("beta");
      expect(outcome(opened.documentId, "ann_beta")).toBe("degraded");
    });

    // The words of a record from the other copy usually still exist, a few
    // lines further down. It follows them (the reload path's arithmetic)
    // instead of reading `degraded` for ever.
    describe("moved onto the surviving text", () => {
      const SHIFTED = "one new line\n\nanother new line\n\nalpha beta gamma\n";
      const REWRITTEN = "one new line\n\nanother new line\n\nalpha BETTER gamma\n";
      const withSnapshot = { ...onBeta, rev: 1, textSnapshot: "beta" };
      /** An envelope written against the text of the file on disk (`DISK`). */
      const madeOnDisk = () => ({
        filePath: fx.aliasPath,
        lastUpdated: T0,
        contentHash: contentHash("alpha beta gamma"),
      });

      /** Asserted on the stored record first: a read must not be what anchors it. */
      function expectAnchoredOn(id: string, annId: string, words: string): void {
        const doc = getOrCreateDocument(id);
        const at = extractText(doc).indexOf(words);
        expect(at).toBeGreaterThan(10);
        const rec = liveAnnotations(id).get(annId);
        expect(rec?.range).toEqual({ from: at, to: at + words.length });
        expect(rec?.relRange).toBeDefined();
        if (!rec?.relRange) return;
        expect(relPosToFlatOffset(doc, rec.relRange.fromRel)).toBe(at);
        expect(relPosToFlatOffset(doc, rec.relRange.toRel)).toBe(at + words.length);
        expect(outcome(id, annId)).toBe("ok");
      }

      it("a record with a snapshot lands on its words at their new offset", async () => {
        await storeEnvelope(fx.aliasPath, {
          annotations: [annRecord(withSnapshot as never)],
          meta: madeOnDisk(),
        });
        await storeSession(fx.longPath, SHIFTED, { lastAccessed: T0 });
        const opened = await openFromDisk(fx.aliasPath);
        expect(liveText(opened.documentId)).toContain("another new line");
        expectAnchoredOn(opened.documentId, "ann_beta", "beta");
        const stored = (await readEnvelope(fx.longPath)).annotations.find(
          (a) => a.id === "ann_beta",
        );
        expect(stored?.range).toEqual(liveAnnotations(opened.documentId).get("ann_beta")?.range);
      });

      it("a record with no snapshot whose anchor resolves in the other copy lands on its words", async () => {
        const made = await storeSession(fx.aliasPath, "alpha beta gamma\n", {
          lastAccessed: T0,
          annotate: (doc) => [anchoredOn(doc, "ann_beta", "beta")],
        });
        await storeEnvelope(fx.aliasPath, { annotations: made as never });
        await storeSession(fx.longPath, SHIFTED, { lastAccessed: T0 + 5_000 });
        const opened = await openFromDisk(fx.aliasPath);
        expect(liveAnnotations(opened.documentId).get("ann_beta")?.textSnapshot).toBe("beta");
        expectAnchoredOn(opened.documentId, "ann_beta", "beta");
      });

      it("a record with no snapshot and no anchor is not moved: nothing verified the text its range covers", async () => {
        await storeSession(fx.aliasPath, "alpha beta gamma\n", {
          lastAccessed: T0,
          annotations: [annRecord(onBeta as never)],
        });
        await storeEnvelope(fx.aliasPath, { annotations: [annRecord(onBeta as never)] });
        await storeSession(fx.longPath, SHIFTED, { lastAccessed: T0 + 5_000 });
        const opened = await openFromDisk(fx.aliasPath);
        const before = liveAnnotations(opened.documentId).get("ann_beta");
        expect(before?.textSnapshot).toBe("beta");
        expect(before?.range).toEqual({ from: 6, to: 10 });
        expect(before?.relRange).toBeUndefined();
        // The lazy gate: minted only at the same offsets, and those hold other text.
        expect(outcome(opened.documentId, "ann_beta")).toBe("degraded");
        const after = liveAnnotations(opened.documentId).get("ann_beta");
        expect(after?.range).toEqual({ from: 6, to: 10 });
        expect(after?.relRange).toBeUndefined();
      });

      it("a record whose words were rewritten collapses to a point, keeps a snapshot and reads degraded", async () => {
        await storeEnvelope(fx.aliasPath, {
          annotations: [annRecord(withSnapshot as never)],
          meta: madeOnDisk(),
        });
        await storeSession(fx.longPath, REWRITTEN, { lastAccessed: T0 });
        const opened = await openFromDisk(fx.aliasPath);
        const rec = liveAnnotations(opened.documentId).get("ann_beta");
        expect(rec?.range.from).toBe(rec?.range.to);
        expect(rec?.range).not.toEqual({ from: 6, to: 6 });
        expect(rec?.textSnapshot).toBe("beta");
        expect(rec?.relRange).toBeUndefined();
        expect(outcome(opened.documentId, "ann_beta")).toBe("degraded");
      });

      it("a record whose anchor already resolves in the surviving document is left exactly as it arrived", async () => {
        // The surviving session made the record, and text arrived above it
        // afterwards: its anchor followed, its stored range was not refreshed.
        // The old envelope holds a newer revision with that same anchor, and
        // the witness (the file on disk) vouches for the stored range, so
        // arithmetic COULD move it. A live CRDT anchor beats arithmetic.
        const [mine] = await storeSession(fx.longPath, "alpha beta gamma\n", {
          lastAccessed: T0,
          annotate: (doc) => {
            const rec = anchoredOn(doc, "ann_beta", "beta", { textSnapshot: "beta" });
            const fragment = doc.getXmlFragment("default");
            withInternal(doc, () => {
              const paragraph = new Y.XmlElement("paragraph");
              fragment.insert(0, [paragraph]);
              const text = new Y.XmlText();
              paragraph.insert(0, [text]);
              text.insert(0, "one new line");
            });
            return [rec];
          },
        });
        expect(mine.range).toEqual({ from: 6, to: 10 });
        const newer = { ...mine, rev: 2, content: "edited in the other copy" };
        await storeEnvelope(fx.aliasPath, { annotations: [newer] as never, meta: madeOnDisk() });

        const opened = await openFromDisk(fx.aliasPath);
        const doc = getOrCreateDocument(opened.documentId);
        const at = extractText(doc).indexOf("beta");
        expect(at).toBeGreaterThan(10);
        const rec = liveAnnotations(opened.documentId).get("ann_beta");
        expect(rec?.content).toBe("edited in the other copy");
        // Not rewritten: the range and the anchor are the ones it arrived with.
        expect(rec?.range).toEqual(mine.range);
        expect(rec?.relRange).toEqual(mine.relRange);
        if (!rec?.relRange) return;
        expect(relPosToFlatOffset(doc, rec.relRange.fromRel)).toBe(at);
        expect(relPosToFlatOffset(doc, rec.relRange.toRel)).toBe(at + 4);
        expect(outcome(opened.documentId, "ann_beta")).not.toBe("degraded");
        expect(liveAnnotations(opened.documentId).get("ann_beta")?.range).toEqual({
          from: at,
          to: at + 4,
        });
      });

      it.each([
        ["old", "new"],
        ["new", "old"],
      ] as const)(
        "a record only the losing (%s-key) session held lands on its words in the %s-key session's text",
        async (loser) => {
          const loserKey = loser === "old" ? fx.aliasPath : fx.longPath;
          const winnerKey = loser === "old" ? fx.longPath : fx.aliasPath;
          await storeSession(loserKey, "alpha beta gamma\n", {
            lastAccessed: T0,
            annotate: (doc) => [anchoredOn(doc, "ann_session_only", "gamma")],
          });
          await storeSession(winnerKey, SHIFTED, { lastAccessed: T0 + 5_000 });
          const opened = await openFromDisk(fx.aliasPath);
          expect(liveText(opened.documentId)).toContain("another new line");
          expectAnchoredOn(opened.documentId, "ann_session_only", "gamma");
          expect(await sessionFiles()).toEqual([`${sessionKey(fx.longPath)}.json`]);
        },
      );

      it("emits no channel event while it moves records, on a live document", async () => {
        await fs.writeFile(fx.longPath, SHIFTED, "utf-8");
        const opened = await openFromDisk(fx.longPath);
        const doc = getOrCreateDocument(opened.documentId);
        attachObservers(opened.documentId, doc);
        const { events, cleanup } = collectEvents("external");
        const internal = collectEvents("internal");
        try {
          const made = await storeSession(fx.aliasPath, "alpha beta gamma\n", {
            lastAccessed: T0,
            annotate: (d) => [
              anchoredOn(d, "ann_beta", "beta"),
              anchoredOn(d, "ann_session_only", "gamma"),
            ],
          });
          await storeEnvelope(fx.aliasPath, { annotations: [made[0]] as never });
          await openFromDisk(fx.aliasPath);
          // Both were moved (so there was something to announce)...
          expectAnchoredOn(opened.documentId, "ann_beta", "beta");
          expectAnchoredOn(opened.documentId, "ann_session_only", "gamma");
          // ...and nothing was: no event to a channel, none to an in-process
          // subscriber (the supervisor's wake rides on these).
          expect(events).toEqual([]);
          expect(internal.events).toEqual([]);

          // Control: the collectors are live.
          withBrowser(doc, () =>
            doc
              .getMap(Y_MAP_ANNOTATIONS)
              .set(
                "ann_live",
                annRecord({ id: "ann_live", author: "user", rev: 1, textSnapshot: "one n" }),
              ),
          );
          expect(events.length).toBeGreaterThan(0);
          expect(internal.events.length).toBeGreaterThan(0);
        } finally {
          cleanup();
          internal.cleanup();
          detachObservers(opened.documentId);
        }
      });
    });

    it("stamps nothing when the texts are the same", async () => {
      await storeEnvelope(fx.aliasPath, { annotations: [annRecord(onBeta as never)] });
      const opened = await openFromDisk(fx.aliasPath);
      expect(liveAnnotations(opened.documentId).get("ann_beta")?.textSnapshot).toBeUndefined();
    });
  });

  // The old-key session is the only thing that makes a later start compute the
  // old key again. It may move to the new key only once the old envelope is
  // durable there; until then both stay, and the next short-spelled open retries.
  describe("an old envelope that cannot be made durable under the new key", () => {
    const lockPath = () => path.join(getAnnotationsDir(), "store.lock");

    it.each([
      [
        "the annotation store is not wired for the document",
        {
          raise: async () => {
            wiringShouldFail = true;
          },
          clear: async () => {
            wiringShouldFail = false;
          },
        },
      ],
      [
        "reading the old envelope fails (EBUSY)",
        (() => {
          let restore = () => {};
          return {
            raise: async () => {
              restore = failReadsOf(envelopePath(docHash(fx.aliasPath)), "EBUSY");
            },
            clear: async () => restore(),
          };
        })(),
      ],
      [
        "the store is read-only (another instance holds the lock)",
        {
          raise: async () => {
            await fs.mkdir(getAnnotationsDir(), { recursive: true });
            await fs.writeFile(lockPath(), String(process.pid));
            expect(await acquireStoreLock()).toBe("readonly");
          },
          clear: async () => {
            await fs.rm(lockPath(), { force: true });
            expect(await acquireStoreLock()).toBe("locked");
          },
        },
      ],
    ] as const)(
      "%s: the open succeeds, the old session and envelope stay, and the next open finishes",
      async (_label, obstacle) => {
        await storeOldRecords();
        const oldEnvelope = envelopePath(docHash(fx.aliasPath));
        const before = await fs.readFile(oldEnvelope);
        vi.spyOn(console, "error").mockImplementation(() => {});

        await obstacle.raise();
        let opened: Awaited<ReturnType<typeof openFromDisk>>;
        try {
          opened = await openFromDisk(fx.aliasPath);
          // The stop is the reason the session stayed, not a missing wiring
          // or lock that the test forgot to raise.
          if (_label.startsWith("the annotation store is not wired")) {
            expect(getFileSyncContext(opened.documentId)).toBeUndefined();
          }
        } finally {
          await obstacle.clear();
        }
        try {
          expect(opened.kind).toBe("restored");
          expect(liveText(opened.documentId)).toContain("unsaved line");
          // Not moved: the old-key session is the only session file there is.
          expect(await sessionFiles()).toEqual([`${sessionKey(fx.aliasPath)}.json`]);
          expect((await fs.readFile(oldEnvelope)).equals(before)).toBe(true);

          // The next start, with the obstacle gone, finishes the job.
          await simulateRestart();
          const again = await openFromDisk(fx.aliasPath);
          expect(liveText(again.documentId)).toContain("unsaved line");
          const anns = liveAnnotations(again.documentId);
          expect(anns.has("ann_comment")).toBe(true);
          expect(anns.has("ann_note")).toBe(true);
          expect(await exists(oldEnvelope)).toBe(false);
          expect(await sessionFiles()).toEqual([`${sessionKey(fx.longPath)}.json`]);
          const envelope = await readEnvelope(fx.longPath);
          expect(envelope.annotations.map((a) => a.id).sort()).toEqual(["ann_comment", "ann_note"]);
          expect(envelope.tombstones.map((t) => t.id)).toEqual(["ann_deleted"]);
        } finally {
          await releaseStoreLock();
        }
      },
    );

    it("the annotation store switched off for the run leaves an old envelope and its session in place", async () => {
      await storeOldRecords();
      const oldEnvelope = envelopePath(docHash(fx.aliasPath));
      const before = await fs.readFile(oldEnvelope);
      vi.spyOn(console, "error").mockImplementation(() => {});

      process.env.TANDEM_ANNOTATION_STORE = "off";
      const opened = await openFromDisk(fx.aliasPath);
      expect(opened.kind).toBe("restored");
      expect(await sessionFiles()).toEqual([`${sessionKey(fx.aliasPath)}.json`]);
      expect((await fs.readFile(oldEnvelope)).equals(before)).toBe(true);

      // Switched back on at a later start: carried over.
      await simulateRestart();
      delete process.env.TANDEM_ANNOTATION_STORE;
      const again = await openFromDisk(fx.aliasPath);
      expect(liveAnnotations(again.documentId).has("ann_comment")).toBe(true);
      expect(await exists(oldEnvelope)).toBe(false);
      expect(await sessionFiles()).toEqual([`${sessionKey(fx.longPath)}.json`]);
    });
  });

  // Startup restore replays only sessions within 30 minutes of the newest one,
  // and autosave keeps moving the open document's own session forward. A kept
  // old-key session that fell out of that window would never be retried.
  describe("a kept old-key session and the restore window", () => {
    const WINDOW_MS = 30 * 60_000;
    const stampOf = async (keyPath: string): Promise<number> =>
      JSON.parse(await fs.readFile(sessionFile(keyPath), "utf-8")).lastAccessed;

    it("is re-stamped by every autosave, just behind the document's own session, so the next start replays it", async () => {
      // Clean, with no conflict: nothing but the window decides the replay.
      await storeSession(fx.aliasPath, DISK, { dirty: false });
      await storeEnvelope(fx.aliasPath, { annotations: [comment] });
      const oldEnvelope = envelopePath(docHash(fx.aliasPath));
      vi.spyOn(console, "error").mockImplementation(() => {});
      const intervals = vi.spyOn(globalThis, "setInterval");

      const restoreReads = failReadsOf(oldEnvelope, "EBUSY");
      const opened = await openFromDisk(fx.aliasPath);
      restoreReads();
      expect(await sessionFiles()).toEqual([`${sessionKey(fx.aliasPath)}.json`]);
      const storedAt = await stampOf(fx.aliasPath);

      // The autosave tick itself (the timer's own callback), 45 minutes on.
      // 60 s is `AUTO_SAVE_INTERVAL` (session/manager.ts, not exported).
      const tick = intervals.mock.calls.find((c) => c[1] === 60_000)?.[0] as
        | (() => Promise<void>)
        | undefined;
      expect(tick).toBeTypeOf("function");
      const later = Date.now() + WINDOW_MS + 15 * 60_000;
      vi.spyOn(Date, "now").mockReturnValue(later);
      await tick?.();

      const own = await stampOf(fx.longPath);
      const kept = await stampOf(fx.aliasPath);
      expect(own).toBe(later);
      expect(own - storedAt).toBeGreaterThan(WINDOW_MS);
      expect(kept).toBeLessThan(own);
      expect(own - kept).toBeLessThanOrEqual(WINDOW_MS);
      expect((await listSessionFilePaths()).map((s) => s.holdsUnsavedWork)).toEqual([false, false]);

      // The next start: the kept session is replayed, and with the read
      // working again the carry-over completes.
      await simulateRestart();
      stopAutoSave();
      expect(await restoreOpenDocuments(null)).toBe(2);
      expect(getOpenDocs().size).toBe(1);
      expect(liveAnnotations(opened.documentId).has("ann_comment")).toBe(true);
      expect(await exists(oldEnvelope)).toBe(false);
      expect(await sessionFiles()).toEqual([`${sessionKey(fx.longPath)}.json`]);
    });

    it("writes nothing for a document that has no kept session", async () => {
      await storeOldRecords();
      const opened = await openFromDisk(fx.longPath);
      await saveCurrentSession();
      const before = {
        old: await fs.readFile(sessionFile(fx.aliasPath)),
        own: await fs.readFile(sessionFile(fx.longPath)),
        files: await fs.readdir(SESSION_DIR),
      };
      const writes = [vi.spyOn(fs, "writeFile"), vi.spyOn(fs, "rename"), vi.spyOn(fs, "open")];

      await keepLegacySessionInWindow(opened.documentId, Date.now() + 3_600_000);
      await keepLegacySessionInWindow("no-such-document", Date.now() + 3_600_000);

      for (const spy of writes) expect(spy).not.toHaveBeenCalled();
      expect((await fs.readFile(sessionFile(fx.aliasPath))).equals(before.old)).toBe(true);
      expect((await fs.readFile(sessionFile(fx.longPath))).equals(before.own)).toBe(true);
      expect(await fs.readdir(SESSION_DIR)).toEqual(before.files);
    });
  });

  // An expansion failure (R4.5) registers the document under the short string
  // itself, so that string's key holds a LIVE document's own records. A later
  // open whose expansion succeeds computes the same string as its "old key".
  it.each([
    ["a normal open", false],
    ["an open onto the already-open long-spelled document", true],
  ] as const)(
    "%s leaves the records of a live document registered under the short string alone",
    async (_label, longAlreadyOpen) => {
      uninstallAliasExpansion();
      installAliasExpansion({
        realpathError: Object.assign(new Error("EPERM"), { code: "EPERM" }),
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const live = await openFromDisk(fx.aliasPath);
      const shortString = fsSync.realpathSync(fx.aliasPath);
      expect(getOpenDocs().get(live.documentId)?.filePath).toBe(shortString);
      const liveDoc = getOrCreateDocument(live.documentId);
      withBrowser(liveDoc, () =>
        liveDoc
          .getMap(Y_MAP_ANNOTATIONS)
          .set("ann_mine", annRecord({ id: "ann_mine", author: "user", rev: 1 })),
      );
      await saveCurrentSession();
      await closeStore(docHash(shortString));
      const before = {
        session: await fs.readFile(sessionFile(shortString)),
        envelope: await fs.readFile(envelopePath(docHash(shortString))),
      };

      // The expansion works again.
      uninstallAliasExpansion();
      installAliasExpansion();
      if (longAlreadyOpen) await openFromDisk(fx.longPath);
      const second = await openFromDisk(fx.aliasPath);
      await quiesceForTesting();

      expect(second.documentId).toBe(docIdFromPath(fx.longPath));
      expect(second.documentId).not.toBe(live.documentId);
      expect(second.kind).toBe(longAlreadyOpen ? "already-open" : "fresh");
      expect(liveAnnotations(second.documentId).has("ann_mine")).toBe(false);
      expect(liveAnnotations(live.documentId).has("ann_mine")).toBe(true);
      expect((await fs.readFile(sessionFile(shortString))).equals(before.session)).toBe(true);
      expect((await fs.readFile(envelopePath(docHash(shortString)))).equals(before.envelope)).toBe(
        true,
      );
    },
  );

  it("an old-key session whose removal fails stays until the document closes, and is removed then", async () => {
    await storeOldRecords();
    const oldSession = sessionFile(fx.aliasPath);
    const realUnlink = fs.unlink.bind(fs);
    let refused = 0;
    vi.spyOn(fs, "unlink").mockImplementation(((p: unknown) => {
      if (p === oldSession && refused === 0) {
        refused++;
        return Promise.reject(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));
      }
      return realUnlink(p as string);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const opened = await openFromDisk(fx.aliasPath);
    expect(refused).toBe(1);
    // Everything it held is durable under the new key; only the unlink is owed.
    expect(await exists(oldSession)).toBe(true);
    expect(await exists(sessionFile(fx.longPath))).toBe(true);
    expect(await exists(envelopePath(docHash(fx.aliasPath)))).toBe(false);

    await closeDocumentById(opened.documentId);
    expect(await exists(oldSession)).toBe(false);
  });

  // The old envelope goes only when the NEW one, read back from disk, holds
  // everything it held. A resolved flush is not that proof.
  it.each([
    [
      "is missing one of its records",
      (raw: string): string => {
        const file = JSON.parse(raw);
        file.annotations = file.annotations.filter((a: { id: string }) => a.id !== "ann_note");
        return JSON.stringify(file);
      },
    ],
    ["is not there at all", null],
  ] as const)(
    "a new envelope that, read back, %s leaves the old envelope and the old session in place",
    async (_label, tamper) => {
      await storeSession(fx.aliasPath, "alpha beta gamma\n\nunsaved line\n", {
        annotations: [comment],
      });
      await storeEnvelope(fx.aliasPath, { annotations: [comment, note] });
      const oldEnvelope = envelopePath(docHash(fx.aliasPath));
      const newEnvelope = envelopePath(docHash(fx.longPath));
      const before = await fs.readFile(oldEnvelope);
      vi.spyOn(console, "error").mockImplementation(() => {});

      const realReadFile = fs.readFile.bind(fs) as (...a: unknown[]) => Promise<unknown>;
      let readBacks = 0;
      const reads = vi.spyOn(fs, "readFile").mockImplementation((async (
        p: unknown,
        ...rest: unknown[]
      ) => {
        if (p !== newEnvelope) return realReadFile(p, ...rest);
        if (tamper === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        const raw = (await realReadFile(p, "utf-8")) as string;
        readBacks++;
        return tamper(raw);
      }) as never);

      const opened = await openFromDisk(fx.aliasPath);
      reads.mockRestore();
      // The write itself landed (so the read-back is what refused).
      expect((await readEnvelope(fx.longPath)).annotations.map((a) => a.id).sort()).toEqual([
        "ann_comment",
        "ann_note",
      ]);
      if (tamper !== null) expect(readBacks).toBeGreaterThan(0);
      expect(opened.kind).toBe("restored");
      expect((await fs.readFile(oldEnvelope)).equals(before)).toBe(true);
      expect(await exists(sessionFile(fx.aliasPath))).toBe(true);

      await simulateRestart();
      const again = await openFromDisk(fx.aliasPath);
      expect(liveAnnotations(again.documentId).has("ann_note")).toBe(true);
      expect(await exists(oldEnvelope)).toBe(false);
      expect(await exists(sessionFile(fx.aliasPath))).toBe(false);
    },
  );

  it("looks up old records by key only: listing and cleanup make no filesystem call on a stored path (R2.6)", async () => {
    await storeOldRecords();
    await storeSession(fx.longPath, DISK, { dirty: false });
    const stored = [fx.aliasPath, fx.longPath];
    // Every way these modules can reach the filesystem with a path, not a
    // list of the ones they use today.
    const spied = [
      ...(
        [
          "stat",
          "lstat",
          "realpath",
          "access",
          "readFile",
          "open",
          "readdir",
          "opendir",
          "readlink",
          "utimes",
          "unlink",
          "rm",
          "rename",
          "copyFile",
        ] as const
      ).map((name) => vi.spyOn(fs, name)),
      ...(
        [
          "existsSync",
          "statSync",
          "lstatSync",
          "realpathSync",
          "accessSync",
          "readFileSync",
          "openSync",
          "readdirSync",
        ] as const
      ).map((name) => vi.spyOn(fsSync, name)),
    ];
    const touched = (): string[] =>
      spied.flatMap((spy) =>
        (spy.mock.calls as unknown[][]).map((call) => path.resolve(String(call[0]))),
      );
    const onStoredPath = (p: string): boolean =>
      stored.some((s) => p === s || p.toLowerCase() === s.toLowerCase());

    const listed = await listSessionFilePaths();
    await cleanupSessions();
    expect(listed.map((s) => s.filePath).sort()).toEqual([...stored].sort());
    // The session files themselves were read, so the spies were watching...
    expect(touched().some((p) => p.startsWith(path.resolve(SESSION_DIR)))).toBe(true);
    // ...and nothing was asked about a path a session names.
    expect(touched().filter(onStoredPath)).toEqual([]);
    expect(spies.realpathNative).not.toHaveBeenCalled();
    expect(spies.lstat).not.toHaveBeenCalled();

    // Control: a call on a stored path is what this would have caught.
    await fs.stat(fx.aliasPath);
    fsSync.existsSync(fx.longPath);
    expect(touched().filter(onStoredPath).sort()).toEqual([...stored].sort());
  });

  it("does not read or move backups stored under the old key (R2.8)", async () => {
    const oldDir = path.join(docBackupsRoot(resolveAppDataDir()), docHash(fx.aliasPath));
    await fs.mkdir(oldDir, { recursive: true });
    const kept = path.join(oldDir, "old-20260101-000000-abcdef12.md");
    await fs.writeFile(kept, "an earlier backup\n", "utf-8");
    await storeOldRecords();
    await openFromDisk(fx.aliasPath);
    expect(await fs.readFile(kept, "utf-8")).toBe("an earlier backup\n");
    expect(await fs.readdir(oldDir)).toEqual(["old-20260101-000000-abcdef12.md"]);
    expect(await backupTexts()).toEqual([]);
  });

  it("leaves existing long-spelled records byte-identical when there is nothing under the old key", async () => {
    await storeSession(fx.longPath, DISK, { dirty: false, lastAccessed: T0 });
    await storeEnvelope(fx.longPath, { annotations: [comment] });
    const before = {
      session: await fs.readFile(sessionFile(fx.longPath)),
      envelope: await fs.readFile(envelopePath(docHash(fx.longPath))),
    };
    await openFromDisk(fx.aliasPath);
    await quiesceForTesting();
    expect((await fs.readFile(sessionFile(fx.longPath))).equals(before.session)).toBe(true);
    expect((await fs.readFile(envelopePath(docHash(fx.longPath)))).equals(before.envelope)).toBe(
      true,
    );
  });
});

// The POSIX half of R1.5: ids and keys for fixed paths, as literals recorded
// from master (89bd411) on Linux. `path.resolve` gives these strings a drive
// letter on Windows, so the table is checked off Windows only; the Windows
// half is the "no expansion call" test above and the real-volume file.
describe.skipIf(process.platform === "win32")(
  "ids and keys are unchanged (recorded from master)",
  () => {
    it.each([
      [
        "/home/u/Docs/Report.md",
        "report-35w5iw",
        "4d090a4a6e1014c007dc86903b18c4a5c8d869bfb5e176031a3f11e3613a90f1",
      ],
      [
        "/home/u/AFOLDE~1/x.md",
        "x-rltmaz",
        "3673aad30aec0fbd75a70ded7ea772d72712a3385d81b3328b86196221cb89b2",
      ],
      [
        "/home/u/notes~1.md",
        "notes-1-npgrck",
        "daa0ed8ab3665f9126ba6220eb29f580135873e2531b81e04b4156cf06320f50",
      ],
      [
        "/srv/a folder with a long name/LONGFI~1.MD",
        "longfi-1-kdknru",
        "42fe731d3165d4259d68a30d8abee0c7b9b7a354e6e8c06463eeb1ad557a3564",
      ],
      [
        "/tmp/x.txt",
        "x-i1d1l9",
        "5e044a98f005ffec08335b07fd993288c16bcb9f849d6373a3339fc21863066f",
      ],
    ])("%s", (p, id, hash) => {
      expect(docIdFromPath(p)).toBe(id);
      expect(docHash(p)).toBe(hash);
      expect(sessionKey(p)).toBe(hash);
    });

    it("an alias-shaped path opens under exactly the string realpathSync gives, off win32", async () => {
      uninstallAliasExpansion();
      const opened = await openFromDisk(fx.aliasPath);
      expect(opened.filePath).toBe(fsSync.realpathSync(fx.aliasPath));
      expect(opened.documentId).toBe(docIdFromPath(fx.aliasPath));
    });
  },
);
