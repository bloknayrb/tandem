/**
 * One file, one document, and the records stored under an 8.3 short spelling
 * (#2400: Requirements 1 and 4, and the simple move that replaced Requirement
 * 2), through the real open and restore paths.
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

import { docHash } from "../../src/server/annotations/doc-hash.js";
import { isClaudeFacing } from "../../src/server/annotations/projection.js";
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
import { readPendingConflict } from "../../src/server/documents/conflict.js";
import { isDirty } from "../../src/server/documents/dirty.js";
import { openFromDisk, openFromRestore } from "../../src/server/documents/open.js";
import { resolveExternalConflict } from "../../src/server/documents/reload-family.js";
import { getFileSyncContext } from "../../src/server/events/queue.js";
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
import {
  cleanupOrphanedAnnotationFiles,
  cleanupSessions,
  deleteSession,
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
import { withBrowser } from "../../src/shared/origins.js";
import type { Annotation } from "../../src/shared/types.js";
import {
  annRecord,
  makeAnnotationDoc,
  replyRecord,
  writeEnvelopeToDisk,
} from "../helpers/annotation-fixtures.js";
import { useTmpAnnotationsEnvWithFlag } from "../helpers/annotation-store-env.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
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
 * A saved session under `keyPath`'s key, holding `markdown` (unsaved work
 * unless `dirty: false`) and optional annotation records.
 */
