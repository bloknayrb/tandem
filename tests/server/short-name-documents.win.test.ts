/**
 * #2400 on a real Windows volume: a file named by an 8.3 short path is the same
 * document as by its long path.
 *
 * Everything here needs a volume that CREATES short names, so it is gated to
 * `win32` and each test skips (visibly, as a skip) when the shell reports no
 * alias for the fixture. Nothing depends on the host's `TEMP` spelling: both
 * spellings are built explicitly from a fixture folder, and the alias is asked
 * of the shell (`for %I in (...) do @echo %~sI`), since Node has no API for it.
 *
 * This file is kept on its own so its ran/skipped counts can be read off a job
 * log. It is the only place a short FOLDER component is exercised end to end;
 * the host-neutral twin (`short-name-open.test.ts`) aliases a file name through
 * a hard link and injects the platform.
 */

import { execSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("../../src/server/platform"), async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  return {
    ...original,
    SESSION_DIR: pathMod.join(osMod.tmpdir(), `tandem-test-shortwin-${cryptoMod.randomUUID()}`),
  };
});

vi.mock(import("../../src/server/file-watcher"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
}));

import { docHash } from "../../src/server/annotations/doc-hash.js";
import {
  closeStore,
  envelopePath,
  quiesceForTesting,
  resetForTesting as storeReset,
} from "../../src/server/annotations/store.js";
import { resetForTesting as syncReset } from "../../src/server/annotations/sync.js";
import { openFromDisk, openScratchpad } from "../../src/server/documents/open.js";
import { docBackupsRoot } from "../../src/server/file-io/doc-backup.js";
import { docIdFromPath, extractText } from "../../src/server/mcp/document-model.js";
import {
  closeDocumentById,
  getOpenDocs,
  renameDocument,
  saveCurrentSession,
  saveDocumentAsToDisk,
} from "../../src/server/mcp/document-service.js";
import { resolveAppDataDir, SESSION_DIR } from "../../src/server/platform";
import { saveSession, sessionKey, stopAutoSave } from "../../src/server/session/manager";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withBrowser } from "../../src/shared/origins.js";
import {
  annRecord,
  makeAnnotationDoc,
  writeEnvelopeToDisk,
} from "../helpers/annotation-fixtures.js";
import { useTmpAnnotationsEnvWithFlag } from "../helpers/annotation-store-env.js";
import {
  docFromMarkdown,
  forgetOnRestart,
  simulateRestart,
} from "../helpers/short-name-fixture.js";

const WIN = process.platform === "win32";
const BS = String.fromCharCode(92);
/** Every shell call is bounded: a hung `cmd` or `subst` fails the test instead of the job. */
const SHELL_TIMEOUT_MS = 15_000;
/**
 * Drive letters this file may `subst`. `launcher/resolver-flavour.test.ts` runs
 * in another worker at the same time and has its own, disjoint set, so the two
 * cannot pick the same free letter.
 */
const SUBST_LETTERS = ["O", "N", "M", "L"];
/** Windows can hold a just-closed file for a moment; retry the temp-dir deletes. */
const RM_TEMP = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

const LONG_DIR = "a folder with a long name";
const LONG_FILE = "a long file name.md";

useTmpAnnotationsEnvWithFlag("tandem-shortwin-");

let root: string;
let longDir: string;
let longPath: string;

/** The 8.3 alias of an existing path (every component short), or null when the volume makes none. */
function shortAliasOf(p: string): string | null {
  try {
    const out = execSync(`cmd /d /c for %I in ("${p}") do @echo %~sI`, {
      encoding: "utf-8",
      timeout: SHELL_TIMEOUT_MS,
    });
    const alias = out.trim().split(/\r?\n/).pop()?.trim() ?? "";
    return alias.includes("~") ? alias : null;
  } catch {
    return null;
  }
}

/** The alias of the LAST component only, joined onto the long parent. */
function shortLeafOf(p: string): string | null {
  const alias = shortAliasOf(p);
  if (alias === null) return null;
  const leaf = path.win32.basename(alias);
  return leaf.includes("~") ? path.join(path.dirname(p), leaf) : null;
}

const sessionFile = (p: string) => path.join(SESSION_DIR, `${sessionKey(p)}.json`);
const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );
const annotationIds = (id: string) => [...getOrCreateDocument(id).getMap(Y_MAP_ANNOTATIONS).keys()];

