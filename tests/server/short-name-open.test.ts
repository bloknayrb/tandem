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

import { docHash } from "../../src/server/annotations/doc-hash.js";
import { parseAnnotationDoc } from "../../src/server/annotations/schema.js";
import {
  closeStore,
  envelopePath,
  quiesceForTesting,
  resetForTesting as storeReset,
} from "../../src/server/annotations/store.js";
import { getTombstones, resetForTesting as syncReset } from "../../src/server/annotations/sync.js";
import { openFromDisk } from "../../src/server/documents/open.js";
import { attachObservers, detachObservers } from "../../src/server/events/queue.js";
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
import { refreshRange } from "../../src/server/positions.js";
import {
  cleanupSessions,
  listSessionFilePaths,
  saveSession,
  sessionKey,
  stopAutoSave,
} from "../../src/server/session/manager";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withBrowser } from "../../src/shared/origins.js";
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

/** A saved session under `keyPath`'s key, holding `markdown` and optional records. */
async function storeSession(
  keyPath: string,
  markdown: string,
  opts: {
    dirty?: boolean;
    lastAccessed?: number;
    conflict?: ExternalConflictState;
    annotations?: Array<Record<string, unknown>>;
  } = {},
): Promise<void> {
  const doc = await docFromMarkdown(markdown);
  const map = doc.getMap(Y_MAP_ANNOTATIONS);
  for (const a of opts.annotations ?? []) map.set(a.id as string, a);
  await saveSession(keyPath, "md", doc, {
    dirty: opts.dirty ?? true,
    ...(opts.lastAccessed !== undefined ? { lastAccessed: opts.lastAccessed } : {}),
    ...(opts.conflict ? { conflict: opts.conflict } : {}),
  });
  doc.destroy();
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
    const opened = await openFromDisk(fx.aliasPath);
    const doc = getOrCreateDocument(opened.documentId);
    withBrowser(doc, () =>
      doc.getMap(Y_MAP_ANNOTATIONS).set("ann_x", annRecord({ id: "ann_x", author: "user" })),
    );
    await saveCurrentSession();
    await closeStore(docHash(fx.longPath));
    expect(await exists(sessionFile(fx.longPath))).toBe(true);
    expect(await exists(sessionFile(fx.aliasPath))).toBe(false);
    expect(await exists(envelopePath(docHash(fx.longPath)))).toBe(true);
    expect(await exists(envelopePath(docHash(fx.aliasPath)))).toBe(false);
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
          annRecord({ id: "old_only", author: "user", rev: 1 }),
          note,
          annRecord({ id: "killed_by_new", author: "user", rev: 1 }),
        ],
        tombstones: [{ id: "old_stone", rev: 4, deletedAt: T0 }],
      });
      await storeEnvelope(fx.longPath, {
        annotations: [
          annRecord({ id: "shared", author: "user", content: "new copy", rev: 2 }),
          annRecord({ id: "new_only", author: "user", rev: 1 }),
          annRecord({ id: "old_stone", author: "user", rev: 1 }),
        ],
        tombstones: [{ id: "killed_by_new", rev: 3, deletedAt: T0 }],
      });

      const opened = await openFromDisk(fx.aliasPath);
      const anns = liveAnnotations(opened.documentId);
      expect([...anns.keys()].sort()).toEqual(["ann_note", "new_only", "old_only", "shared"]);
      expect(anns.get("shared")?.content).toBe("old copy");
      expect(anns.get("ann_note")?.type).toBe("note");

      const envelope = await readEnvelope(fx.longPath);
      expect(envelope.annotations.map((a) => a.id).sort()).toEqual([
        "ann_note",
        "new_only",
        "old_only",
        "shared",
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
      expect(outcome(opened.documentId, "ann_beta")).not.toBe("degraded");
    });

    it("uses the file on disk as the witness when the other side has an envelope and no session", async () => {
      // The long document's envelope was made on the disk text; the short
      // session holds different, unsaved text and becomes the document.
      await storeEnvelope(fx.longPath, { annotations: [annRecord(onBeta as never)] });
      await storeSession(fx.aliasPath, "ZZZZ alpha beta gamma\n", { lastAccessed: T0 });
      const opened = await openFromDisk(fx.aliasPath);
      expect(liveText(opened.documentId)).toContain("ZZZZ");
      expect(liveAnnotations(opened.documentId).get("ann_beta")?.textSnapshot).toBe("beta");
      expect(outcome(opened.documentId, "ann_beta")).toBe("degraded");
    });

    it("stamps nothing when the texts are the same", async () => {
      await storeEnvelope(fx.aliasPath, { annotations: [annRecord(onBeta as never)] });
      const opened = await openFromDisk(fx.aliasPath);
      expect(liveAnnotations(opened.documentId).get("ann_beta")?.textSnapshot).toBeUndefined();
    });
  });

  it("a failure inside the carry-over never fails the open, and leaves the old records in place", async () => {
    await storeOldRecords();
    const file = envelopePath(docHash(fx.aliasPath));
    const realReadFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (p === file) return Promise.reject(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));
      return (realReadFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const opened = await openFromDisk(fx.aliasPath);
    expect(opened.kind).toBe("restored");
    vi.mocked(fs.readFile).mockRestore();
    expect(await exists(file)).toBe(true);
    expect(await exists(sessionFile(fx.aliasPath))).toBe(true);

    // The next open by that spelling finishes the job.
    await closeDocumentById(opened.documentId);
    await simulateRestart();
    const again = await openFromDisk(fx.aliasPath);
    expect(liveAnnotations(again.documentId).has("ann_comment")).toBe(true);
    expect(await exists(file)).toBe(false);
    expect(await exists(sessionFile(fx.aliasPath))).toBe(false);
  });

  it("looks up old records by key only: listing and cleanup make no filesystem call on a stored path (R2.6)", async () => {
    await storeOldRecords();
    await storeSession(fx.longPath, DISK, { dirty: false });
    const stored = new Set([fx.aliasPath, fx.longPath]);
    const spied = [
      vi.spyOn(fs, "stat"),
      vi.spyOn(fs, "lstat"),
      vi.spyOn(fs, "realpath"),
      vi.spyOn(fs, "access"),
      vi.spyOn(fsSync, "realpathSync"),
      vi.spyOn(fsSync, "statSync"),
    ];
    const listed = await listSessionFilePaths();
    await cleanupSessions();
    expect(listed.map((s) => s.filePath).sort()).toEqual([...stored].sort());
    for (const spy of spied) {
      for (const call of spy.mock.calls) expect(stored.has(String(call[0]))).toBe(false);
    }
    expect(spies.realpathNative).not.toHaveBeenCalled();
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