async function storeSession(
  keyPath: string,
  markdown: string,
  opts: { dirty?: boolean; annotations?: Array<Record<string, unknown>> } = {},
): Promise<void> {
  const doc = await docFromMarkdown(markdown);
  const map = doc.getMap(Y_MAP_ANNOTATIONS);
  for (const a of opts.annotations ?? []) map.set(a.id as string, a);
  await saveSession(keyPath, "md", doc, { dirty: opts.dirty ?? true });
  doc.destroy();
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
  const spy = vi
    .spyOn(fs, "readFile")
    .mockImplementation(((p: unknown, ...rest: unknown[]) =>
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

  // A restore entry's `readOnly` is a STORED flag of one session. A
  // short-spelled entry replayed onto a document that is already open names a
  // session that did not become the document, so its flag does not apply.
  // (The stored flags of real sessions, in both replay orders, are in "the
  // read-only flag on a startup-restore replay" below.)
  it("a replayed short-spelled restore entry's read-only flag does not turn the open document read-only", async () => {
    const opened = await openFromRestore({ filePath: fx.longPath, readOnly: false });
    const replayed = await openFromRestore({ filePath: fx.aliasPath, readOnly: true });
    expect(replayed.kind).toBe("already-open");
    expect(replayed.documentId).toBe(opened.documentId);
    expect(replayed.readOnly).toBe(false);
    expect(getOpenDocs().get(opened.documentId)?.readOnly).toBe(false);
    expect(
      getOrCreateDocument(opened.documentId).getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_READ_ONLY),
    ).not.toBe(true);
  });

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

// The old key is the one master computes for the short spelling: the fixture's
// alias path is already the string `realpathSync` gives for it.
describe("records saved under the short spelling are moved, per kind, only into an empty place", () => {
  const OLD_TEXT = "alpha beta gamma\n\nfrom the short spelling\n";
  const NEW_TEXT = "alpha beta gamma\n\nfrom the long spelling\n";

  const comment = annRecord({
    id: "ann_comment",
    author: "user",
    audience: "outbound",
    rev: 1,
  } as Partial<Annotation> as never);
  const note = annRecord({
    id: "ann_note",
    author: "user",
    type: "note",
    audience: "private",
    rev: 1,
  } as Partial<Annotation> as never);
  /** A stale copy of a record the envelope has since tombstoned at a higher revision. */
  const deletedCopy = annRecord({ id: "ann_deleted", author: "user", rev: 1 });

  const oldSession = () => sessionFile(fx.aliasPath);
  const newSession = () => sessionFile(fx.longPath);
  const oldEnvelope = () => envelopePath(docHash(fx.aliasPath));
  const newEnvelope = () => envelopePath(docHash(fx.longPath));

  /** The full set: unsaved text and the records a real session carries, plus the envelope. */
  async function storeFullRecords(keyPath: string): Promise<void> {
    await storeSession(keyPath, OLD_TEXT, { annotations: [comment, note, deletedCopy] });
    await storeEnvelope(keyPath, {
      annotations: [comment, note],
      tombstones: [{ id: "ann_deleted", rev: 3, deletedAt: T0 }],
      replies: [replyRecord({ id: "rep_1", annotationId: "ann_comment" })],
    });
  }

  /**
   * One record per kind, each recognisable on its own: the session holds only
   * text, the envelope only a comment. A comment in the document then proves
   * the envelope was loaded, and the text proves the session was.
   */
  async function storeOldPair(): Promise<void> {
    await storeSession(fx.aliasPath, OLD_TEXT);
    await storeEnvelope(fx.aliasPath, { annotations: [comment] });
  }

  interface Frozen {
    bytes: Buffer;
    mtimeMs: number;
  }
  let frozenCount = 0;
  /**
   * Give `file` a past mtime no rewrite would reproduce, and record it with
   * the bytes. A link-and-unlink round trip changes neither.
   */
  async function freeze(file: string): Promise<Frozen> {
    const at = new Date(Date.now() - 3_600_000 - 1000 * ++frozenCount);
    await fs.utimes(file, at, at);
    return { bytes: await fs.readFile(file), mtimeMs: (await fs.stat(file)).mtimeMs };
  }
  async function expectUntouched(file: string, frozen: Frozen): Promise<void> {
    expect((await fs.readFile(file)).equals(frozen.bytes)).toBe(true);
    expect((await fs.stat(file)).mtimeMs).toBe(frozen.mtimeMs);
  }

  /** Everything a user (and Claude) can observe about an opened document's carried state. */
  function stateOf(opened: { documentId: string; kind: string; readOnly: boolean }) {
    const doc = getOrCreateDocument(opened.documentId);
    const conflict = readPendingConflict(doc);
    return {
      kind: opened.kind,
      readOnly: opened.readOnly,
      text: extractText(doc),
      annotations: [...liveAnnotations(opened.documentId).values()]
        .map((a) => ({
          id: a.id,
          type: a.type,
          audience: a.audience,
          claudeFacing: isClaudeFacing(a),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      replies: [...doc.getMap(Y_MAP_ANNOTATION_REPLIES).keys()].sort(),
      tombstones: getTombstones(docHash(fx.longPath))
        .map((t) => t.id)
        .sort(),
      dirty: isDirty(opened.documentId),
      conflict:
        conflict === undefined
          ? null
          : { kind: conflict.kind, diskChanged: conflict.diskChanged === true },
    };
  }

  function expectFullRecordsIn(state: ReturnType<typeof stateOf>): void {
    expect(state.text).toContain("from the short spelling");
    expect(state.annotations).toEqual([
      { id: "ann_comment", type: "comment", audience: "outbound", claudeFacing: true },
      // Still a private note: not converted, and not readable by Claude.
      { id: "ann_note", type: "note", audience: "private", claudeFacing: false },
    ]);
    expect(state.replies).toEqual(["rep_1"]);
    // The tombstone is in the ledger AND did its job: the session's stale copy
    // of that record (present in `storeFullRecords`) is not in the document.
    expect(state.tombstones).toEqual(["ann_deleted"]);
  }

  async function expectFullRecordsOnDisk(): Promise<void> {
    expect(await exists(oldSession())).toBe(false);
    expect(await exists(oldEnvelope())).toBe(false);
    expect(await sessionFiles()).toEqual([`${sessionKey(fx.longPath)}.json`]);
    await quiesceForTesting();
    const envelope = await readEnvelope(fx.longPath);
    expect(envelope.docHash).toBe(docHash(fx.longPath));
    expect(envelope.meta.filePath).toBe(fx.longPath);
    expect(envelope.annotations.map((a) => a.id).sort()).toEqual(["ann_comment", "ann_note"]);
    const storedNote = envelope.annotations.find((a) => a.id === "ann_note");
    expect(storedNote?.type).toBe("note");
    expect((storedNote as { audience?: string } | undefined)?.audience).toBe("private");
    expect(envelope.tombstones.map((t) => t.id)).toEqual(["ann_deleted"]);
    expect(envelope.replies.map((r) => r.id)).toEqual(["rep_1"]);
  }

  /** What an ordinary open of the long spelling gives for the same records stored under ITS key. */
  async function stateOfAnOrdinaryOpen(): Promise<ReturnType<typeof stateOf>> {
    await simulateRestart();
    await wipeStores();
    await fs.writeFile(fx.longPath, DISK, "utf-8");
    await storeFullRecords(fx.longPath);
    return stateOf(await openFromDisk(fx.longPath));
  }

  async function wipeStores(): Promise<void> {
    for (const dir of [SESSION_DIR, getAnnotationsDir()]) {
      for (const f of await fs.readdir(dir).catch(() => [])) {
        await fs.rm(path.join(dir, f), { force: true });
      }
    }
  }

  /** Close the way a user closes a document whose work is saved: nothing is left to reopen. */
  async function closeCleanly(id: string): Promise<void> {
    const doc = getOrCreateDocument(id);
    if (readPendingConflict(doc) !== undefined) await resolveExternalConflict(id, "keep");
    await autoSaveAllToDisk();
    // The save replaced the file; the fixture's alias follows it, as an 8.3
    // name does.
    await fx.relinkAlias();
    expect(isDirty(id)).toBe(false);
    expect(readPendingConflict(doc)).toBeUndefined();
    await closeDocumentById(id);
  }

  /** Make `fs.link` reject for one source file. */
  function failLinksOf(file: string): { calls: () => number; restore: () => void } {
    const real = fs.link.bind(fs);
    let calls = 0;
    const spy = vi.spyOn(fs, "link").mockImplementation(((from: unknown, to: unknown) => {
      if (from === file) {
        calls++;
        return Promise.reject(Object.assign(new Error("EPERM"), { code: "EPERM" }));
      }
      return real(from as string, to as string);
    }) as never);
    return { calls: () => calls, restore: () => spy.mockRestore() };
  }

  /** Make `fs.unlink` reject for one file. */
  function failUnlinksOf(file: string): { calls: () => number; restore: () => void } {
    const real = fs.unlink.bind(fs);
    let calls = 0;
    const spy = vi.spyOn(fs, "unlink").mockImplementation(((p: unknown) => {
      if (p === file) {
        calls++;
        return Promise.reject(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));
      }
      return real(p as string);
    }) as never);
    return { calls: () => calls, restore: () => spy.mockRestore() };
  }

  const hasComment = (id: string) => liveAnnotations(id).has("ann_comment");

  // --- 1 and 2: the move, through both entry points -------------------------

  it("a short-spelled open moves the session and the envelope, and is then an ordinary open of the long spelling", async () => {
    await storeFullRecords(fx.aliasPath);
    const opened = await openFromDisk(fx.aliasPath);
    const state = stateOf(opened);
    expect(opened.filePath).toBe(fx.longPath);
    expectFullRecordsIn(state);
    await expectFullRecordsOnDisk();

    // Unsaved work, banner and conflict state: exactly what the same records
    // stored under the long spelling's own key give.
    expect(state.kind).toBe("restored");
    expect(state.dirty).toBe(true);
    expect(state).toEqual(await stateOfAnOrdinaryOpen());
  });

  it("after the move, closing and restarting does not bring the document back", async () => {
    await storeFullRecords(fx.aliasPath);
    const opened = await openFromDisk(fx.aliasPath);
    await closeCleanly(opened.documentId);
    await simulateRestart();

    expect(await sessionFiles()).toEqual([]);
    expect(await listSessionFilePaths()).toEqual([]);
    expect(await restoreOpenDocuments(null)).toBe(0);
    expect(getOpenDocs().size).toBe(0);
    // The file took the unsaved text, and the comments are still its comments.
    expect(await fs.readFile(fx.longPath, "utf-8")).toContain("from the short spelling");
    const again = await openFromDisk(fx.longPath);
    expect(again.kind).toBe("fresh");
    expect([...liveAnnotations(again.documentId).keys()].sort()).toEqual([
      "ann_comment",
      "ann_note",
    ]);
  });

  it("startup restore replaying the stored short spelling moves both, and a close and restart leaves nothing", async () => {
    await storeFullRecords(fx.aliasPath);
    expect((await listSessionFilePaths()).map((s) => s.filePath)).toEqual([fx.aliasPath]);

    expect(await restoreOpenDocuments(null)).toBe(1);
    const id = docIdFromPath(fx.longPath);
    expect([...getOpenDocs().keys()]).toEqual([id]);
    expect(getOpenDocs().get(id)?.filePath).toBe(fx.longPath);
    const state = stateOf({ documentId: id, kind: "restored", readOnly: false });
    expectFullRecordsIn(state);
    expect(state.dirty).toBe(true);
    await expectFullRecordsOnDisk();
    expect(getOpenDocs().get(id)?.readOnly).toBe(false);

    await closeCleanly(id);
    await simulateRestart();
    expect(await sessionFiles()).toEqual([]);
    expect(await restoreOpenDocuments(null)).toBe(0);
    expect(getOpenDocs().size).toBe(0);
  });

  // --- 3: one kind's place is taken -----------------------------------------

  it("a session already under the new key: the old session is left byte-identical and the envelope still moves", async () => {
    await storeOldPair();
    await storeSession(fx.longPath, NEW_TEXT);
    const frozen = await freeze(oldSession());
    const link = vi.spyOn(fs, "link");

    const opened = await openFromDisk(fx.aliasPath);
    expect(opened.kind).toBe("restored");
    expect(liveText(opened.documentId)).toContain("from the long spelling");
    expect(liveText(opened.documentId)).not.toContain("from the short spelling");
    await expectUntouched(oldSession(), frozen);
    // The envelope moved and is the document's.
    expect(hasComment(opened.documentId)).toBe(true);
    expect(await exists(oldEnvelope())).toBe(false);
    expect(await exists(newEnvelope())).toBe(true);
    expect(link.mock.calls.map((c) => c[0])).toEqual([oldEnvelope()]);
  });

  it("an envelope already under the new key: the old envelope is left byte-identical and the session still moves", async () => {
    await storeOldPair();
    await storeEnvelope(fx.longPath, {
      annotations: [annRecord({ id: "ann_new", author: "user", rev: 1 })],
    });
    const frozen = await freeze(oldEnvelope());
    const link = vi.spyOn(fs, "link");

    const opened = await openFromDisk(fx.aliasPath);
    expect(opened.kind).toBe("restored");
    expect(liveText(opened.documentId)).toContain("from the short spelling");
    expect(await exists(oldSession())).toBe(false);
    expect(await exists(newSession())).toBe(true);
    // Nothing merged: the long spelling's comments are the document's.
    expect([...liveAnnotations(opened.documentId).keys()]).toEqual(["ann_new"]);
    await quiesceForTesting();
    await expectUntouched(oldEnvelope(), frozen);
    expect((await readEnvelope(fx.longPath)).annotations.map((a) => a.id)).toEqual(["ann_new"]);
    expect(link.mock.calls.map((c) => c[0])).toEqual([oldSession()]);
  });

  // --- 4: both kinds under both keys (M7) -----------------------------------

  it("records of both kinds under both keys: nothing moves; after a close the old session moves in once, and the old envelope is never used", async () => {
    await storeOldPair();
    await storeSession(fx.longPath, NEW_TEXT);
    await storeEnvelope(fx.longPath, {
      annotations: [annRecord({ id: "ann_new", author: "user", rev: 1 })],
    });
    const frozenSession = await freeze(oldSession());
    const frozenEnvelope = await freeze(oldEnvelope());
    const link = vi.spyOn(fs, "link");

    // The long-spelling records are the document.
    const opened = await openFromDisk(fx.aliasPath);
    expect(opened.kind).toBe("restored");
    expect(liveText(opened.documentId)).toContain("from the long spelling");
    expect(liveText(opened.documentId)).not.toContain("from the short spelling");
    expect([...liveAnnotations(opened.documentId).keys()]).toEqual(["ann_new"]);
    expect(link).not.toHaveBeenCalled();
    await expectUntouched(oldSession(), frozenSession);
    await expectUntouched(oldEnvelope(), frozenEnvelope);

    // The user saves and closes: the long-spelling session is removed.
    await closeCleanly(opened.documentId);
    await simulateRestart();
    expect(await sessionFiles()).toEqual([`${sessionKey(fx.aliasPath)}.json`]);
    await expectUntouched(oldSession(), frozenSession);

    // The next start replays the short-spelled session (it holds unsaved
    // work): it moves in, and the document comes back with ITS content.
    expect(await restoreOpenDocuments(null)).toBe(1);
    const id = docIdFromPath(fx.longPath);
    expect([...getOpenDocs().keys()]).toEqual([id]);
    expect(liveText(id)).toContain("from the short spelling");
    expect(liveText(id)).not.toContain("from the long spelling");
    expect(await sessionFiles()).toEqual([`${sessionKey(fx.longPath)}.json`]);
    // The file on disk has moved on since that session was saved (the close
    // above wrote it), so this is the usual keep-or-reload banner.
    expect(readPendingConflict(getOrCreateDocument(id))).toMatchObject({ diskChanged: true });
    // Its comments file is still the long spelling's; the old one is not used.
    expect([...liveAnnotations(id).keys()]).toEqual(["ann_new"]);
    await quiesceForTesting();
    await expectUntouched(oldEnvelope(), frozenEnvelope);
    // (The fixture re-linking its alias is the other `link` caller.)
    expect(link.mock.calls.map((c) => c[0]).filter((from) => from !== fx.longPath)).toEqual([
      oldSession(),
    ]);

    // The user keeps that text, saves and closes: nothing is left to reopen.
    await closeCleanly(id);
    await simulateRestart();
    expect(await sessionFiles()).toEqual([]);
    expect(await restoreOpenDocuments(null)).toBe(0);
    expect(getOpenDocs().size).toBe(0);
    await expectUntouched(oldEnvelope(), frozenEnvelope);
  });

  // --- 5: a move that fails -------------------------------------------------

  it("a session move that fails leaves it intact, the envelope still moves, and the next short-spelled open moves the session", async () => {
    await storeOldPair();
    const frozen = await freeze(oldSession());
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = failLinksOf(oldSession());

    const opened = await openFromDisk(fx.aliasPath);
    expect(failing.calls()).toBe(1);
    // An ordinary open without the session: the file's own text.
    expect(opened.kind).toBe("fresh");
    expect(liveText(opened.documentId)).not.toContain("from the short spelling");
    await expectUntouched(oldSession(), frozen);
    expect(await exists(newSession())).toBe(false);
    expect(hasComment(opened.documentId)).toBe(true);
    expect(await exists(oldEnvelope())).toBe(false);

    // Closed (not merely opened again: an already-open document moves nothing).
    await closeDocumentById(opened.documentId);
    await simulateRestart();
    failing.restore();
    await expectUntouched(oldSession(), frozen);

    const again = await openFromDisk(fx.aliasPath);
    expect(again.kind).toBe("restored");
    expect(liveText(again.documentId)).toContain("from the short spelling");
    expect(hasComment(again.documentId)).toBe(true);
    expect(await sessionFiles()).toEqual([`${sessionKey(fx.longPath)}.json`]);
  });

  it("an envelope move that fails leaves it intact, the session still moves, and the next short-spelled open moves the envelope", async () => {
    await storeOldPair();
    const frozen = await freeze(oldEnvelope());
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = failLinksOf(oldEnvelope());

    const opened = await openFromDisk(fx.aliasPath);
    expect(failing.calls()).toBe(1);
    expect(opened.kind).toBe("restored");
    expect(liveText(opened.documentId)).toContain("from the short spelling");
    expect(await exists(oldSession())).toBe(false);
    expect(hasComment(opened.documentId)).toBe(false);
    await quiesceForTesting();
    await expectUntouched(oldEnvelope(), frozen);

    await closeCleanly(opened.documentId);
    await simulateRestart();
    failing.restore();
    await expectUntouched(oldEnvelope(), frozen);

    const again = await openFromDisk(fx.aliasPath);
    expect(hasComment(again.documentId)).toBe(true);
    expect(await exists(oldEnvelope())).toBe(false);
    expect((await readEnvelope(fx.longPath)).annotations.map((a) => a.id)).toEqual(["ann_comment"]);
  });

  // The stated M2 behaviour, pinned: the retry is only into an EMPTY place. A
  // session saved for the open document after a failed move takes that place.
  it("after a failed session move, a session save for the open document takes the place: the old session then stays as it is", async () => {
    await storeOldPair();
    const frozen = await freeze(oldSession());
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = failLinksOf(oldSession());
    const opened = await openFromDisk(fx.aliasPath);
    failing.restore();
    expect(opened.kind).toBe("fresh");

    // The 60 s autosave's session write, for a document the user typed in.
    const doc = getOrCreateDocument(opened.documentId);
    withBrowser(doc, () =>
      doc
        .getMap(Y_MAP_ANNOTATIONS)
        .set("ann_typed", annRecord({ id: "ann_typed", author: "user", rev: 1 })),
    );
    await saveCurrentSession();
    expect(await exists(newSession())).toBe(true);
    // The process ends without a close (a close would remove that session).
    await simulateRestart();

    const link = vi.spyOn(fs, "link");
    const again = await openFromDisk(fx.aliasPath);
    expect(link).not.toHaveBeenCalled();
    expect(liveText(again.documentId)).not.toContain("from the short spelling");
    expect(liveAnnotations(again.documentId).has("ann_typed")).toBe(true);
    await expectUntouched(oldSession(), frozen);
  });

  // --- 6: the old name cannot be removed after the link ---------------------

  it("a session whose old name cannot be removed: the new name is taken away again and the open is one without that session", async () => {
    await storeOldPair();
    const frozen = await freeze(oldSession());
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = failUnlinksOf(oldSession());

    const opened = await openFromDisk(fx.aliasPath);
    failing.restore();
    expect(failing.calls()).toBe(1);
    expect(opened.kind).toBe("fresh");
    expect(liveText(opened.documentId)).not.toContain("from the short spelling");
    // One name, the old one, unchanged.
    expect(await sessionFiles()).toEqual([`${sessionKey(fx.aliasPath)}.json`]);
    await expectUntouched(oldSession(), frozen);
    // The other kind is not held back.
    expect(hasComment(opened.documentId)).toBe(true);
    expect(await exists(oldEnvelope())).toBe(false);
  });

  it("an envelope whose old name cannot be removed: the new name is taken away again and the open is one without those comments", async () => {
    await storeOldPair();
    const frozen = await freeze(oldEnvelope());
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = failUnlinksOf(oldEnvelope());
    const unlinked = vi.mocked(fs.unlink);

    const opened = await openFromDisk(fx.aliasPath);
    expect(failing.calls()).toBe(1);
    // The undo: the new name was removed before anything loaded it.
    expect(unlinked.mock.calls.map((c) => c[0])).toContain(newEnvelope());
    expect(hasComment(opened.documentId)).toBe(false);
    await quiesceForTesting();
    failing.restore();
    await expectUntouched(oldEnvelope(), frozen);
    expect((await fs.stat(oldEnvelope())).nlink).toBe(1);
    // The other kind is not held back.
    expect(opened.kind).toBe("restored");
    expect(liveText(opened.documentId)).toContain("from the short spelling");
    expect(await sessionFiles()).toEqual([`${sessionKey(fx.longPath)}.json`]);
  });

  // --- 7: M4, the records of a live document --------------------------------

  // An expansion failure (R4.5) registers the document under the short string
  // itself, so that string's key holds a LIVE document's own records. A later
  // open whose expansion succeeds computes the same string as its "old key".
  it("leaves the session and envelope of a live document registered under the short string where they are (M4)", async () => {
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
    const frozenSession = await freeze(sessionFile(shortString));
    const frozenEnvelope = await freeze(envelopePath(docHash(shortString)));

    // The expansion works again.
    uninstallAliasExpansion();
    installAliasExpansion();
    const link = vi.spyOn(fs, "link");
    const second = await openFromDisk(fx.aliasPath);
    await quiesceForTesting();

    expect(second.documentId).toBe(docIdFromPath(fx.longPath));
    expect(second.documentId).not.toBe(live.documentId);
    // The normal-open branch, where the move would have run.
    expect(second.kind).toBe("fresh");
    expect(link).not.toHaveBeenCalled();
    expect(liveAnnotations(second.documentId).has("ann_mine")).toBe(false);
    expect(liveAnnotations(live.documentId).has("ann_mine")).toBe(true);
    await expectUntouched(sessionFile(shortString), frozenSession);
    await expectUntouched(envelopePath(docHash(shortString)), frozenEnvelope);
  });

  // --- 8: the three shapes of the blocking finding --------------------------

  // The removed design read the old envelope, merged it into the document and
  // deleted it once the merge was durable; each of these left the session
  // moved and the envelope orphaned. A move reads nothing and needs no store.
  it("with the annotation store not wired for the document, both files still end under the new key", async () => {
    await storeOldPair();
    vi.spyOn(console, "error").mockImplementation(() => {});
    wiringShouldFail = true;
    const opened = await openFromDisk(fx.aliasPath);
    wiringShouldFail = false;
    // The obstacle was real.
    expect(getFileSyncContext(opened.documentId)).toBeUndefined();
    expect(hasComment(opened.documentId)).toBe(false);

    expect(opened.kind).toBe("restored");
    expect(await sessionFiles()).toEqual([`${sessionKey(fx.longPath)}.json`]);
    expect(await exists(oldEnvelope())).toBe(false);
    expect((await readEnvelope(fx.longPath)).annotations.map((a) => a.id)).toEqual(["ann_comment"]);

    // Paired under one key: any later open of the file finds both.
    await simulateRestart();
    const again = await openFromDisk(fx.longPath);
    expect(again.kind).toBe("restored");
    expect(hasComment(again.documentId)).toBe(true);
  });

  it("with the old envelope unreadable (EBUSY), both files still end under the new key: the move does not read it", async () => {
    await storeOldPair();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const file = oldEnvelope();
    const restoreReads = failReadsOf(file, "EBUSY");
    // The obstacle is real: a read of that file fails.
    await expect(fs.readFile(file, "utf-8")).rejects.toMatchObject({ code: "EBUSY" });
    const reads = vi.mocked(fs.readFile);
    reads.mockClear();

    const opened = await openFromDisk(fx.aliasPath);
    expect(reads.mock.calls.filter((c) => c[0] === file)).toEqual([]);
    restoreReads();

    expect(opened.kind).toBe("restored");
    expect(hasComment(opened.documentId)).toBe(true);
    expect(await sessionFiles()).toEqual([`${sessionKey(fx.longPath)}.json`]);
    expect(await exists(file)).toBe(false);
    await quiesceForTesting();
    expect((await readEnvelope(fx.longPath)).annotations.map((a) => a.id)).toEqual(["ann_comment"]);
  });

  it("with the store read-only (another instance holds the lock) nothing moves; once it is writable the next short-spelled open moves both", async () => {
    const lockPath = path.join(getAnnotationsDir(), "store.lock");
    await storeOldPair();
    const frozenSession = await freeze(oldSession());
    const frozenEnvelope = await freeze(oldEnvelope());
    vi.spyOn(console, "error").mockImplementation(() => {});
    const link = vi.spyOn(fs, "link");

    await fs.mkdir(getAnnotationsDir(), { recursive: true });
    await fs.writeFile(lockPath, String(process.pid));
    expect(await acquireStoreLock()).toBe("readonly");
    try {
      const opened = await openFromDisk(fx.aliasPath);
      // An ordinary open of the long spelling, which has no records.
      expect(opened.kind).toBe("fresh");
      expect(opened.filePath).toBe(fx.longPath);
      expect(liveText(opened.documentId)).not.toContain("from the short spelling");
      expect(hasComment(opened.documentId)).toBe(false);
      // Neither kind moved: the two are still a pair under the old key.
      expect(link).not.toHaveBeenCalled();
      expect(await sessionFiles()).toEqual([`${sessionKey(fx.aliasPath)}.json`]);
      expect(await exists(newEnvelope())).toBe(false);
      await expectUntouched(oldSession(), frozenSession);
      await expectUntouched(oldEnvelope(), frozenEnvelope);

      // The other instance exits; this one starts again and holds the lock.
      await closeDocumentById(opened.documentId);
      await simulateRestart();
      await fs.rm(lockPath, { force: true });
      expect(await acquireStoreLock()).toBe("locked");
      await expectUntouched(oldSession(), frozenSession);
      await expectUntouched(oldEnvelope(), frozenEnvelope);

      const again = await openFromDisk(fx.aliasPath);
      expect(again.kind).toBe("restored");
      expect(liveText(again.documentId)).toContain("from the short spelling");
      expect(hasComment(again.documentId)).toBe(true);
      expect(await sessionFiles()).toEqual([`${sessionKey(fx.longPath)}.json`]);
      expect(await exists(oldEnvelope())).toBe(false);
      expect(await exists(newEnvelope())).toBe(true);
    } finally {
      await releaseStoreLock();
    }
  });

  // --- 9: an old-key session that cannot be decoded -------------------------

  it.each([
    [
      "a ydocState that is not a document",
      (stored: Record<string, unknown>) => {
        stored.ydocState = Buffer.from("this is not a Yjs update").toString("base64");
      },
    ],
    [
      "no ydocState at all",
      (stored: Record<string, unknown>) => {
        delete stored.ydocState;
      },
    ],
  ] as const)(
    "an old-key session with %s is moved, then quarantined under the new key, and the file opens from disk",
    async (_label, corrupt) => {
      await storeOldPair();
      await editStoredSession(fx.aliasPath, corrupt);
      vi.spyOn(console, "error").mockImplementation(() => {});

      const opened = await openFromDisk(fx.aliasPath);
      // The open is the ordinary one for a corrupt session: the file's text.
      expect(opened.kind).toBe("fresh");
      expect(liveText(opened.documentId)).toBe(extractText(await docFromMarkdown(DISK)));
      expect(isDirty(opened.documentId)).toBe(false);
      // Moved first: the quarantine carries the NEW key's name, and nothing is
      // left under the old one to be replayed at the next start.
      const names = await fs.readdir(SESSION_DIR);
      expect(names).toHaveLength(1);
      expect(names[0].startsWith(`${sessionKey(fx.longPath)}.json.corrupt.`)).toBe(true);
      expect(await sessionFiles()).toEqual([]);
      // The envelope is not affected by the session's state.
      expect(hasComment(opened.documentId)).toBe(true);
      expect(await exists(oldEnvelope())).toBe(false);

      await closeDocumentById(opened.documentId);
      await simulateRestart();
      expect(await listSessionFilePaths()).toEqual([]);
      expect(await restoreOpenDocuments(null)).toBe(0);
    },
  );

  // --- 10: a long-spelled open ----------------------------------------------

  it("a long-spelled open never looks at records under the old key", async () => {
    await storeOldPair();
    const frozenSession = await freeze(oldSession());
    const frozenEnvelope = await freeze(oldEnvelope());
    const link = vi.spyOn(fs, "link");
    const access = vi.spyOn(fs, "access");

    const opened = await openFromDisk(fx.longPath);
    await quiesceForTesting();
    expect(opened.kind).toBe("fresh");
    expect(liveAnnotations(opened.documentId).size).toBe(0);
    expect(link).not.toHaveBeenCalled();
    const probed = access.mock.calls.map((c) => String(c[0]));
    expect(probed).not.toContain(oldSession());
    expect(probed).not.toContain(oldEnvelope());
    await expectUntouched(oldSession(), frozenSession);
    await expectUntouched(oldEnvelope(), frozenEnvelope);
    // Nothing was put under the new key on the old records' behalf.
    expect(await sessionFiles()).toEqual([`${sessionKey(fx.aliasPath)}.json`]);
    expect(await exists(newEnvelope())).toBe(false);
  });

  it("an already-open document moves nothing when it is opened again by the short spelling", async () => {
    const first = await openFromDisk(fx.longPath);
    await storeOldPair();
    const frozenSession = await freeze(oldSession());
    const frozenEnvelope = await freeze(oldEnvelope());
    const link = vi.spyOn(fs, "link");

    const again = await openFromDisk(fx.aliasPath);
    await quiesceForTesting();
    expect(again.kind).toBe("already-open");
    expect(again.documentId).toBe(first.documentId);
    expect(link).not.toHaveBeenCalled();
    expect(hasComment(first.documentId)).toBe(false);
    await expectUntouched(oldSession(), frozenSession);
    await expectUntouched(oldEnvelope(), frozenEnvelope);
  });

  // --- 11: M5 ---------------------------------------------------------------

  it("looks up old records by key only: listing, dedup and cleanup make no filesystem call on a stored path (M5)", async () => {
    await storeFullRecords(fx.aliasPath);
    await storeSession(fx.longPath, DISK, { dirty: false });
    await storeEnvelope(fx.longPath, { annotations: [comment] });
    // The pre-#1750 name of the long-spelled session as well, so the listing's
    // dedup has two files for one stored path to choose between.
    await fs.copyFile(
      newSession(),
      path.join(SESSION_DIR, `${legacySessionKey(fx.longPath)}.json`),
    );
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
          "link",
          "writeFile",
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
    await cleanupOrphanedAnnotationFiles();
    // Deduplicated: one entry per stored path, from three session files.
    expect(listed.map((s) => s.filePath).sort()).toEqual([...stored].sort());
    // The session and annotation files themselves were read, so the spies
    // were watching...
    expect(touched().some((p) => p.startsWith(path.resolve(SESSION_DIR)))).toBe(true);
    expect(touched().some((p) => p.startsWith(path.resolve(getAnnotationsDir())))).toBe(true);
    // ...and nothing was asked about a path a session names.
    expect(touched().filter(onStoredPath)).toEqual([]);
    expect(spies.realpathNative).not.toHaveBeenCalled();
    expect(spies.lstat).not.toHaveBeenCalled();
    // No record moved, and none was removed: these are not opens.
    expect(await exists(oldSession())).toBe(true);
    expect(await exists(oldEnvelope())).toBe(true);

    // Control: a call on a stored path is what this would have caught.
    await fs.stat(fx.aliasPath);
    fsSync.existsSync(fx.longPath);
    expect(touched().filter(onStoredPath).sort()).toEqual([...stored].sort());
  });

  // --- 12: the read-only flag of a replayed restore entry -------------------

  describe("the read-only flag on a startup-restore replay", () => {
    const setReadOnly = (stored: Record<string, unknown>) => {
      stored.readOnly = true;
    };
    function expectReadOnly(id: string, expected: boolean): void {
      expect(getOpenDocs().get(id)?.readOnly).toBe(expected);
      expect(
        getOrCreateDocument(id).getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_READ_ONLY) === true,
      ).toBe(expected);
    }
    const entryFor = async (filePath: string) => {
      const entry = (await listSessionFilePaths()).find((s) => s.filePath === filePath);
      if (!entry) throw new Error(`fixture: no listed session names ${filePath}`);
      return entry;
    };

    it("a short entry stored read-only that moves in opens the document read-only", async () => {
      await storeSession(fx.aliasPath, OLD_TEXT);
      await editStoredSession(fx.aliasPath, setReadOnly);
      expect(await restoreOpenDocuments(null)).toBe(1);
      const id = docIdFromPath(fx.longPath);
      expect(liveText(id)).toContain("from the short spelling");
      expect(await sessionFiles()).toEqual([`${sessionKey(fx.longPath)}.json`]);
      expectReadOnly(id, true);
    });

    it("control: the same entry stored writable opens the document writable", async () => {
      await storeSession(fx.aliasPath, OLD_TEXT);
      expect(await restoreOpenDocuments(null)).toBe(1);
      expectReadOnly(docIdFromPath(fx.longPath), false);
    });

    it.each([
      ["the short entry first", () => [fx.aliasPath, fx.longPath]],
      ["the long entry first", () => [fx.longPath, fx.aliasPath]],
    ] as const)(
      "both keys hold a session, the short one stored read-only and the long one writable: the document is writable (%s)",
      async (_label, order) => {
        await storeSession(fx.aliasPath, OLD_TEXT);
        await editStoredSession(fx.aliasPath, setReadOnly);
        await storeSession(fx.longPath, NEW_TEXT);
        const entries = [await entryFor(order()[0]), await entryFor(order()[1])];
        expect(entries.map((e) => e.readOnly)).toEqual(order().map((p) => p === fx.aliasPath));

        const first = await openFromRestore(entries[0]);
        expect(first.readOnly).toBe(false);
        const second = await openFromRestore(entries[1]);
        expect(second.kind).toBe("already-open");
        expect(second.readOnly).toBe(false);
        expect(getOpenDocs().size).toBe(1);
        expect(liveText(first.documentId)).toContain("from the long spelling");
        expectReadOnly(first.documentId, false);
        // The short-spelled session did not become the document, and is kept.
        expect(await exists(oldSession())).toBe(true);
      },
    );

    it("both keys hold a session, the long one stored read-only: replaying only the writable short entry opens the document read-only", async () => {
      await storeSession(fx.aliasPath, OLD_TEXT);
      await storeSession(fx.longPath, NEW_TEXT);
      await editStoredSession(fx.longPath, setReadOnly);
      const entry = await entryFor(fx.aliasPath);
      expect(entry.readOnly).toBe(false);

      const opened = await openFromRestore(entry);
      expect(liveText(opened.documentId)).toContain("from the long spelling");
      expect(opened.readOnly).toBe(true);
      expectReadOnly(opened.documentId, true);
    });

    it("a session already at the new key that still names the short path (a move, then a crash) keeps its stored read-only flag", async () => {
      await storeSession(fx.longPath, OLD_TEXT);
      await editStoredSession(fx.longPath, (stored) => {
        stored.filePath = fx.aliasPath;
        stored.readOnly = true;
      });
      expect(await sessionFiles()).toEqual([`${sessionKey(fx.longPath)}.json`]);
      expect((await listSessionFilePaths()).map((s) => [s.filePath, s.readOnly])).toEqual([
        [fx.aliasPath, true],
      ]);

      expect(await restoreOpenDocuments(null)).toBe(1);
      const id = docIdFromPath(fx.longPath);
      expect(liveText(id)).toContain("from the short spelling");
      expectReadOnly(id, true);
    });

    it("the same crash shape stored writable, replayed by an entry that says read-only, opens writable: the session's own flag decides", async () => {
      await storeSession(fx.longPath, OLD_TEXT);
      const opened = await openFromRestore({ filePath: fx.aliasPath, readOnly: true });
      expect(opened.kind).toBe("restored");
      expect(opened.readOnly).toBe(false);
      expectReadOnly(opened.documentId, false);
    });
  });

  // --- 13: the moved session names the long path ----------------------------

  it("a moved session names the long path, so the listed entry can be deleted", async () => {
    await storeSession(fx.aliasPath, OLD_TEXT);
    expect(JSON.parse(await fs.readFile(oldSession(), "utf-8")).filePath).toBe(fx.aliasPath);

    await openFromDisk(fx.aliasPath);
    // The move wrote it: no session save has run for this document yet.
    const stored = JSON.parse(await fs.readFile(newSession(), "utf-8"));
    expect(stored.filePath).toBe(fx.longPath);
    expect(stored.dirty).toBe(true);

    await simulateRestart();
    const listed = await listSessionFilePaths();
    expect(listed.map((s) => s.filePath)).toEqual([fx.longPath]);
    expect(listed[0].holdsUnsavedWork).toBe(true);
    // "Clear all" / Recent sessions delete by the listed path.
    await deleteSession(listed[0].filePath);
    expect(await sessionFiles()).toEqual([]);
  });

  // --- 14: what the per-id open chain is for --------------------------------

  it.each([
    ["the long spelling first", () => [fx.longPath, fx.aliasPath]],
    ["the short spelling first", () => [fx.aliasPath, fx.longPath]],
  ] as const)(
    "concurrent opens of one file by both spellings (%s) give one document, and its old records are whole",
    async (_label, order) => {
      await storeOldPair();
      const frozenSession = await freeze(oldSession());
      const frozenEnvelope = await freeze(oldEnvelope());

      const results = await Promise.all(order().map((p) => openFromDisk(p)));
      await quiesceForTesting();

      const id = docIdFromPath(fx.longPath);
      expect(results.map((r) => r.documentId)).toEqual([id, id]);
      expect([...getOpenDocs().keys()]).toEqual([id]);
      // Exactly one of the two opened it; the other found it open.
      expect(results.map((r) => r.kind).filter((k) => k === "already-open")).toHaveLength(1);

      const text = liveText(id);
      const fromDisk = extractText(await docFromMarkdown(DISK));
      const fromSession = extractText(await docFromMarkdown(OLD_TEXT));
      // One body, not two loads into one document.
      expect([fromDisk, fromSession]).toContain(text);

      if (await exists(oldSession())) {
        // The long-spelled open went first: nothing moved, nothing lost.
        expect(text).toBe(fromDisk);
        expect(hasComment(id)).toBe(false);
        await expectUntouched(oldSession(), frozenSession);
        await expectUntouched(oldEnvelope(), frozenEnvelope);
        expect(await exists(newEnvelope())).toBe(false);
      } else {
        // The short-spelled open went first: the records are the document's.
        expect(text).toBe(fromSession);
        expect(hasComment(id)).toBe(true);
        expect(await exists(oldEnvelope())).toBe(false);
        expect(await sessionFiles()).toEqual([`${sessionKey(fx.longPath)}.json`]);
        expect((await readEnvelope(fx.longPath)).annotations.map((a) => a.id)).toEqual([
          "ann_comment",
        ]);
      }
    },
  );

  // --- unchanged from the brief ---------------------------------------------

  it("does not read or move backups stored under the old key", async () => {
    const oldDir = path.join(docBackupsRoot(resolveAppDataDir()), docHash(fx.aliasPath));
    await fs.mkdir(oldDir, { recursive: true });
    const kept = path.join(oldDir, "old-20260101-000000-abcdef12.md");
    await fs.writeFile(kept, "an earlier backup\n", "utf-8");
    await storeFullRecords(fx.aliasPath);
    await openFromDisk(fx.aliasPath);
    expect(await fs.readFile(kept, "utf-8")).toBe("an earlier backup\n");
    expect(await fs.readdir(oldDir)).toEqual(["old-20260101-000000-abcdef12.md"]);
    // The move itself takes no backup of anything.
    expect(await backupTexts()).toEqual([]);
  });

  it("leaves existing long-spelled records byte-identical when there is nothing under the old key", async () => {
    await storeSession(fx.longPath, DISK, { dirty: false });
    await storeEnvelope(fx.longPath, { annotations: [comment] });
    const before = {
      session: await fs.readFile(newSession()),
      envelope: await fs.readFile(newEnvelope()),
    };
    await openFromDisk(fx.aliasPath);
    await quiesceForTesting();
    expect((await fs.readFile(newSession())).equals(before.session)).toBe(true);
    expect((await fs.readFile(newEnvelope())).equals(before.envelope)).toBe(true);
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