beforeAll(async () => {
  await fs.mkdir(SESSION_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(SESSION_DIR, RM_TEMP);
});

beforeEach(async () => {
  // The NATIVE realpath, so the fixture's own prefix is long even on a host
  // whose TEMP is an 8.3 short name: the only short components in any path
  // below are the ones each test builds.
  root = fsSync.realpathSync.native(
    await fs.mkdtemp(path.join(os.tmpdir(), "tandem-shortwin-fx-")),
  );
  longDir = path.join(root, LONG_DIR);
  longPath = path.join(longDir, LONG_FILE);
  await fs.mkdir(longDir, { recursive: true });
  await fs.writeFile(longPath, "alpha beta gamma\n", "utf-8");
  // A closed document's Y.Doc must not outlive a simulated restart.
  forgetOnRestart(longPath);
});

afterEach(async () => {
  await simulateRestart();
  stopAutoSave();
  await quiesceForTesting();
  storeReset();
  syncReset();
  for (const f of await fs.readdir(SESSION_DIR).catch(() => [])) {
    await fs.rm(path.join(SESSION_DIR, f), { force: true });
  }
  await fs.rm(root, RM_TEMP);
});

describe.runIf(WIN)(
  "a file named by an 8.3 short path is the same document as by its long path",
  () => {
    /** [label, the short spelling to open] for folder-short, file-short and both. */
    function spellings(): Array<[string, string]> | null {
      const dirAlias = shortLeafOf(longDir);
      const fileAlias = shortLeafOf(longPath);
      if (dirAlias === null || fileAlias === null) return null;
      return [
        ["short folder", path.join(dirAlias, LONG_FILE)],
        ["short file name", fileAlias],
        ["short folder and file name", path.join(dirAlias, path.basename(fileAlias))],
      ];
    }

    it("the volume's aliases resolve to the fixture (precondition)", (ctx) => {
      const all = spellings();
      if (all === null) return ctx.skip();
      for (const [, short] of all) {
        expect(short.toLowerCase()).not.toBe(longPath.toLowerCase());
        expect(fsSync.realpathSync.native(short).toLowerCase()).toBe(
          fsSync.realpathSync.native(longPath).toLowerCase(),
        );
        // The JS flavour keeps the alias: the defect's precondition.
        expect(fsSync.realpathSync(short).toLowerCase()).toBe(short.toLowerCase());
      }
    });

    it("long then short: one document, already open, stored and shown under the long name (R1.1, R1.2)", async (ctx) => {
      const all = spellings();
      if (all === null) return ctx.skip();
      const first = await openFromDisk(longPath);
      for (const [, short] of all) {
        const again = await openFromDisk(short);
        expect(again.kind).toBe("already-open");
        expect(again.documentId).toBe(first.documentId);
      }
      expect(getOpenDocs().size).toBe(1);
      expect(getOpenDocs().get(first.documentId)?.filePath).toBe(longPath);
    });

    it("short then long, for each short spelling (R1.1, R1.2)", async (ctx) => {
      const all = spellings();
      if (all === null) return ctx.skip();
      for (const [, short] of all) {
        const first = await openFromDisk(short);
        expect(first.kind).toBe("fresh");
        expect(first.documentId).toBe(docIdFromPath(longPath));
        expect(first.filePath).toBe(longPath);
        expect(first.fileName).toBe(LONG_FILE);
        const again = await openFromDisk(longPath);
        expect(again.kind).toBe("already-open");
        expect(getOpenDocs().size).toBe(1);
        await closeDocumentById(first.documentId);
        await simulateRestart();
      }
    });

    it("a comment made through one spelling is found through the other after a restart, with one set of store keys", async (ctx) => {
      const all = spellings();
      if (all === null) return ctx.skip();
      const [, short] = all[2];
      const opened = await openFromDisk(short);
      const doc = getOrCreateDocument(opened.documentId);
      withBrowser(doc, () =>
        doc.getMap(Y_MAP_ANNOTATIONS).set("ann_one", annRecord({ id: "ann_one", author: "user" })),
      );
      await saveCurrentSession();
      await closeStore(docHash(longPath));
      expect(await exists(sessionFile(longPath))).toBe(true);
      expect(await exists(sessionFile(short))).toBe(false);
      expect(await exists(envelopePath(docHash(longPath)))).toBe(true);
      expect(await exists(envelopePath(docHash(short)))).toBe(false);
      // One backup folder: the short spelling's key names no directory.
      const backups = docBackupsRoot(resolveAppDataDir());
      expect(await exists(path.join(backups, docHash(short)))).toBe(false);

      await closeDocumentById(opened.documentId);
      await simulateRestart();
      const again = await openFromDisk(longPath);
      expect(annotationIds(again.documentId)).toEqual(["ann_one"]);
    });

    it("a real long name that contains ~1 opens under its own name, id and keys (R1.4)", async () => {
      const real = path.join(longDir, "notes~1.md");
      await fs.writeFile(real, "real\n", "utf-8");
      const opened = await openFromDisk(real);
      expect(opened.filePath).toBe(fsSync.realpathSync(real));
      expect(opened.documentId).toBe(docIdFromPath(fsSync.realpathSync(real)));
    });

    it("a path with no short component is byte-identical to the JS realpath (R1.5)", async () => {
      const opened = await openFromDisk(longPath);
      expect(opened.filePath).toBe(fsSync.realpathSync(longPath));
      expect(opened.documentId).toBe(docIdFromPath(fsSync.realpathSync(longPath)));
    });

    it("a subst drive keeps its drive letter; only the short components change (R1.3)", async (ctx) => {
      const dirAlias = shortLeafOf(longDir);
      const letter = SUBST_LETTERS.find((l) => !fsSync.existsSync(`${l}:${BS}`));
      if (dirAlias === null || !letter) return ctx.skip();
      try {
        execSync(`subst ${letter}: "${root}"`, { timeout: SHELL_TIMEOUT_MS });
      } catch {
        return ctx.skip();
      }
      try {
        const onDriveLong = `${letter}:${BS}${LONG_DIR}${BS}${LONG_FILE}`;
        const onDriveShort = `${letter}:${BS}${path.basename(dirAlias)}${BS}${LONG_FILE}`;
        const viaShort = await openFromDisk(onDriveShort);
        expect(viaShort.filePath).toBe(onDriveLong);
        const viaLong = await openFromDisk(onDriveLong);
        expect(viaLong.kind).toBe("already-open");
        expect(viaLong.documentId).toBe(viaShort.documentId);
        await closeDocumentById(viaShort.documentId);
      } finally {
        // The mapping goes first, in its own `try`: a `simulateRestart()` that
        // throws must not leave the drive letter mapped for the rest of the run.
        try {
          execSync(`subst ${letter}: /d`, { timeout: SHELL_TIMEOUT_MS });
        } finally {
          await simulateRestart();
        }
      }
    });

    it("a short component that is a junction, and one beneath a junction, both reach the one document (R4.6)", async (ctx) => {
      const junction = path.join(root, "a junction with a long name");
      await fs.symlink(longDir, junction, "junction");
      const junctionAlias = shortLeafOf(junction);
      const dirAlias = shortLeafOf(longDir);
      if (junctionAlias === null || dirAlias === null) return ctx.skip();
      const first = await openFromDisk(longPath);
      // The alias of the junction itself: the JS realpath follows the link to the
      // long target before any expansion runs.
      const viaJunctionAlias = await openFromDisk(path.join(junctionAlias, LONG_FILE));
      expect(viaJunctionAlias.kind).toBe("already-open");
      expect(viaJunctionAlias.documentId).toBe(first.documentId);
      // A short FILE name beneath the junction.
      const fileAlias = shortLeafOf(longPath);
      if (fileAlias === null) return ctx.skip();
      const beneath = await openFromDisk(path.join(junction, path.basename(fileAlias)));
      expect(beneath.kind).toBe("already-open");
      expect(beneath.documentId).toBe(first.documentId);
      expect(getOpenDocs().size).toBe(1);
    });

    it("save-as to a short-spelled target, then an open by the long spelling, is one document (R1.6)", async (ctx) => {
      const dirAlias = shortLeafOf(longDir);
      if (dirAlias === null) return ctx.skip();
      const pad = await openScratchpad("saved from a scratchpad\n");
      // The leaf does not exist yet: it is kept as typed; the folder is expanded.
      const typed = path.join(dirAlias, "brand new file.md");
      const saved = await saveDocumentAsToDisk(pad.documentId, typed, "md");
      expect(saved.status).toBe("saved");
      const expected = path.join(longDir, "brand new file.md");
      expect(getOpenDocs().get(pad.documentId)?.filePath).toBe(expected);
      expect(await exists(expected)).toBe(true);
      const viaLong = await openFromDisk(expected);
      expect(viaLong.kind).toBe("already-open");
      expect(viaLong.documentId).toBe(pad.documentId);
      expect(getOpenDocs().size).toBe(1);
    });

    it("save-as over an existing file named by its short alias is stored under the long name (R1.6)", async (ctx) => {
      const fileAlias = shortLeafOf(longPath);
      if (fileAlias === null) return ctx.skip();
      const pad = await openScratchpad("overwrites the file\n");
      const saved = await saveDocumentAsToDisk(pad.documentId, fileAlias, "md");
      expect(saved.status).toBe("saved");
      expect(getOpenDocs().get(pad.documentId)?.filePath).toBe(longPath);
      const viaLong = await openFromDisk(longPath);
      expect(viaLong.kind).toBe("already-open");
      expect(getOpenDocs().size).toBe(1);
    });

    it("after a rename, opening the renamed file by its new short alias is one document (R1.6)", async (ctx) => {
      const opened = await openFromDisk(longPath);
      const renamed = await renameDocument(opened.documentId, "renamed to another long name.md");
      expect(renamed.status).toBe("renamed");
      const newPath = path.join(longDir, "renamed to another long name.md");
      const alias = shortLeafOf(newPath);
      if (alias === null) return ctx.skip();
      const again = await openFromDisk(alias);
      expect(again.kind).toBe("already-open");
      expect(again.documentId).toBe(opened.documentId);
      expect(getOpenDocs().size).toBe(1);
    });

    it("records saved under the short spelling are moved to the long spelling's key when it is opened that way again", async (ctx) => {
      const all = spellings();
      if (all === null) return ctx.skip();
      const [, short] = all[0];
      // What an earlier version stored: keys and `filePath` from the JS realpath.
      const oldKeyPath = fsSync.realpathSync(short);
      const session = await docFromMarkdown("alpha beta gamma\n\nunsaved line\n");
      await saveSession(oldKeyPath, "md", session, { dirty: true });
      await writeEnvelopeToDisk(
        makeAnnotationDoc(docHash(oldKeyPath), oldKeyPath, {
          annotations: [annRecord({ id: "ann_old", author: "user", rev: 1 })],
          tombstones: [{ id: "ann_deleted", rev: 2, deletedAt: Date.now() }],
        }),
      );

      const opened = await openFromDisk(short);
      expect(opened.kind).toBe("restored");
      expect(opened.filePath).toBe(longPath);
      expect(extractText(getOrCreateDocument(opened.documentId))).toContain("unsaved line");
      expect(annotationIds(opened.documentId)).toEqual(["ann_old"]);
      expect(await exists(sessionFile(oldKeyPath))).toBe(false);
      expect(await exists(envelopePath(docHash(oldKeyPath)))).toBe(false);
      expect(await exists(sessionFile(longPath))).toBe(true);
      expect(await exists(envelopePath(docHash(longPath)))).toBe(true);
      // A move, not a copy or a conversion: the session now names the long
      // path, and nothing was written to a backups folder for either key.
      const moved = JSON.parse(await fs.readFile(sessionFile(longPath), "utf-8"));
      expect(moved.filePath).toBe(longPath);
      expect(moved.dirty).toBe(true);
      const backups = docBackupsRoot(resolveAppDataDir());
      expect(await exists(path.join(backups, docHash(longPath)))).toBe(false);
      expect(await exists(path.join(backups, docHash(oldKeyPath)))).toBe(false);
    });

    it("a session already under the long spelling's key is the document; the short-spelled one is left as it is and its comments file still moves", async (ctx) => {
      const all = spellings();
      if (all === null) return ctx.skip();
      const [, short] = all[0];
      const oldKeyPath = fsSync.realpathSync(short);
      await saveSession(oldKeyPath, "md", await docFromMarkdown("from the short spelling\n"), {
        dirty: true,
      });
      await writeEnvelopeToDisk(
        makeAnnotationDoc(docHash(oldKeyPath), oldKeyPath, {
          annotations: [annRecord({ id: "ann_old", author: "user", rev: 1 })],
        }),
      );
      await saveSession(longPath, "md", await docFromMarkdown("from the long spelling\n"), {
        dirty: true,
      });
      const before = await fs.readFile(sessionFile(oldKeyPath));

      const opened = await openFromDisk(short);
      expect(opened.kind).toBe("restored");
      const text = extractText(getOrCreateDocument(opened.documentId));
      expect(text).toContain("from the long spelling");
      expect(text).not.toContain("from the short spelling");
      // Nothing merged, converted or backed up: the old session is untouched.
      expect((await fs.readFile(sessionFile(oldKeyPath))).equals(before)).toBe(true);
      // The other kind had an empty place and moved.
      expect(annotationIds(opened.documentId)).toEqual(["ann_old"]);
      expect(await exists(envelopePath(docHash(oldKeyPath)))).toBe(false);
      expect(await exists(envelopePath(docHash(longPath)))).toBe(true);
    });

    it("a long-spelled open leaves records under the short spelling untouched", async (ctx) => {
      const all = spellings();
      if (all === null) return ctx.skip();
      const oldKeyPath = fsSync.realpathSync(all[0][1]);
      await saveSession(oldKeyPath, "md", await docFromMarkdown("old\n"), { dirty: true });
      const before = await fs.readFile(sessionFile(oldKeyPath));
      const opened = await openFromDisk(longPath);
      expect(opened.kind).toBe("fresh");
      expect((await fs.readFile(sessionFile(oldKeyPath))).equals(before)).toBe(true);
    });
  },
);
